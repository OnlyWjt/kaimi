import { customAlphabet } from "nanoid";
import { yuanTextFromCents } from "./money";

export const DRAW_ACCESS_STATUSES = [
  "none",
  "pending",
  "approved",
  "rejected",
  "suspended",
] as const;
export type DrawAccessStatus = (typeof DRAW_ACCESS_STATUSES)[number];

export const DRAW_ORDER_STATUSES = [
  "issuing",
  "delivered",
  "partial",
  "failed",
  "unknown",
] as const;
export type DrawOrderStatus = (typeof DRAW_ORDER_STATUSES)[number];

/** 还占着额度的提卡单：卡台那边可能已经扣了卡，结果没回来之前不能放掉。 */
export const DRAW_INFLIGHT_STATUSES: DrawOrderStatus[] = ["issuing", "unknown"];

export const DRAW_MAX_PER_DRAW_CAP = 200;
export const DRAW_DEFAULT_CREDIT_CENTS = 300_000;
export const DRAW_DEFAULT_MAX_PER_DRAW = 10;
export const DRAW_REAPPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DRAW_REMIND_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const DRAW_BILL_REVERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAW_ISSUING_LEASE_MS = 5 * 60_000;
export const DRAW_CREDIT_WARN_RATIO = 0.8;
export const DRAW_MAX_SETTLE_ITEMS = 5000;
/** 含第一次请求。超过后不再自动取回，改发人工核对告警。 */
export const DRAW_RECOVER_MAX_ATTEMPTS = 6;

export const EXPECTED_MONTHLY_OPTIONS = [
  { value: "lt50", label: "50 张以下" },
  { value: "50_200", label: "50–200 张" },
  { value: "200_1000", label: "200–1000 张" },
  { value: "gt1000", label: "1000 张以上" },
] as const;
export type ExpectedMonthly = (typeof EXPECTED_MONTHLY_OPTIONS)[number]["value"];

export function expectedMonthlyLabel(value: string) {
  return EXPECTED_MONTHLY_OPTIONS.find((item) => item.value === value)?.label || value || "—";
}

export const DRAW_PAYMENT_METHODS = [
  { value: "alipay", label: "支付宝" },
  { value: "wechat", label: "微信" },
  { value: "usdt", label: "USDT" },
  { value: "bank", label: "银行卡" },
  { value: "other", label: "其他" },
] as const;
export type DrawPaymentMethod = (typeof DRAW_PAYMENT_METHODS)[number]["value"];

export function drawPaymentMethodLabel(value: string) {
  return DRAW_PAYMENT_METHODS.find((item) => item.value === value)?.label || value || "—";
}

export function normalizeDrawPaymentMethod(value: string): DrawPaymentMethod | null {
  return DRAW_PAYMENT_METHODS.find((item) => item.value === value)?.value ?? null;
}

export function normalizeDrawAccessStatus(value: string | null | undefined): DrawAccessStatus {
  return (DRAW_ACCESS_STATUSES as readonly string[]).includes(String(value))
    ? (value as DrawAccessStatus)
    : "none";
}

const tokenAlphabet = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 24);

export function newDrawLinkToken() {
  return tokenAlphabet();
}

export function isDrawLinkToken(value: string) {
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{24}$/.test(value);
}

export type DrawPriceInput = {
  drawPriceCents: number | null | undefined;
  costOverrideCents: number | null | undefined;
  globalCostPriceCents: number | null | undefined;
};

export type DrawPriceSource = "draw_override" | "agent_cost" | "global_cost";

/** 商城里成本价 0 会被当真；提卡是先拿后付，0 一律视为没配，免得白送。 */
export function resolveDrawUnitPrice(
  input: DrawPriceInput,
): { unitPriceCents: number; source: DrawPriceSource } | null {
  if (input.drawPriceCents != null && input.drawPriceCents > 0) {
    return { unitPriceCents: Math.trunc(input.drawPriceCents), source: "draw_override" };
  }
  if (input.costOverrideCents != null && input.costOverrideCents > 0) {
    return { unitPriceCents: Math.trunc(input.costOverrideCents), source: "agent_cost" };
  }
  if (input.globalCostPriceCents != null && input.globalCostPriceCents > 0) {
    return { unitPriceCents: Math.trunc(input.globalCostPriceCents), source: "global_cost" };
  }
  return null;
}

export function parseAllowedPlanKeys(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function planAllowed(allowed: string[], planKey: string) {
  return allowed.length === 0 || allowed.includes(planKey);
}

export type InflightDrawOrder = {
  quantity: number;
  issuedCount: number;
  unitPriceCents: number;
};

export function inflightRemainingCount(order: Pick<InflightDrawOrder, "quantity" | "issuedCount">) {
  return Math.max(0, order.quantity - order.issuedCount);
}

export function computeInflightCents(orders: InflightDrawOrder[]) {
  return orders.reduce(
    (sum, order) => sum + inflightRemainingCount(order) * order.unitPriceCents,
    0,
  );
}

export type DrawCredit = {
  limitCents: number;
  unsettledCents: number;
  inflightCents: number;
  exposureCents: number;
  availableCents: number;
};

export function computeDrawCredit(input: {
  limitCents: number;
  unsettledCents: number;
  inflight: InflightDrawOrder[];
}): DrawCredit {
  const inflightCents = computeInflightCents(input.inflight);
  const exposureCents = input.unsettledCents + inflightCents;
  return {
    limitCents: input.limitCents,
    unsettledCents: input.unsettledCents,
    inflightCents,
    exposureCents,
    availableCents: Math.max(0, input.limitCents - exposureCents),
  };
}

export function creditRatio(credit: Pick<DrawCredit, "limitCents" | "exposureCents">) {
  if (credit.limitCents <= 0) return credit.exposureCents > 0 ? 1 : 0;
  return credit.exposureCents / credit.limitCents;
}

export function formatYuan(cents: number) {
  const negative = cents < 0;
  const [whole, frac] = yuanTextFromCents(Math.abs(cents)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}¥${grouped}.${frac}`;
}

/** 未结占上限的比例。上限为 0 且已有未结时视为用满。 */
export function creditHeat(ratio: number): "ok" | "warn" | "full" {
  if (ratio >= 1) return "full";
  if (ratio >= DRAW_CREDIT_WARN_RATIO) return "warn";
  return "ok";
}

/** 额度够不够，不够就给代理看的中文原因。 */
export function drawCreditError(credit: DrawCredit, amountCents: number): string | null {
  if (amountCents <= credit.availableCents) return null;
  return `还能提 ${formatYuan(credit.availableCents)}，这次要 ${formatYuan(amountCents)}。和平台结算后会恢复。`;
}

/** 按这一单账本里的总张数定状态。重放时新写入可能是 0，不能拿新写入数判断。 */
export function drawOrderStatusFromIssued(
  issuedCount: number,
  quantity: number,
): DrawOrderStatus {
  if (issuedCount <= 0) return "failed";
  if (issuedCount >= quantity) return "delivered";
  return "partial";
}

export function billRevertOpen(createdAt: string, now = Date.now()) {
  return cooldownLeftMs(createdAt, DRAW_BILL_REVERT_WINDOW_MS, now) > 0;
}

/** 确认没出卡时核对提卡单号后四位，避免点错单。 */
export function drawNoTailMatches(drawNo: string, suffix: string) {
  const tail = drawNo.trim().slice(-4).toUpperCase();
  const given = suffix.trim().toUpperCase();
  return tail.length === 4 && given === tail;
}

export function drawSettingsError(input: { maxPerDraw: number; dailyLimitCount: number }) {
  if (
    !Number.isInteger(input.maxPerDraw) ||
    input.maxPerDraw < 1 ||
    input.maxPerDraw > DRAW_MAX_PER_DRAW_CAP
  ) {
    return `单次最多填 1–${DRAW_MAX_PER_DRAW_CAP} 张`;
  }
  if (
    !Number.isInteger(input.dailyLimitCount) ||
    input.dailyLimitCount < 0 ||
    input.dailyLimitCount > 100_000
  ) {
    return "每日最多填 0（不限）到 100000";
  }
  return null;
}

function csvCell(value: string | number) {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM，Excel 直接打开中文不乱码。 */
export function toCsv(header: string[], rows: Array<Array<string | number>>) {
  const lines = [header, ...rows].map((line) => line.map((cell) => csvCell(cell)).join(","));
  return `\uFEFF${lines.join("\r\n")}`;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 北京时间当天 0 点对应的 UTC ISO 串，每日上限按这个切。 */
export function beijingDayStartIso(now: Date) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const startShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(startShifted - BEIJING_OFFSET_MS).toISOString();
}

export function drawDailyLimitError(input: {
  dailyLimitCount: number;
  todayCount: number;
  quantity: number;
}): string | null {
  if (input.dailyLimitCount <= 0) return null;
  if (input.todayCount + input.quantity <= input.dailyLimitCount) return null;
  const left = Math.max(0, input.dailyLimitCount - input.todayCount);
  return left > 0
    ? `今天最多还能提 ${left} 张（每日上限 ${input.dailyLimitCount} 张）`
    : `今天已达每日上限 ${input.dailyLimitCount} 张，明天再来`;
}

export function drawQuantityError(quantity: number, maxPerDraw: number): string | null {
  if (!Number.isInteger(quantity) || quantity < 1) return "张数至少 1 张";
  const cap = Math.min(DRAW_MAX_PER_DRAW_CAP, Math.max(1, maxPerDraw));
  if (quantity > cap) return `一次最多提 ${cap} 张`;
  return null;
}

/** 这一笔让敞口第一次跨过预警线时返回 true；这一周期已经提醒过就不再提醒。 */
export function creditWarnCrossed(input: {
  limitCents: number;
  exposureCents: number;
  alreadyWarned: boolean;
}) {
  if (input.alreadyWarned || input.limitCents <= 0) return false;
  return input.exposureCents >= input.limitCents * DRAW_CREDIT_WARN_RATIO;
}

export function cooldownLeftMs(since: string | null | undefined, windowMs: number, now = Date.now()) {
  if (!since) return 0;
  const at = new Date(since).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at + windowMs - now);
}

export function formatCooldown(ms: number) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.ceil((ms % 3_600_000) / 60_000);
  if (hours <= 0) return `${Math.max(1, minutes)} 分钟`;
  return minutes > 0 && minutes < 60 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

export type DrawItemForSummary = {
  planKey: string;
  planName?: string;
  amountCents: number;
};

export type DrawPlanSummary = {
  planKey: string;
  planName: string;
  unitPriceCents: number;
  count: number;
  amountCents: number;
};

/** 同一套餐单价不同（中途调过价）要分开列，否则「张数 × 单价」对不上合计。 */
export function summarizeDrawItems(items: DrawItemForSummary[]): DrawPlanSummary[] {
  const groups = new Map<string, DrawPlanSummary>();
  for (const item of items) {
    const key = `${item.planKey}\u0000${item.amountCents}`;
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      current.amountCents += item.amountCents;
    } else {
      groups.set(key, {
        planKey: item.planKey,
        planName: item.planName || item.planKey,
        unitPriceCents: item.amountCents,
        count: 1,
        amountCents: item.amountCents,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => a.planName.localeCompare(b.planName) || a.unitPriceCents - b.unitPriceCents,
  );
}

function beijingMinute(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const at = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** 平台和代理都能复制的对账文本，时间统一按北京时间。 */
export function buildDrawStatementText(input: {
  shopName: string;
  items: Array<DrawItemForSummary & { createdAt: string }>;
  voidCount?: number;
  siteName?: string;
}) {
  const site = input.siteName?.trim() || "Kaimi";
  if (!input.items.length) {
    return `【${site} 提卡对账】${input.shopName}\n当前没有未结算的卡密。`;
  }
  const times = input.items.map((item) => item.createdAt).sort();
  const summary = summarizeDrawItems(input.items);
  const total = summary.reduce((sum, row) => sum + row.amountCents, 0);
  const width = Math.max(...summary.map((row) => row.planName.length), 4);
  const lines = summary.map(
    (row) =>
      `${row.planName.padEnd(width, " ")}  × ${row.count}  @ ${formatYuan(row.unitPriceCents)}  = ${formatYuan(row.amountCents)}`,
  );
  return [
    `【${site} 提卡对账】${input.shopName}`,
    `统计范围：${beijingMinute(times[0])} ～ ${beijingMinute(times[times.length - 1])}（北京时间）`,
    "————————————",
    ...lines,
    "————————————",
    `合计 ${input.items.length} 张，应付 ${formatYuan(total)}`,
    input.voidCount ? `（作废 ${input.voidCount} 张未计入）` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const DRAW_ACCESS_LABEL: Record<DrawAccessStatus, string> = {
  none: "未开通",
  pending: "审核中",
  approved: "已开通",
  rejected: "未通过",
  suspended: "已暂停",
};

export const DRAW_ORDER_LABEL: Record<DrawOrderStatus, string> = {
  issuing: "出卡中",
  delivered: "已出卡",
  partial: "部分出卡",
  failed: "失败",
  unknown: "结果未知",
};

export const DRAW_ITEM_LABEL: Record<string, string> = {
  unsettled: "未结算",
  settled: "已结算",
  void: "已作废",
};

export const CDK_USE_LABEL: Record<string, string> = {
  unused: "未使用",
  locked: "兑换中",
  redeeming: "兑换中",
  used: "已兑换",
  disabled: "已作废",
};

/** 登录回跳只接受站内路径，挡掉 //evil.com 这类协议相对地址。 */
export function safeNextPath(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "";
  return raw;
}
