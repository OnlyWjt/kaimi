import { getSetting, setSetting } from "@/lib/config";
import { pollInFlightOrders, reconcileStuckLocks } from "@/lib/orders";
import { retryPendingStoreOrders } from "@/lib/fulfillment/fulfill-store-order";
import { reconcilePendingPaymentFees } from "@/lib/payments/reconcile";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { sanitizeLog } from "@/lib/log";
import { refreshOpsHealth } from "@/lib/ops-health";
import { syncEnabledAccountProducts } from "@/lib/cardplatform/products";
import { reconcileIssuedCdkStatuses } from "@/lib/cardplatform/reconcile-issued";

const DEFAULT_MINUTES = 15;
const TICK_INTERVAL_MS = 30_000;

type SchedulerState = {
  started: boolean;
  tickRunning: boolean;
  lastInflightMs: number;
  lastProductSyncMs: number;
  lastIssuedReconcileMs?: number;
};

const ISSUED_RECONCILE_INTERVAL_MS = 120_000;

const schedulerGlobal = globalThis as typeof globalThis & {
  __kaimiSyncSchedulerState?: SchedulerState;
};
const state =
  schedulerGlobal.__kaimiSyncSchedulerState ??
  (schedulerGlobal.__kaimiSyncSchedulerState = {
    started: false,
    tickRunning: false,
    lastInflightMs: 0,
    lastProductSyncMs: 0,
  });

export async function getSyncIntervalMinutes() {
  const raw = await getSetting("sync_interval_minutes", String(DEFAULT_MINUTES));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MINUTES;
  return Math.floor(n);
}

export async function runScheduledSync(reason = "timer") {
  const at = new Date().toISOString();
  await setSetting("sync_last_at", at);
  await setSetting(
    "sync_last_result",
    JSON.stringify({ at, reason, note: "cardplatform_only" }),
  );
  return { ok: true as const, at };
}

async function maybeTick() {
  if (state.tickRunning) return;
  state.tickRunning = true;
  try {
    const now = Date.now();
    if (now - state.lastInflightMs >= 60_000 || state.lastInflightMs === 0) {
      state.lastInflightMs = now;
      try {
        const jobs = await processBackgroundJobs();
        if (jobs.completed > 0 || jobs.failed > 0) {
          console.log(
            `[kaimi-sync] background jobs: completed=${jobs.completed} failed=${jobs.failed}`,
          );
        }
      } catch (err) {
        console.warn("[kaimi-sync] background jobs failed", sanitizeLog(err));
      }
      try {
        await refreshOpsHealth();
      } catch (err) {
        console.warn("[kaimi-sync] ops health failed", sanitizeLog(err));
      }
      try {
        const poll = await pollInFlightOrders();
        if (poll.checked > 0) {
          console.log(`[kaimi-sync] inflight poll: checked=${poll.checked} errors=${poll.errors}`);
        }
      } catch (err) {
        console.warn("[kaimi-sync] inflight poll failed", err);
      }
      try {
        await reconcileStuckLocks();
      } catch (err) {
        console.warn("[kaimi-sync] reconcile locks failed", err);
      }
      try {
        const fulfillment = await retryPendingStoreOrders();
        if (fulfillment.checked > 0) {
          console.log(
            `[kaimi-sync] store fulfillment: checked=${fulfillment.checked} delivered=${fulfillment.delivered}`,
          );
        }
      } catch (err) {
        console.warn("[kaimi-sync] store fulfillment failed", err);
      }
      try {
        const fees = await reconcilePendingPaymentFees();
        if (fees.checked > 0) {
          console.log(
            `[kaimi-sync] payment fees: checked=${fees.checked} reconciled=${fees.reconciled}`,
          );
        }
      } catch (err) {
        console.warn("[kaimi-sync] payment fee reconcile failed", err);
      }
      const lastReconcile = state.lastIssuedReconcileMs ?? 0;
      if (now - lastReconcile >= ISSUED_RECONCILE_INTERVAL_MS || lastReconcile === 0) {
        state.lastIssuedReconcileMs = now;
        try {
          const results = await reconcileIssuedCdkStatuses();
          const updated = results.reduce((sum, item) => sum + item.updated, 0);
          const failed = results.filter((item) => item.error).length;
          if (updated > 0 || failed > 0) {
            console.log(
              `[kaimi-sync] issued cdk reconcile: updated=${updated} failed=${failed}`,
            );
          }
        } catch (err) {
          console.warn("[kaimi-sync] issued cdk reconcile failed", sanitizeLog(err));
        }
      }
      if (now - state.lastProductSyncMs >= 180_000 || state.lastProductSyncMs === 0) {
        state.lastProductSyncMs = now;
        try {
          const synced = await syncEnabledAccountProducts();
          const ok = synced.filter((item) => !("error" in item)).length;
          console.log(
            `[kaimi-sync] card products: accounts=${synced.length} ok=${ok}`,
          );
        } catch (err) {
          console.warn("[kaimi-sync] card product sync failed", sanitizeLog(err));
        }
      }
    }
  } finally {
    state.tickRunning = false;
  }
}

export function ensureSyncScheduler() {
  if (state.started) return;
  state.started = true;

  void (async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    await maybeTick();
    const handle = setInterval(() => {
      void maybeTick();
    }, TICK_INTERVAL_MS);
    try {
      handle.unref?.();
    } catch {
      /* ignore */
    }
  })();
}
