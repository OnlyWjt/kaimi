import { getAppConfig, getSetting, setSetting } from "@/lib/config";
import { syncCdksFromUpstream, syncPlansFromUpstream } from "@/lib/inventory";
import { pollInFlightOrders, reconcileStuckLocks } from "@/lib/orders";

const DEFAULT_MINUTES = 15;
let started = false;
let running = false;
let lastRunMs = 0;

export async function getSyncIntervalMinutes() {
  const raw = await getSetting("sync_interval_minutes", String(DEFAULT_MINUTES));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MINUTES;
  return Math.floor(n);
}

export async function runScheduledSync(reason = "timer") {
  if (running) return { skipped: true as const, reason: "busy" };
  running = true;
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

    lastRunMs = Date.now();
    const at = new Date(lastRunMs).toISOString();
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
    running = false;
  }
}

async function maybeTick() {
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

  const minutes = await getSyncIntervalMinutes();
  if (minutes <= 0) return;
  const due = Date.now() - lastRunMs >= minutes * 60_000;
  if (!due && lastRunMs > 0) return;
  await runScheduledSync(lastRunMs === 0 ? "boot" : "timer");
}

/** Start background sync loop once per process. Setting sync_interval_minutes=0 disables. */
export function ensureSyncScheduler() {
  if (started) return;
  started = true;

  void (async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    await maybeTick();
    const handle = setInterval(() => {
      void maybeTick();
    }, 60_000);
    try {
      handle.unref?.();
    } catch {
      /* ignore */
    }
  })();
}
