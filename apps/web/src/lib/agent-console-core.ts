import type { ThemeId } from "@kaimi/themes";
import type { UnreadAnnouncement } from "./announcements-core";
import { yuanTextFromCents } from "./money";

export type AgentConsoleProfile = {
  username: string;
  displayName: string;
  shopName: string;
  currentSlug: string;
  themeId: ThemeId;
  redeemUrl: string;
  unreadAnnouncement: UnreadAnnouncement | null;
};

export type AgentRangeKey = "today" | "7d" | "month" | "all";

export type AgentPlanRow = {
  planKey: string;
  name: string;
  costPriceCents: number;
  maxRetailPriceCents: number | null;
  retailPriceCents: number;
  enabled: boolean;
  cardplatformSellable: boolean;
  fulfillmentKind?: string;
  basePlanKey?: string;
  paymentCountry?: string;
  regionLabel?: string;
  regionCapable?: boolean;
};

export type AgentCouponWarning = { message: string; reason: string };

export type AgentCouponItem = {
  id: number;
  name: string;
  code: string;
  kind: "percent" | "threshold";
  percentZhe: number;
  thresholdCents: number;
  amountCents: number;
  maxUses: number;
  usedCount: number;
  enabled: boolean;
  planKeys: string[];
  warnings: AgentCouponWarning[];
};

export type AgentOverviewDeal = {
  id: number;
  orderNo: string;
  productName: string;
  quantity?: number;
  couponCode?: string;
  grossCents: number;
};

export type AgentOverviewSnapshot = {
  weekGrossCents: number;
  weekOrderCount: number;
  pendingCents: number;
  unusedBacklog: number;
  activeCouponCount: number;
  riskyCoupon: { name: string; message: string } | null;
  deals: AgentOverviewDeal[];
};

export function localYmd(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function agentRangeYmd(range: AgentRangeKey) {
  const now = new Date();
  const end = localYmd(now);
  if (range === "all") return { start: "2020-01-01", end };
  if (range === "today") return { start: end, end };
  if (range === "month") {
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    return { start, end };
  }
  return {
    start: localYmd(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)),
    end,
  };
}

/** 导出用的日期参数：按北京时间切日，和账本页统计用同一个范围；「全部」不传参数。 */
export function agentEarningsQuery(range: AgentRangeKey, now = new Date()) {
  if (range === "all") return "";
  const { start, end } = beijingRangeYmd(range, now);
  return `&start=${start}&end=${end}`;
}

export function moneyYuan(cents: number) {
  return `¥${yuanTextFromCents(cents)}`;
}

function groupedYuan(absCents: number) {
  const cents = Math.trunc(Math.abs(Number(absCents) || 0));
  const yuan = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `¥${yuan}.${String(cents % 100).padStart(2, "0")}`;
}

/** 绝对值金额，带千分位。非整数分按截断处理，和 yuanTextFromCents 一致。 */
export function moneyYuanAbs(cents: number) {
  return groupedYuan(cents);
}

/** 有符号金额：负数显示 −¥40.00（U+2212），正数和零不带符号，带千分位。 */
export function signedMoneyYuan(cents: number) {
  const value = Math.trunc(Number(cents) || 0);
  return value < 0 ? `−${groupedYuan(value)}` : groupedYuan(value);
}

/** 净额方向：正=平台转给代理，负=代理转给平台，零=抵平。 */
export function netDirectionLabel(netCents: number) {
  const value = Math.trunc(Number(netCents) || 0);
  if (value > 0) return "平台转给我";
  if (value < 0) return "我转给平台";
  return "已抵平";
}

/** 「方向 ¥|N|」；零只写已抵平。 */
export function netDirectionText(netCents: number) {
  const value = Math.trunc(Number(netCents) || 0);
  if (value === 0) return "已抵平 ¥0.00";
  return `${netDirectionLabel(value)} ${moneyYuanAbs(value)}`;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信",
  bank: "银行卡",
  other: "其他",
};

/** 付款方式中文名：空显示「—」，未知值显示「其他」。 */
export function paymentMethodLabel(method: string | null | undefined) {
  const key = String(method ?? "").trim().toLowerCase();
  if (!key) return "—";
  return PAYMENT_METHOD_LABELS[key] || "其他";
}

const RECONCILIATION_STATUS_LABELS: Record<string, string> = {
  draft: "平台核对中",
  pending_payment: "待付款",
  paid: "已付款",
  cleared: "已抵平结清",
  cancelled: "已取消",
  correction_pending: "更正中",
  corrected: "已更正",
};

export function reconciliationStatusLabel(status: string) {
  return RECONCILIATION_STATUS_LABELS[status] || status || "—";
}

const LEGACY_SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  paid: "已返佣",
  pending_payment: "待返佣（平台核验中）",
  cancelled: "已取消",
};

export function legacySettlementStatusLabel(status: string) {
  return LEGACY_SETTLEMENT_STATUS_LABELS[status] || status || "—";
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function beijingYmd(date: Date) {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 账本日期按北京时间切日，和 /api/agent/usage/stats 的口径一致。 */
export function beijingRangeYmd(range: AgentRangeKey, now = new Date()) {
  const end = beijingYmd(now);
  if (range === "all") return { start: "2020-01-01", end };
  if (range === "today") return { start: end, end };
  if (range === "month") return { start: `${end.slice(0, 8)}01`, end };
  return { start: beijingYmd(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)), end };
}

/**
 * 期间统计的左闭右开边界 [start, end)。
 * 纯日期按北京时间：start 取当天 00:00，end 取「end 日的次日」00:00（不含）。
 * 带时间的值按 ISO 原样解析，end 同样不含。
 */
export function beijingPeriodBounds(startValue: string, endValue: string) {
  const startText = startValue.trim();
  const endText = endValue.trim();
  const start = new Date(YMD.test(startText) ? `${startText}T00:00:00.000+08:00` : startText);
  let end = new Date(YMD.test(endText) ? `${endText}T00:00:00.000+08:00` : endText);
  if (YMD.test(endText)) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  if (!startText || !endText || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("时间范围格式无效");
  }
  if (start.getTime() >= end.getTime()) throw new Error("开始时间要早于结束时间");
  return { start: start.toISOString(), end: end.toISOString() };
}

export function couponFaceLabel(item: Pick<AgentCouponItem, "kind" | "percentZhe" | "amountCents">) {
  if (item.kind === "percent") return `${item.percentZhe} 折`;
  return `−¥${yuanTextFromCents(item.amountCents)}`;
}

export function couponFaceHint(
  item: Pick<AgentCouponItem, "kind" | "thresholdCents" | "enabled">,
) {
  if (!item.enabled) return "已停用";
  if (item.kind === "percent") return "折扣";
  return `满 ¥${yuanTextFromCents(item.thresholdCents)}`;
}

export function couponUsesLabel(item: Pick<AgentCouponItem, "maxUses" | "usedCount">) {
  if (item.maxUses === 0) return `已用 ${item.usedCount} 次 · 不限次数`;
  return `已用 ${item.usedCount} / ${item.maxUses}`;
}

export function couponUsesRatio(item: Pick<AgentCouponItem, "maxUses" | "usedCount">) {
  if (item.maxUses <= 0) return 0;
  return Math.min(100, Math.round((item.usedCount / item.maxUses) * 100));
}

export function dealLine(item: {
  productName: string;
  quantity?: number;
  couponCode?: string;
}) {
  const qty = item.quantity && item.quantity > 1 ? ` ×${item.quantity}` : "";
  const coupon = item.couponCode ? ` · 券 ${item.couponCode}` : "";
  return `${item.productName}${qty}${coupon}`;
}
