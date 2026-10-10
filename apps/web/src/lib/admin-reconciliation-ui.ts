import { parseDbDate } from "./datetime";

/** 管理员对账页的纯函数。金额一律整数分，方向用文字表达，不用负号。 */

export type ReconDirection = "platform_pays_agent" | "agent_pays_platform" | "offset";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUS = "\u2212";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** 绝对值，千分位、两位小数：¥1,234.50。 */
export function formatYuan(cents: number) {
  const value = Math.abs(Number(cents) || 0) / 100;
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 分项金额（调整等）需要明确符号：−¥40.00。 */
export function formatSignedYuan(cents: number) {
  return cents < 0 ? `${MINUS}${formatYuan(cents)}` : formatYuan(cents);
}

export function directionOfNet(netCents: number): ReconDirection {
  if (netCents > 0) return "platform_pays_agent";
  if (netCents < 0) return "agent_pays_platform";
  return "offset";
}

export function directionText(direction: ReconDirection | string) {
  if (direction === "platform_pays_agent") return "平台应付代理";
  if (direction === "agent_pays_platform") return "代理应付平台";
  return "抵平";
}

/** 方向文案 + 绝对值，例如「代理应付平台 ¥300.00」。 */
export function formatNet(netCents: number) {
  return `${directionText(directionOfNet(netCents))} ${formatYuan(netCents)}`;
}

export type Breakdown = {
  storeEarningCents: number;
  adjustmentCents: number;
  drawDebtCents: number;
  netCents: number;
};

export function formatFormula(input: Breakdown) {
  return `商店收益 ${formatSignedYuan(input.storeEarningCents)} ＋ 调整 ${formatSignedYuan(
    input.adjustmentCents,
  )} − 提卡 ${formatSignedYuan(input.drawDebtCents)} ＝ ${formatNet(input.netCents)}`;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "待核对",
  pending_payment: "待付款",
  paid: "已付款",
  cleared: "已抵平结清",
  cancelled: "已取消",
  correction_pending: "更正中",
  corrected: "已更正",
};

export function statusLabel(status: string) {
  return STATUS_LABELS[status] || "未知状态";
}

/** 还在处理中、需要管理员继续操作的批次。 */
export function isActiveBatchStatus(status: string) {
  return status === "draft" || status === "pending_payment" || status === "correction_pending";
}

/** 明细仍被占用（未付款）的批次。 */
export function isUnpaidBatchStatus(status: string) {
  return status === "draft" || status === "pending_payment";
}

export function isCancellableStatus(status: string) {
  return status === "draft" || status === "pending_payment";
}

export function isCorrectableStatus(status: string) {
  return ["paid", "cleared", "correction_pending", "corrected"].includes(status);
}

export function itemTypeLabel(type: string) {
  if (type === "earning") return "商店收益";
  if (type === "adjustment") return "调整";
  if (type === "draw_item") return "提卡";
  return "其他";
}

/** 明细对净额的影响：提卡是代理欠款，记为负向。 */
export function netEffectCents(type: string, amountCents: number) {
  return type === "draw_item" ? -amountCents : amountCents;
}

export const PAYMENT_METHODS = [
  { value: "alipay", label: "支付宝" },
  { value: "wechat", label: "微信" },
  { value: "bank", label: "银行卡" },
  { value: "other", label: "其他" },
] as const;

export function paymentMethodLabel(value: string) {
  return PAYMENT_METHODS.find((item) => item.value === value)?.label || (value ? "其他" : "—");
}

export const CORRECTION_TYPES = [
  { value: "refund", label: "退款", negative: true },
  { value: "fee_delta", label: "手续费差额", negative: false },
  { value: "manual", label: "人工", negative: false },
  { value: "reversal", label: "冲正", negative: true },
] as const;

export type CorrectionType = (typeof CORRECTION_TYPES)[number]["value"];

export function skipCodeLabel(code: string | undefined) {
  if (code === "MANUAL_REVIEW_REQUIRED") return "手续费待核对";
  if (code === "LEDGER_MISMATCH") return "订单与收益行对不上";
  if (code === "MISSING_SOURCE") return "缺收益行或来源数据";
  return "待核对";
}

export const PAID_AT_FUTURE_TEXT = "付款时间不能晚于现在";

/** 与后端 validateMarkPaid 对齐：允许 5 分钟时钟误差，超过则视为未来。 */
export const PAID_AT_SKEW_MS = 5 * 60 * 1000;

export function isPaidAtInFuture(iso: string | null, now = new Date()) {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now.getTime() + PAID_AT_SKEW_MS;
}

/**
 * 跳过项确认勾选的有效范围：预览版本、截止时间、跳过项内容（顺序无关）任一变化，勾选即作废。
 */
export function skippedAckKey(
  previewVersion: string,
  cutoffAt: string,
  skipped: Array<{ code?: string; orderNo: string; amountCents: number | null }> | undefined,
) {
  const parts = (skipped || [])
    .map((item) => `${item.code}:${item.orderNo}:${item.amountCents ?? "null"}`)
    .sort();
  return `${previewVersion}|${cutoffAt}|${parts.join(",")}`;
}

export type LockedPart = {
  itemCount: number;
  netCents: number;
  ids: Array<number | string>;
};

export type LockedView = {
  /** 旧后端没有拆分字段时为 true：只显示合计文案，不给「打开批次」。 */
  legacyShape: boolean;
  inBatch: (LockedPart & { batchIds: number[] }) | null;
  legacy: (LockedPart & { settlementNos: string[] }) | null;
  total: { itemCount: number; netCents: number } | null;
};

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ids<T>(value: unknown, keep: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(keep) : [];
}

/** 容错解析 preview 的锁定分区；字段缺失不抛错。 */
export function parseLocked(preview: {
  locked?: unknown;
  lockedInBatch?: unknown;
  lockedLegacy?: unknown;
}): LockedView {
  const locked = (preview.locked || {}) as Record<string, unknown>;
  const inBatchRaw = preview.lockedInBatch as Record<string, unknown> | undefined | null;
  const legacyRaw = preview.lockedLegacy as Record<string, unknown> | undefined | null;
  const legacyShape = !inBatchRaw && !legacyRaw;
  const total = num(locked.itemCount) > 0 ? { itemCount: num(locked.itemCount), netCents: num(locked.netCents) } : null;
  const batchIds = ids(inBatchRaw?.batchIds, (item): item is number => Number.isSafeInteger(item) && (item as number) > 0);
  const settlementNos = ids(legacyRaw?.settlementNos, (item): item is string => typeof item === "string" && item !== "");
  return {
    legacyShape,
    inBatch:
      inBatchRaw && num(inBatchRaw.itemCount) > 0
        ? { itemCount: num(inBatchRaw.itemCount), netCents: num(inBatchRaw.netCents), ids: batchIds, batchIds }
        : null,
    legacy:
      legacyRaw && num(legacyRaw.itemCount) > 0
        ? { itemCount: num(legacyRaw.itemCount), netCents: num(legacyRaw.netCents), ids: settlementNos, settlementNos }
        : null,
    total,
  };
}

export function skippedKey(item: { code?: string; orderNo: string }, index: number) {
  return `${item.code || ""}-${item.orderNo}-${index}`;
}

const AUDIT_LABELS: Record<string, string> = {
  "reconciliation.create": "生成批次",
  "reconciliation.confirm": "确认批次",
  "reconciliation.cancel": "取消批次",
  "reconciliation.mark_paid": "登记付款",
  "reconciliation.clear": "抵平结清",
  "reconciliation.correction": "记更正",
};

export function auditActionLabel(action: string) {
  return AUDIT_LABELS[action] || "其他操作";
}

/** 库里时间（带 Z 的 ISO 或 SQLite 无时区 UTC）→ 北京时间 yyyy-MM-dd HH:mm。 */
export function formatBeijing(value: unknown, empty = "—") {
  const date = parseDbDate(value);
  if (!date) return empty;
  const at = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(
    at.getUTCHours(),
  )}:${pad(at.getUTCMinutes())}`;
}

/** datetime-local 的默认值：当前北京时间，不看浏览器时区。 */
export function beijingInputValue(date = new Date()) {
  const at = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(
    at.getUTCHours(),
  )}:${pad(at.getUTCMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 把 datetime-local 的值按 +08:00 解析，转成 UTC ISO。无效返回 null。 */
export function beijingInputToUtcIso(value: string) {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;
  const check = new Date(utcMs + BEIJING_OFFSET_MS);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null;
  return new Date(utcMs).toISOString();
}

/** 元输入 → 整数分。允许前导 - 或 −、千分位逗号，最多两位小数。无效返回 null。 */
export function parseYuanInput(text: string) {
  const raw = text.trim().replace(/,/g, "").replace(MINUS, "-").replace(/^¥/, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0") || 0);
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] ? -cents : cents;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
    return out;
  }
  return value;
}

export type IdemEntry = { fingerprint: string; key: string };

export function idemFingerprint(op: string, scope: string, form: unknown) {
  return `${op}|${scope}|${JSON.stringify(canonical(form ?? {}))}`;
}

/**
 * 同一操作、同一对象、同一表单内容 → 复用原 key（失败重试不会生成第二笔）；
 * 任一项变化 → 新 key。成功后由调用方丢弃 entry。
 */
export function reuseOrCreateKey(
  previous: IdemEntry | undefined,
  op: string,
  scope: string,
  form: unknown,
  makeId: () => string,
): IdemEntry {
  const fingerprint = idemFingerprint(op, scope, form);
  if (previous && previous.fingerprint === fingerprint) return previous;
  return { fingerprint, key: `${op}-${scope}-${makeId()}` };
}

/** 更正表单还缺什么，按填写顺序列出；空数组表示可以提交。 */
export function correctionMissing(input: {
  hasItem: boolean;
  amountText: string;
  amountCents: number | null;
  reason: string;
  sequence: number;
}) {
  const missing: string[] = [];
  if (!input.hasItem) missing.push("请选择要更正的明细");
  if (!input.amountText.trim()) missing.push("请填写金额");
  else if (input.amountCents === null) missing.push("金额格式不对");
  else if (input.amountCents === 0) missing.push("金额不能为 0");
  if (!input.reason.trim()) missing.push("请填写原因");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) missing.push("更正序号要大于 0");
  return missing;
}

export function correctionEventKey(batchId: number, itemId: number, uuid: string) {
  return `manual:${batchId}:${itemId}:${uuid}`;
}

/** 后端 CORRECTION_SEQUENCE_CONFLICT 文案「下一序号是 N」。 */
export function parseNextSequence(message: string | undefined) {
  const match = /下一序号是\s*(\d+)/.exec(message || "");
  return match ? Number(match[1]) : null;
}

/** 后端 CSV 导出按 cursor/limit 分页（最多 100 条），按段给链接。 */
export function csvExportLinks(batchId: number, total: number, pageSize = 100) {
  const links: Array<{ href: string; label: string }> = [];
  const count = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  for (let index = 0; index < count; index += 1) {
    const cursor = index * pageSize;
    const params = new URLSearchParams({ format: "csv", cursor: String(cursor), limit: String(pageSize) });
    links.push({
      href: `/api/admin/reconciliations/${batchId}/items?${params}`,
      label: count === 1 ? "导出 CSV" : `导出 CSV 第 ${cursor + 1}–${Math.min(total, cursor + pageSize)} 条`,
    });
  }
  return links;
}

export type ErrorStage = "list" | "preview" | "create" | "batch" | "payment" | "correction";

export type ErrorAction = "repreview" | "cancel_rebuild" | "open_batch" | "refresh" | "new_event" | "relogin";

export type ErrorView = {
  text: string;
  detail?: string;
  action?: ErrorAction;
  nextSequence?: number;
  /** 写操作结果未知：网络断开、超时或 5xx。 */
  unknown?: boolean;
};

export function isWriteStage(stage: ErrorStage) {
  return stage === "create" || stage === "batch" || stage === "payment" || stage === "correction";
}

export function errorView(input: {
  status: number;
  code?: string;
  message?: string;
  requestId?: string;
  stage: ErrorStage;
}): ErrorView {
  const { status, code, stage } = input;
  const write = isWriteStage(stage);
  if (status === 0) {
    if (write) return { text: "网络中断或超时，结果未知，请刷新查看批次状态", unknown: true, action: "refresh" };
    return { text: "网络中断或超时，请稍后重试", action: "refresh" };
  }
  if (status >= 500) {
    const text = `系统出错，请把编号 ${input.requestId || "（无）"} 发给开发`;
    if (write) return { text: `${text}。结果未知，请刷新查看批次状态`, unknown: true, action: "refresh" };
    return { text };
  }
  if (status === 401 || code === "UNAUTHORIZED") return { text: "登录已过期，请重新登录", action: "relogin" };
  if (status === 403 || code === "FORBIDDEN") return { text: "没有权限做这个操作" };
  const detail = input.message || undefined;
  switch (code) {
    case "SNAPSHOT_CHANGED":
      if (stage === "batch" || stage === "payment") {
        return { text: "明细已变化，请取消批次后重新生成", detail, action: "cancel_rebuild" };
      }
      return { text: "明细已变化，请重新预览", detail, action: "repreview" };
    case "ITEM_ALREADY_CLAIMED":
      return { text: "有明细已在其他批次", detail, action: "open_batch" };
    case "MANUAL_REVIEW_REQUIRED":
    case "LEDGER_MISMATCH":
    case "MISSING_SOURCE":
      return { text: "有待核对项未确认", detail, action: "repreview" };
    case "PAYMENT_REFERENCE_REQUIRED":
      if (/晚于现在/.test(input.message || "")) return { text: PAID_AT_FUTURE_TEXT, detail };
      return { text: "请填写流水号和付款时间", detail };
    case "IDEMPOTENCY_CONFLICT":
      return { text: "上一次提交还在处理或内容不同，请刷新后再试", detail, action: "refresh" };
    case "BATCH_NOT_CANCELLABLE":
      return { text: "已付款或已结清的批次不能取消", detail, action: "refresh" };
    case "INVALID_DIRECTION":
      return { text: "付款方向、金额或币种与批次净额不一致，请刷新批次后重填", detail, action: "refresh" };
    case "CORRECTION_SEQUENCE_CONFLICT": {
      const next = parseNextSequence(input.message);
      return next
        ? { text: `更正序号不对，已改成 ${next}，请核对后再提交`, nextSequence: next }
        : { text: "更正序号刚被占用，请刷新后再提交", detail, action: "refresh" };
    }
    case "CORRECTION_EXCEEDS_EARNING":
      return { text: "更正金额超过这笔订单的有效收益，或订单已退款不能增加收益", detail };
    case "ADJUSTMENT_EVENT_CONFLICT":
      return { text: "这笔更正已经记过，或同一事件的内容不同", detail, action: "new_event" };
    case "EMPTY_BATCH":
      return { text: "没有可纳入的未结明细", detail, action: "repreview" };
    case "INVALID_STATE":
      return { text: "当前状态不允许这个操作，请刷新后再看", detail, action: "refresh" };
    default:
      return { text: `系统出错，请把编号 ${input.requestId || "（无）"} 发给开发` };
  }
}
