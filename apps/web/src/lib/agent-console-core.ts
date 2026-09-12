import type { ThemeId } from "@kaimi/themes";
import type { UnreadAnnouncement } from "./announcements-core";
import { yuanTextFromCents } from "./money";

export type AgentConsoleProfile = {
  username: string;
  displayName: string;
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

export function agentEarningsQuery(range: AgentRangeKey) {
  if (range === "all") return "";
  const { start, end } = agentRangeYmd(range);
  return `&start=${start}&end=${end}`;
}

export function moneyYuan(cents: number) {
  return `¥${yuanTextFromCents(cents)}`;
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
