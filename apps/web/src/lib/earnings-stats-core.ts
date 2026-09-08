import { parseDbDate } from "./datetime";

export type StatsGrain = "day" | "week" | "month";

export type StatsEarningRow = {
  agentId: number;
  agentName: string;
  confirmedAt: string;
  grossCents: number;
  costCents: number;
  paymentFeeCents: number;
  earningCents: number;
  status: string;
  paymentChannel?: string;
  planName?: string;
  feeReconcileStatus?: string;
};

export type StatsAdjustmentRow = {
  agentId: number;
  agentName: string;
  createdAt: string;
  amountCents: number;
  status: string;
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function beijingYmd(iso: string) {
  const date = parseDbDate(iso);
  if (!date) return null;
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`;
}

function mondayOf(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const weekday = new Date(utc).getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  const monday = new Date(utc - back * 86_400_000);
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

/** 统计按北京日历切天/周/月，跟后台「今天」对齐，不跟 UTC 日切。 */
export function statsBucketKey(iso: string, grain: StatsGrain) {
  const ymd = beijingYmd(iso);
  if (!ymd) return null;
  if (grain === "day") return ymd;
  if (grain === "month") return ymd.slice(0, 7);
  return mondayOf(ymd);
}

export function statsBucketLabel(key: string, grain: StatsGrain) {
  if (grain === "month") {
    const [year, month] = key.split("-");
    return `${year}年${Number(month)}月`;
  }
  if (grain === "week") return `${key} 当周`;
  return key;
}

/**
 * 把页面上选的北京日期（含首尾）换成 UTC ISO，给 confirmed_at 做范围查询。
 */
export function beijingDateRangeIso(startYmd: string, endYmd: string) {
  if (!DATE_ONLY.test(startYmd) || !DATE_ONLY.test(endYmd)) {
    throw new Error("时间范围格式无效");
  }
  const start = new Date(`${startYmd}T00:00:00.000+08:00`);
  const end = new Date(`${endYmd}T23:59:59.999+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("时间范围格式无效");
  }
  if (start.getTime() > end.getTime()) {
    throw new Error("开始日期不能晚于结束日期");
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export function parseStatsGrain(value: string | null): StatsGrain {
  if (value === "week" || value === "month" || value === "day") return value;
  return "day";
}

type Money = {
  orderCount: number;
  grossCents: number;
  platformCents: number;
  agentCents: number;
  feeCents: number;
  pendingCents: number;
  settledCents: number;
  reversedCents: number;
  adjustmentCents: number;
};

export type StatsOrderRow = {
  payStatus: string;
  fulfillStatus: string;
  feeReconcileStatus: string;
  grossCents: number;
};

function emptyMoney(): Money {
  return {
    orderCount: 0,
    grossCents: 0,
    platformCents: 0,
    agentCents: 0,
    feeCents: 0,
    pendingCents: 0,
    settledCents: 0,
    reversedCents: 0,
    adjustmentCents: 0,
  };
}

const CHANNEL_LABEL: Record<string, string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
};

const FEE_LABEL: Record<string, string> = {
  confirmed: "渠道实收",
  unsupported: "按费率估算",
  pending: "核对中",
  retrying: "核对中",
  manual_review: "待人工核对",
};

function namedBucket(
  map: Map<string, Money & { key: string; label: string }>,
  key: string,
  label: string,
) {
  const current = map.get(key);
  if (current) return current;
  const next = { key, label, ...emptyMoney() };
  map.set(key, next);
  return next;
}

function addEarning(target: Money, row: StatsEarningRow) {
  if (row.status === "reversed") {
    target.reversedCents += row.earningCents;
    return;
  }
  target.orderCount += 1;
  target.grossCents += row.grossCents;
  target.platformCents += row.costCents;
  target.agentCents += row.earningCents;
  target.feeCents += row.paymentFeeCents;
  if (row.status === "pending" || row.status === "settling") {
    target.pendingCents += row.earningCents;
  }
  if (row.status === "settled") target.settledCents += row.earningCents;
}

function addAdjustment(target: Money, row: StatsAdjustmentRow) {
  target.agentCents += row.amountCents;
  target.adjustmentCents += row.amountCents;
  if (row.status === "pending" || row.status === "settling") {
    target.pendingCents += row.amountCents;
  }
  if (row.status === "settled") target.settledCents += row.amountCents;
}

export function buildOrderPipeline(orders: StatsOrderRow[]) {
  const pipeline = {
    placedCount: orders.length,
    placedCents: 0,
    paidCount: 0,
    paidCents: 0,
    unpaidCount: 0,
    unpaidCents: 0,
    deliveredCount: 0,
    stuckCount: 0,
    stuckCents: 0,
    refundedCount: 0,
    refundedCents: 0,
    feeReviewCount: 0,
    feePendingCount: 0,
  };
  for (const row of orders) {
    pipeline.placedCents += row.grossCents;
    if (row.payStatus === "refunded" || row.payStatus === "chargeback") {
      pipeline.refundedCount += 1;
      pipeline.refundedCents += row.grossCents;
      continue;
    }
    if (row.payStatus === "paid") {
      pipeline.paidCount += 1;
      pipeline.paidCents += row.grossCents;
      if (row.fulfillStatus === "delivered") pipeline.deliveredCount += 1;
      else {
        pipeline.stuckCount += 1;
        pipeline.stuckCents += row.grossCents;
      }
      if (row.feeReconcileStatus === "manual_review") pipeline.feeReviewCount += 1;
      if (row.feeReconcileStatus === "pending" || row.feeReconcileStatus === "retrying") {
        pipeline.feePendingCount += 1;
      }
    } else {
      pipeline.unpaidCount += 1;
      pipeline.unpaidCents += row.grossCents;
    }
  }
  return pipeline;
}

export function buildEarningsStats(input: {
  grain: StatsGrain;
  earnings: StatsEarningRow[];
  adjustments: StatsAdjustmentRow[];
}) {
  const totals = emptyMoney();
  const byAgent = new Map<number, Money & { agentId: number; agentName: string }>();
  const series = new Map<string, Money & { bucket: string }>();
  const byChannel = new Map<string, Money & { key: string; label: string }>();
  const byPlan = new Map<string, Money & { key: string; label: string }>();
  const byFee = new Map<string, Money & { key: string; label: string }>();

  function agentRow(id: number, name: string) {
    const current = byAgent.get(id);
    if (current) return current;
    const next = { agentId: id, agentName: name, ...emptyMoney() };
    byAgent.set(id, next);
    return next;
  }

  function seriesRow(iso: string) {
    const bucket = statsBucketKey(iso, input.grain);
    if (!bucket) return null;
    const current = series.get(bucket);
    if (current) return current;
    const next = { bucket, ...emptyMoney() };
    series.set(bucket, next);
    return next;
  }

  for (const row of input.earnings) {
    addEarning(totals, row);
    addEarning(agentRow(row.agentId, row.agentName), row);
    const bucket = seriesRow(row.confirmedAt);
    if (bucket) addEarning(bucket, row);
    const channel = row.paymentChannel || "other";
    addEarning(namedBucket(byChannel, channel, CHANNEL_LABEL[channel] || channel), row);
    const plan = row.planName || "未分类";
    addEarning(namedBucket(byPlan, plan, plan), row);
    const fee = row.feeReconcileStatus || "pending";
    addEarning(namedBucket(byFee, fee, FEE_LABEL[fee] || fee), row);
  }
  for (const row of input.adjustments) {
    addAdjustment(totals, row);
    addAdjustment(agentRow(row.agentId, row.agentName), row);
    const bucket = seriesRow(row.createdAt);
    if (bucket) addAdjustment(bucket, row);
  }

  return {
    totals,
    byAgent: Array.from(byAgent.values()).sort(
      (left, right) => right.platformCents + right.agentCents - (left.platformCents + left.agentCents),
    ),
    series: Array.from(series.values())
      .sort((left, right) => left.bucket.localeCompare(right.bucket))
      .map((row) => ({
        ...row,
        label: statsBucketLabel(row.bucket, input.grain),
      })),
    byChannel: Array.from(byChannel.values()).sort(
      (left, right) => right.grossCents - left.grossCents,
    ),
    byPlan: Array.from(byPlan.values()).sort(
      (left, right) => right.grossCents - left.grossCents,
    ),
    byFee: Array.from(byFee.values()).sort(
      (left, right) => right.orderCount - left.orderCount,
    ),
  };
}
