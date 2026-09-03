import { count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, platformPlans } from "@/db/schema";
import { getDefaultCardplatformClient } from "@/lib/cardplatform/config";
import { getSetting, setSetting } from "@/lib/config";
import { notifyOpsAlert } from "@/lib/notify";
import { epayReady, getEpayConfig } from "@/lib/payments/config";

const HEALTH_KEY = "ops_health_json";
const MANUAL_KEY = "store_sales_manual_closed";
const MIN_SPENDABLE_KEY = "cardplatform_min_spendable_cents";
const DEFAULT_MIN_SPENDABLE_CENTS = 500;

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
    currency: string;
    message: string;
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

export async function refreshOpsHealth() {
  const previous = await getOpsHealth();
  const minSpendableCents = Math.max(
    0,
    Number(await getSetting(MIN_SPENDABLE_KEY, String(DEFAULT_MIN_SPENDABLE_CENTS))) ||
      DEFAULT_MIN_SPENDABLE_CENTS,
  );
  const alerts: OpsAlert[] = [];
  const now = new Date().toISOString();

  let cardplatform = {
    ok: false,
    spendableCents: null as number | null,
    minSpendableCents,
    currency: "USD",
    message: "卡台未配置",
  };
  try {
    const { client } = await getDefaultCardplatformClient();
    const balance = await client.getBalance();
    const spendable = balance.spendableCents;
    if (spendable === null) {
      cardplatform = {
        ok: false,
        spendableCents: null,
        minSpendableCents,
        currency: balance.currency,
        message: "卡台未返回可用余额",
      };
    } else if (spendable < minSpendableCents) {
      cardplatform = {
        ok: false,
        spendableCents: spendable,
        minSpendableCents,
        currency: balance.currency,
        message: `卡台可用余额 ${(spendable / 100).toFixed(2)} ${balance.currency}，低于最低 ${(minSpendableCents / 100).toFixed(2)}`,
      };
    } else {
      cardplatform = {
        ok: true,
        spendableCents: spendable,
        minSpendableCents,
        currency: balance.currency,
        message: `卡台可用余额 ${(spendable / 100).toFixed(2)} ${balance.currency}`,
      };
    }
  } catch (error) {
    cardplatform = {
      ok: false,
      spendableCents: null,
      minSpendableCents,
      currency: "USD",
      message: error instanceof Error ? error.message : "卡台不可用",
    };
  }

  const sellable = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.cardplatformSellable, true),
  });
  if (!sellable) {
    cardplatform = {
      ...cardplatform,
      ok: false,
      message: cardplatform.ok ? "没有可售卡台套餐" : cardplatform.message,
    };
  }

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

  if (!cardplatform.ok) {
    alerts.push({
      level: "critical",
      code: "cardplatform.unavailable",
      message: cardplatform.message,
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
      code: "jobs.failed",
      message: `有 ${jobs.failed} 个后台任务失败，请到商务后台重试`,
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
  const autoClosed = !cardplatform.ok;
  const salesOpen = !manual && !autoClosed;
  const reason = manual
    ? "管理员已手动关闭店铺购买"
    : autoClosed
      ? cardplatform.message
      : "";

  const health: OpsHealth = {
    checkedAt: now,
    salesOpen,
    reason,
    cardplatform,
    payment,
    jobs,
    alerts: mergedAlerts,
  };
  await setSetting(HEALTH_KEY, JSON.stringify(health));

  const becameClosed = previous?.salesOpen !== false && !salesOpen;
  if (becameClosed && reason) await notifyOpsAlert(reason);
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
      currency: "USD",
      message: "",
    },
    payment: { ok: true, message: "" },
    jobs: { failed: 0, retrying: 0 },
    alerts: [],
  };
}
