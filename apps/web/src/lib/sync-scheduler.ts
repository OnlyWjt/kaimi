import { getAppConfig, getSetting, setSetting } from "@/lib/config";
import { syncCdksFromUpstream, syncPlansFromUpstream } from "@/lib/inventory";
import { pollInFlightOrders, reconcileStuckLocks } from "@/lib/orders";
import { pollPurchasesAndImport } from "@/lib/purchase-sync";

const DEFAULT_MINUTES = 15;
const PURCHASE_INTERVAL_MS = 30_000;

type SchedulerState = {
  started: boolean;
  running: boolean;
  tickRunning: boolean;
  lastRunMs: number;
  lastPurchaseMs: number;
  lastInflightMs: number;
};

const schedulerGlobal = globalThis as typeof globalThis & {
  __kaimiSyncSchedulerState?: SchedulerState;
};
const state =
  schedulerGlobal.__kaimiSyncSchedulerState ??
  (schedulerGlobal.__kaimiSyncSchedulerState = {
    started: false,
    running: false,
    tickRunning: false,
    lastRunMs: 0,
    lastPurchaseMs: 0,
    lastInflightMs: 0,
  });

export async function getSyncIntervalMinutes() {
  const raw = await getSetting("sync_interval_minutes", String(DEFAULT_MINUTES));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MINUTES;
  return Math.floor(n);
}

export async function runScheduledSync(reason = "timer") {
  if (state.running) return { skipped: true as const, reason: "busy" };
  state.running = true;
  try {
    const cfg = await getAppConfig();
    if (!cfg.upstreamBaseUrl || !cfg.upstreamApiKey) {
      return { skipped: true as const, reason: "upstream_not_configured" };
    }

    const plans = await syncPlansFromUpstream().catch((err) => {
      console.error("[kaimi-sync] plans failed", reason, err);
      return { upserted: 0, total: 0, error: String(err) };
    });
    const stock = await syncCdksFromUpstream().catch((err) => {
      console.error("[kaimi-sync] stock failed", reason, err);
      return { imported: 0, error: String(err) };
    });

    state.lastRunMs = Date.now();
    const at = new Date(state.lastRunMs).toISOString();
    await setSetting("sync_last_at", at);
    await setSetting(
      "sync_last_result",
      JSON.stringify({
        at,
        reason,
        plans,
        stock,
      }),
    );

    console.log(
      `[kaimi-sync] ${reason}: plans=${(plans as { upserted?: number }).upserted ?? 0} stock_imported=${(stock as { imported?: number }).imported ?? 0} stock_disabled=${(stock as { disabled?: number }).disabled ?? 0}`,
    );
    return { ok: true as const, plans, stock, at };
  } finally {
    state.running = false;
  }
}

async function maybeTick() {
  if (state.tickRunning) return;
  state.tickRunning = true;
  try {
    const now = Date.now();
    if (now - state.lastInflightMs >= 60_000 || state.lastInflightMs === 0) {
      state.lastInflightMs = now;
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
    }

    if (
      now - state.lastPurchaseMs >= PURCHASE_INTERVAL_MS ||
      state.lastPurchaseMs === 0
    ) {
      state.lastPurchaseMs = now;
      try {
        const purchase = await pollPurchasesAndImport();
        if ("ok" in purchase && purchase.ok) {
          console.log(
            `[kaimi-sync] purchase import: +${purchase.imported} restored=${purchase.restored} orders=${purchase.orders}`,
          );
        }
      } catch (err) {
        console.warn("[kaimi-sync] purchase import failed", err);
      }
    }

    const minutes = await getSyncIntervalMinutes();
    if (minutes <= 0) return;
    const due = Date.now() - state.lastRunMs >= minutes * 60_000;
    if (!due && state.lastRunMs > 0) return;
    await runScheduledSync(state.lastRunMs === 0 ? "boot" : "timer");
  } finally {
    state.tickRunning = false;
  }
}

/** Start background sync loop once per process. Setting sync_interval_minutes=0 disables. */
export function ensureSyncScheduler() {
  if (state.started) return;
  state.started = true;

  void (async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    await maybeTick();
    const handle = setInterval(() => {
      void maybeTick();
    }, PURCHASE_INTERVAL_MS);
    try {
      handle.unref?.();
    } catch {
      /* ignore */
    }
  })();
}
