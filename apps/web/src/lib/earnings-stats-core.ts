import { parseDbDate } from "./datetime";

export type StatsGrain = "day" | "week" | "month";

export type StatsEarningRow = {
  agentId: number;
  agentName: string;
  confirmedAt: string;
  grossCents: number;
  costCents: number;
  paymentFeeCents: number;
  totalFeeCents?: number | null;
  upstreamCents?: number | null;
  platformFeeCents?: number | null;
  platformProfitCents?: number | null;
  invoiceSurchargeCents?: number | null;
  /** 收益行上的开票分成（代理到手）。平台开票收入 = 加价 − 这个数。 */
  invoiceShareCents?: number | null;
  payStatus?: string;
  upstreamCostSource?: string;
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

export type Money = {
  orderCount: number;
  grossCents: number;
  platformCents: number;
  agentCents: number;
  feeCents: number;
  upstreamCents: number;
  platformFeeCents: number;
  profitCents: number;
  profitUnknownCount: number;
  invoiceCents: number;
  backfillCount: number;
  backfillProfitCents: number;
  refundedOrderCount: number;
  basisCostCents: number;
  basisInvoiceCents: number;
  basisUpstreamCents: number;
  basisPlatformFeeCents: number;
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
    upstreamCents: 0,
    platformFeeCents: 0,
    profitCents: 0,
    profitUnknownCount: 0,
    invoiceCents: 0,
    backfillCount: 0,
    backfillProfitCents: 0,
    refundedOrderCount: 0,
    basisCostCents: 0,
    basisInvoiceCents: 0,
    basisUpstreamCents: 0,
    basisPlatformFeeCents: 0,
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

/** 平台从开票加价里留下的钱：老规则是全部加价；自定义税点是 6% 加上从代理那份扣的税。 */
function platformInvoiceCents(row: StatsEarningRow) {
  return (row.invoiceSurchargeCents ?? 0) - (row.invoiceShareCents ?? 0);
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
  target.feeCents += row.totalFeeCents ?? row.paymentFeeCents;
  target.upstreamCents += row.upstreamCents ?? 0;
  target.platformFeeCents += row.platformFeeCents ?? 0;
  target.invoiceCents += platformInvoiceCents(row);
  if (row.status === "pending" || row.status === "settling") {
    target.pendingCents += row.earningCents;
  }
  if (row.status === "settled") target.settledCents += row.earningCents;
  const refunded = row.payStatus === "refunded" || row.payStatus === "chargeback";
  if (refunded) {
    target.refundedOrderCount += 1;
    return;
  }
  if (row.upstreamCostSource === "backfill") {
    target.backfillCount += 1;
    target.backfillProfitCents += row.platformProfitCents ?? 0;
    return;
  }
  if (row.platformProfitCents == null) {
    target.profitUnknownCount += 1;
    return;
  }
  target.profitCents += row.platformProfitCents;
  target.basisCostCents += row.costCents;
  target.basisInvoiceCents += platformInvoiceCents(row);
  target.basisUpstreamCents += row.upstreamCents ?? 0;
  target.basisPlatformFeeCents += row.platformFeeCents ?? 0;
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

/* —— 代理自助提卡：先出卡后结账，平台毛利 = 提卡价 − 出卡时记下的上游成本 —— */

export type StatsDrawRow = {
  agentId: number;
  agentName: string;
  /** 出卡时间。毛利按出卡那天算，没结算的也算。 */
  createdAt: string;
  /** 代理该付的提卡价 */
  amountCents: number;
  /** 出卡时记下的上游成本；没配进价时为 null，这张不进毛利。 */
  upstreamCostCents: number | null;
  /** unsettled / settled / void */
  status: string;
};

export type DrawMoney = {
  itemCount: number;
  amountCents: number;
  upstreamCents: number;
  profitCents: number;
  profitUnknownCount: number;
  unsettledCents: number;
  settledCents: number;
  voidCount: number;
};

function emptyDrawMoney(): DrawMoney {
  return {
    itemCount: 0,
    amountCents: 0,
    upstreamCents: 0,
    profitCents: 0,
    profitUnknownCount: 0,
    unsettledCents: 0,
    settledCents: 0,
    voidCount: 0,
  };
}

function addDraw(target: DrawMoney, row: StatsDrawRow) {
  // 作废的卡代理不用付，也不算平台的
  if (row.status === "void") {
    target.voidCount += 1;
    return;
  }
  target.itemCount += 1;
  target.amountCents += row.amountCents;
  if (row.status === "settled") target.settledCents += row.amountCents;
  else target.unsettledCents += row.amountCents;
  if (row.upstreamCostCents == null) {
    target.profitUnknownCount += 1;
    return;
  }
  target.upstreamCents += row.upstreamCostCents;
  target.profitCents += row.amountCents - row.upstreamCostCents;
}

export function buildDrawStats(input: { grain: StatsGrain; draws: StatsDrawRow[] }) {
  const totals = emptyDrawMoney();
  const byAgent = new Map<number, DrawMoney & { agentId: number; agentName: string }>();
  const series = new Map<string, DrawMoney & { bucket: string }>();
  for (const row of input.draws) {
    addDraw(totals, row);
    let agent = byAgent.get(row.agentId);
    if (!agent) {
      agent = { agentId: row.agentId, agentName: row.agentName, ...emptyDrawMoney() };
      byAgent.set(row.agentId, agent);
    }
    addDraw(agent, row);
    const bucket = statsBucketKey(row.createdAt, input.grain);
    if (!bucket) continue;
    let point = series.get(bucket);
    if (!point) {
      point = { bucket, ...emptyDrawMoney() };
      series.set(bucket, point);
    }
    addDraw(point, row);
  }
  return {
    totals,
    byAgent: Array.from(byAgent.values()).sort((left, right) => right.profitCents - left.profitCents),
    series: Array.from(series.values()).sort((left, right) => left.bucket.localeCompare(right.bucket)),
  };
}

function shiftYmd(ymd: string, days: number) {
  const [year, month, day] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 一段北京日期里所有的桶（天 / 周一 / 月），从早到晚。太长（超过 400 个）返回空，只列有数据的桶。 */
export function statsBuckets(startYmd: string, endYmd: string, grain: StatsGrain) {
  if (!DATE_ONLY.test(startYmd) || !DATE_ONLY.test(endYmd) || startYmd > endYmd) return [];
  const keys: string[] = [];
  if (grain === "month") {
    let [year, month] = startYmd.split("-").map(Number);
    const last = endYmd.slice(0, 7);
    for (let key = `${year}-${pad(month)}`; key <= last; key = `${year}-${pad(month)}`) {
      keys.push(key);
      if (keys.length > 400) return [];
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return keys;
  }
  const step = grain === "week" ? 7 : 1;
  for (let key = grain === "week" ? mondayOf(startYmd) : startYmd; key <= endYmd; key = shiftYmd(key, step)) {
    keys.push(key);
    if (keys.length > 400) return [];
  }
  return keys;
}

export type EarningsPeriodRow = {
  bucket: string;
  label: string;
  storeOrderCount: number;
  storeProfitCents: number;
  storeProfitUnknownCount: number;
  drawItemCount: number;
  drawProfitCents: number;
  drawProfitUnknownCount: number;
  /** 平台实际收益 = 店铺毛利 + 提卡毛利 */
  totalProfitCents: number;
};

/**
 * 每天（周 / 月）一行的收益明细：店铺毛利和提卡毛利并排。
 * 选定范围里没有单的日子也列出来记 0，一眼看出哪天没进账；最新的在前。
 */
export function buildPeriodRows(input: {
  grain: StatsGrain;
  startYmd: string;
  endYmd: string;
  store: Array<Money & { bucket: string }>;
  draw: Array<DrawMoney & { bucket: string }>;
}): EarningsPeriodRow[] {
  const store = new Map(input.store.map((row) => [row.bucket, row]));
  const draw = new Map(input.draw.map((row) => [row.bucket, row]));
  const keys = new Set(statsBuckets(input.startYmd, input.endYmd, input.grain));
  for (const key of store.keys()) keys.add(key);
  for (const key of draw.keys()) keys.add(key);
  return Array.from(keys)
    .sort((left, right) => right.localeCompare(left))
    .map((bucket) => {
      const s = store.get(bucket);
      const d = draw.get(bucket);
      const storeProfitCents = s?.profitCents ?? 0;
      const drawProfitCents = d?.profitCents ?? 0;
      return {
        bucket,
        label: statsBucketLabel(bucket, input.grain),
        storeOrderCount: s?.orderCount ?? 0,
        storeProfitCents,
        storeProfitUnknownCount: s?.profitUnknownCount ?? 0,
        drawItemCount: d?.itemCount ?? 0,
        drawProfitCents,
        drawProfitUnknownCount: d?.profitUnknownCount ?? 0,
        totalProfitCents: storeProfitCents + drawProfitCents,
      };
    });
}
