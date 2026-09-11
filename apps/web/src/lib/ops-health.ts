import { count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, platformPlans } from "@/db/schema";
import { getDefaultCardplatformClient } from "@/lib/cardplatform/config";
import { getSetting, setSetting } from "@/lib/config";
import { notifyOpsAlert } from "@/lib/notify";
import {
  DEFAULT_MIN_SPENDABLE_CENTS,
  DEFAULT_WARN_SPENDABLE_CENTS,
  JOBS_FAILED,
  cardplatformRecoveredNotify,
  classifyCardplatformHealth,
  jobsFailedNotify,
  opsHealthNotifications,
} from "@/lib/ops-health-core";
import { epayReady, getEpayConfig } from "@/lib/payments/config";

const HEALTH_KEY = "ops_health_json";
const MANUAL_KEY = "store_sales_manual_closed";
const MIN_SPENDABLE_KEY = "cardplatform_min_spendable_cents";
const WARN_SPENDABLE_KEY = "cardplatform_warn_spendable_cents";

export type OpsAlert = {
  level: "warning" | "critical";
  code: string;
  message: string;
  at: string;
};

export type OpsHealth = {
  checkedAt: string;
  salesOpen: boolean;
  reason: string;
  cardplatform: {
    ok: boolean;
    spendableCents: number | null;
    minSpendableCents: number;
    warnSpendableCents: number;
    currency: string;
    message: string;
    issueCode: string | null;
  };
  payment: { ok: boolean; message: string };
  jobs: { failed: number; retrying: number };
  alerts: OpsAlert[];
};

export async function getOpsHealth(): Promise<OpsHealth | null> {
  const raw = await getSetting(HEALTH_KEY, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OpsHealth;
  } catch {
    return null;
  }
}

/**
 * 给后台读接口用：直接吃缓存。
 *
 * 后台调度器每 30 秒会调一次 refreshOpsHealth()，缓存一直是新的；读接口再去打一次卡台
 * 余额接口，只会让管理员每次进页面都干等一个上游往返。要立刻刷新有 POST refresh。
 */
export async function getOpsHealthCached(): Promise<OpsHealth> {
  const current = await getOpsHealth();
  if (current) return current;
  // 没有缓存（刚启动、调度器还没跑过）才现取一次。
  return refreshOpsHealth();
}

/** 关店的真实原因（余额、网关）是运营的事，买家只会看到这句。 */
const CLOSED_PUBLIC_REASON = "店铺暂时停止售卖，请稍后再来或联系店主。";

export async function getStoreSalesGate() {
  const [manual, health] = await Promise.all([
    getSetting(MANUAL_KEY, "0"),
    getOpsHealth(),
  ]);
  if (manual === "1") {
    return {
      open: false,
      reason: "管理员已手动关闭店铺购买",
      publicReason: CLOSED_PUBLIC_REASON,
    };
  }
  if (health && !health.salesOpen) {
    return {
      open: false,
      reason: health.reason || "店铺暂时停止售卖",
      publicReason: CLOSED_PUBLIC_REASON,
    };
  }
  return { open: true, reason: "", publicReason: "" };
}

export async function assertStoreSalesOpen() {
  const current = await getOpsHealth();
  const stale =
    !current || Date.now() - new Date(current.checkedAt).getTime() > 3 * 60_000;
  if (stale) await refreshOpsHealth();
  const gate = await getStoreSalesGate();
  if (!gate.open) {
    console.warn(`[store-order] 店铺已停售：${gate.reason}`);
    throw new Error(gate.publicReason);
  }
}

export async function setManualSalesClosed(closed: boolean) {
  await setSetting(MANUAL_KEY, closed ? "1" : "0");
  return refreshOpsHealth();
}

export async function recordOpsAlert(alert: Omit<OpsAlert, "at">) {
  const current = (await getOpsHealth()) ?? emptyHealth();
  const next: OpsAlert = { ...alert, at: new Date().toISOString() };
  current.alerts = [next, ...current.alerts.filter((row) => row.code !== alert.code)].slice(
    0,
    30,
  );
  await setSetting(HEALTH_KEY, JSON.stringify(current));
  await notifyOpsAlert(next.message);
}

function readCentsSetting(raw: string, fallback: number) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function previousCardplatformCode(previous: OpsHealth | null) {
  if (!previous) return null;
  if (previous.cardplatform?.issueCode) return previous.cardplatform.issueCode;
  return (
    previous.alerts.find((row) => row.code.startsWith("cardplatform."))?.code ?? null
  );
}

export async function refreshOpsHealth() {
  const previous = await getOpsHealth();
  const minSpendableCents = readCentsSetting(
    await getSetting(MIN_SPENDABLE_KEY, String(DEFAULT_MIN_SPENDABLE_CENTS)),
    DEFAULT_MIN_SPENDABLE_CENTS,
  );
  const warnSpendableCents = Math.max(
    minSpendableCents,
    readCentsSetting(
      await getSetting(WARN_SPENDABLE_KEY, String(DEFAULT_WARN_SPENDABLE_CENTS)),
      DEFAULT_WARN_SPENDABLE_CENTS,
    ),
  );
  const now = new Date().toISOString();

  let spendableCents: number | null = null;
  let currency = "USD";
  let error: string | undefined;
  try {
    const { client } = await getDefaultCardplatformClient();
    const balance = await client.getBalance();
    spendableCents = balance.spendableCents;
    currency = balance.currency;
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "卡台不可用";
  }

  const sellable = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.cardplatformSellable, true),
  });
  const verdict = classifyCardplatformHealth({
    spendableCents,
    minCents: minSpendableCents,
    warnCents: warnSpendableCents,
    currency,
    error,
    hasSellablePlan: Boolean(sellable),
  });

  const epay = await getEpayConfig();
  const payment = epayReady(epay)
    ? { ok: true, message: "易支付已配置" }
    : { ok: false, message: "易支付未配置" };

  const [failedRow] = await db
    .select({ n: count() })
    .from(backgroundJobs)
    .where(eq(backgroundJobs.status, "failed"));
  const [retryingRow] = await db
    .select({ n: count() })
    .from(backgroundJobs)
    .where(inArray(backgroundJobs.status, ["retrying", "running"]));
  const jobs = {
    failed: Number(failedRow?.n || 0),
    retrying: Number(retryingRow?.n || 0),
  };

  const alerts: OpsAlert[] = [];
  if (verdict.issue) {
    alerts.push({
      level: verdict.issue.level,
      code: verdict.issue.code,
      message: verdict.issue.notify.what,
      at: now,
    });
  }
  if (!payment.ok) {
    alerts.push({
      level: "critical",
      code: "payment.unconfigured",
      message: payment.message,
      at: now,
    });
  }
  if (jobs.failed > 0) {
    alerts.push({
      level: "warning",
      code: JOBS_FAILED,
      message: jobsFailedNotify(jobs.failed).what,
      at: now,
    });
  }

  const previousAlerts = previous?.alerts || [];
  const mergedAlerts = [
    ...alerts,
    ...previousAlerts.filter(
      (row) =>
        !alerts.some((alert) => alert.code === row.code) &&
        ["payment.notify.amount_mismatch", "payment.notify.trade_mismatch"].includes(
          row.code,
        ),
    ),
  ].slice(0, 30);

  const manual = (await getSetting(MANUAL_KEY, "0")) === "1";
  const autoClosed = verdict.closeSales;
  const salesOpen = !manual && !autoClosed;
  const reason = manual
    ? "管理员已手动关闭店铺购买"
    : autoClosed
      ? verdict.message
      : "";

  const health: OpsHealth = {
    checkedAt: now,
    salesOpen,
    reason,
    cardplatform: {
      ok: verdict.ok,
      spendableCents: verdict.spendableCents,
      minSpendableCents,
      warnSpendableCents,
      currency: verdict.currency,
      message: verdict.message,
      issueCode: verdict.issue?.code ?? null,
    },
    payment,
    jobs,
    alerts: mergedAlerts,
  };
  await setSetting(HEALTH_KEY, JSON.stringify(health));

  const outgoing = opsHealthNotifications(
    previous
      ? {
          salesOpen: previous.salesOpen,
          cardplatformCode: previousCardplatformCode(previous),
          jobsFailed: previous.jobs.failed,
        }
      : null,
    {
      salesOpen,
      cardplatformCode: verdict.issue?.code ?? null,
      jobsFailed: jobs.failed,
    },
    verdict.issue,
    verdict.issue
      ? null
      : cardplatformRecoveredNotify({
          spendableCents: verdict.spendableCents,
          currency: verdict.currency,
          shopWasClosed: previous?.salesOpen === false,
        }),
    jobs.failed > 0 ? jobsFailedNotify(jobs.failed) : null,
  );
  for (const body of outgoing) {
    await notifyOpsAlert(body);
  }
  return health;
}

function emptyHealth(): OpsHealth {
  return {
    checkedAt: new Date().toISOString(),
    salesOpen: true,
    reason: "",
    cardplatform: {
      ok: true,
      spendableCents: null,
      minSpendableCents: DEFAULT_MIN_SPENDABLE_CENTS,
      warnSpendableCents: DEFAULT_WARN_SPENDABLE_CENTS,
      currency: "USD",
      message: "",
      issueCode: null,
    },
    payment: { ok: true, message: "" },
    jobs: { failed: 0, retrying: 0 },
    alerts: [],
  };
}
