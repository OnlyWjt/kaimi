import { createHash } from "node:crypto";

/** 人民币分。正数是平台应付代理，负数是代理应付平台，零是抵平。 */
export type ReconciliationDirection =
  | "platform_pays_agent"
  | "agent_pays_platform"
  | "offset";

export type ReconciliationSourceType = "earning" | "adjustment" | "draw_item";

export const RECONCILIATION_PAYMENT_METHODS = ["alipay", "wechat", "bank", "other"] as const;
export type ReconciliationPaymentMethod = (typeof RECONCILIATION_PAYMENT_METHODS)[number];

export const CORRECTION_API_TYPES = ["refund", "fee_delta", "manual", "reversal"] as const;
export type CorrectionApiType = (typeof CORRECTION_API_TYPES)[number];

export function adjustmentTypeForCorrection(type: CorrectionApiType) {
  if (type === "fee_delta") return "fee_correction";
  return type;
}

export function netCents(input: {
  storeEarningCents: number;
  adjustmentCents: number;
  drawDebtCents: number;
}) {
  return input.storeEarningCents + input.adjustmentCents - input.drawDebtCents;
}

export function directionOf(amount: number): ReconciliationDirection {
  if (amount > 0) return "platform_pays_agent";
  if (amount < 0) return "agent_pays_platform";
  return "offset";
}

/** 旧周结单没点过已返佣。这些可以退回未结。已打款的不能退。 */
export function legacyStoreSettlementCanRelease(status: string) {
  return status === "pending_payment" || status === "draft";
}

export function directionLabel(direction: ReconciliationDirection) {
  if (direction === "platform_pays_agent") return "平台应付代理";
  if (direction === "agent_pays_platform") return "代理应付平台";
  return "抵平结清";
}

/** 券后商品额 − 代理成本 − 代理承担手续费。开票加价和平台手续费不进这个数。 */
export function agentEarningCents(input: {
  goodsCents: number;
  agentCostCents: number;
  agentFeeCents: number;
}) {
  return input.goodsCents - input.agentCostCents - input.agentFeeCents;
}

export type SnapshotLine = {
  sourceType: ReconciliationSourceType;
  sourceId: number;
  sourceVersion: string;
  amountCents: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * 来源版本指纹：只取和金额、归属相关的字段。updatedAt、备注等与金额无关的写入不改变指纹。
 * 传整行进来也只会读下面列出的字段。
 */
export function earningFingerprint(row: {
  earningCents: number;
  grossCents: number;
  costCents: number;
  agentFeeCents: number;
  orderId: number;
}) {
  return sha256(canonicalJson({
    kind: "earning",
    earningCents: row.earningCents,
    grossCents: row.grossCents,
    costCents: row.costCents,
    agentFeeCents: row.agentFeeCents,
    orderId: row.orderId,
  }));
}

export function adjustmentFingerprint(row: {
  amountCents: number;
  type: string;
  orderId: number;
  sequence: number;
  sourceEarningId: number;
}) {
  return sha256(canonicalJson({
    kind: "adjustment",
    amountCents: row.amountCents,
    type: row.type,
    orderId: row.orderId,
    sequence: row.sequence,
    sourceEarningId: row.sourceEarningId,
  }));
}

export function drawItemFingerprint(row: { amountCents: number; drawOrderId: number; planKey: string }) {
  return sha256(canonicalJson({
    kind: "draw_item",
    amountCents: row.amountCents,
    drawOrderId: row.drawOrderId,
    planKey: row.planKey,
  }));
}

/** 旧批次的 sourceVersion 是 updatedAt 时间串，只有 sha256: 开头的才按指纹比较。 */
export function isFingerprintVersion(version: string) {
  return version.startsWith("sha256:");
}

/** 截止时间允许 2 分钟时钟误差，再晚就是未来时间。 */
export const CUTOFF_FUTURE_SKEW_MS = 2 * 60 * 1000;

export function cutoffInFuture(cutoffAt: string, nowMs = Date.now()) {
  return Date.parse(cutoffAt) > nowMs + CUTOFF_FUTURE_SKEW_MS;
}

function yuan(cents: number) {
  const sign = cents < 0 ? "-" : "";
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** 只能为负、且不能超过当前有效收益的更正类型。 */
const NEGATIVE_ONLY_TYPES = new Set(["refund", "reversal"]);

/**
 * 订单更正金额校验。effectiveCents 是写入前的有效收益（原收益 + pending/settling/settled 调整）。
 * - 金额为 0 一律拒绝；
 * - refund / reversal 必须为负，且 |金额| ≤ 有效收益，有效收益为 0 时拒绝；
 * - 其他类型（fee_delta / fee_correction / manual）允许正负，但写入后有效收益不能小于 0。
 * type 接受接口类型（fee_delta）或调整表类型（fee_correction）。
 */
export function checkCorrectionAmount(
  type: string,
  amountCents: number,
  effectiveCents: number,
): PaymentCheck {
  const code = "CORRECTION_EXCEEDS_EARNING";
  const current = `订单当前有效收益 ${yuan(effectiveCents)}`;
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    return { ok: false, code, message: `更正金额不能为 0。${current}` };
  }
  if (NEGATIVE_ONLY_TYPES.has(type)) {
    if (effectiveCents <= 0) {
      return { ok: false, code, message: `${current}，已全额冲回，不能再记退款或冲回` };
    }
    if (amountCents > 0) {
      return {
        ok: false,
        code,
        message: `退款或冲回金额必须为负数。${current}，允许范围 ${yuan(-effectiveCents)} ~ -¥0.01`,
      };
    }
    if (-amountCents > effectiveCents) {
      return {
        ok: false,
        code,
        message: `${current}，本次最多冲回 ${yuan(effectiveCents)}，允许范围 ${yuan(-effectiveCents)} ~ -¥0.01`,
      };
    }
    return { ok: true };
  }
  return checkAdjustmentFloor(amountCents, effectiveCents);
}

/** 通用调整下界：金额非 0，写入后有效收益不小于 0。 */
export function checkAdjustmentFloor(amountCents: number, effectiveCents: number): PaymentCheck {
  const code = "CORRECTION_EXCEEDS_EARNING";
  const current = `订单当前有效收益 ${yuan(effectiveCents)}`;
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    return { ok: false, code, message: `调整金额不能为 0。${current}` };
  }
  if (effectiveCents + amountCents < 0) {
    const floor = Math.max(0, effectiveCents);
    return {
      ok: false,
      code,
      message: `${current}，调整后不能小于 ¥0.00，本次金额不能低于 ${yuan(-floor)}`,
    };
  }
  return { ok: true };
}

export type LockedLine = SnapshotLine & {
  /** 有 active claim 的对账批次 id。 */
  claimBatchId?: number | null;
  /** 旧周结单号（settling 但没有 claim 时，由 settlementId 关联得到）。 */
  legacySettlementNo?: string | null;
};

/**
 * 把「已被占用」的行拆成两种来源：
 * - lockedInBatch：有 active claim（含所有提卡），属于对账批次；
 * - lockedLegacy：status=settling 但没有 claim 的收益/调整，属于旧周结单。
 * 没有 settlementId 的旧周结行计入笔数和金额，但不出现在 settlementNos。
 */
export function splitLocked(lines: LockedLine[]) {
  const inBatchLines = lines.filter((line) => line.sourceType === "draw_item" || line.claimBatchId != null);
  const legacyLines = lines.filter((line) => !(line.sourceType === "draw_item" || line.claimBatchId != null));
  const batchTotals = totalsOf(inBatchLines);
  const legacyTotals = totalsOf(legacyLines);
  const batchIds = [...new Set(inBatchLines.flatMap((line) => (line.claimBatchId != null ? [line.claimBatchId] : [])))]
    .sort((a, b) => a - b);
  const settlementNos = [...new Set(legacyLines.flatMap((line) => (line.legacySettlementNo ? [line.legacySettlementNo] : [])))]
    .sort();
  return {
    lockedInBatch: {
      itemCount: batchTotals.itemCount,
      netCents: batchTotals.netCents,
      storeEarningCents: batchTotals.storeEarningCents,
      adjustmentCents: batchTotals.adjustmentCents,
      drawDebtCents: batchTotals.drawDebtCents,
      batchIds,
    },
    lockedLegacy: {
      itemCount: legacyTotals.itemCount,
      netCents: legacyTotals.netCents,
      storeEarningCents: legacyTotals.storeEarningCents,
      adjustmentCents: legacyTotals.adjustmentCents,
      settlementNos,
    },
  };
}

/** 已退款/退款中/拒付的订单不能被正数更正「复活」代理收益。 */
const REFUND_PAY_STATUSES = new Set(["refunded", "refunding", "chargeback"]);

export function checkNoRevive(payStatus: string, amountCents: number): PaymentCheck {
  if (REFUND_PAY_STATUSES.has(payStatus) && amountCents > 0) {
    return {
      ok: false,
      code: "CORRECTION_EXCEEDS_EARNING",
      message: "这笔订单已退款，不能再增加代理收益；如需调整请先联系开发核对",
    };
  }
  return { ok: true };
}

export function snapshotHash(lines: SnapshotLine[]) {
  const ordered = [...lines].sort((a, b) =>
    a.sourceType === b.sourceType ? a.sourceId - b.sourceId : a.sourceType.localeCompare(b.sourceType),
  );
  return sha256(canonicalJson(ordered));
}

/** 幂等摘要排除 requestId 一类追踪字段。 */
export function payloadHash(action: string, body: Record<string, unknown>) {
  const rest = { ...body };
  delete rest.requestId;
  return sha256(canonicalJson({ action, body: rest }));
}

export function totalsOf(lines: Array<SnapshotLine & { skipped?: boolean }>) {
  let storeEarningCents = 0;
  let adjustmentCents = 0;
  let drawDebtCents = 0;
  let storeCount = 0;
  let adjustmentCount = 0;
  let drawCount = 0;
  for (const line of lines) {
    if (line.skipped) continue;
    if (line.sourceType === "earning") {
      storeEarningCents += line.amountCents;
      storeCount += 1;
    } else if (line.sourceType === "adjustment") {
      adjustmentCents += line.amountCents;
      adjustmentCount += 1;
    } else {
      drawDebtCents += line.amountCents;
      drawCount += 1;
    }
  }
  const amount = netCents({ storeEarningCents, adjustmentCents, drawDebtCents });
  return {
    storeEarningCents,
    adjustmentCents,
    drawDebtCents,
    netCents: amount,
    direction: directionOf(amount),
    storeCount,
    adjustmentCount,
    drawCount,
    itemCount: storeCount + adjustmentCount + drawCount,
  };
}

export function nextCorrectionSequence(existing: number[]) {
  const max = existing.reduce((top, value) => (value > top ? value : top), 0);
  return max + 1;
}

export function assertCorrectionSequence(existing: number[], expected: number) {
  const next = nextCorrectionSequence(existing);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected !== next) {
    return { ok: false as const, next };
  }
  return { ok: true as const, next };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isIsoUtc(value: string) {
  if (!ISO_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export type PaymentCheck =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** 实际付款时间允许 5 分钟时钟误差，再晚就是未来时间。 */
export const PAYMENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function validateMarkPaid(input: {
  netCents: number;
  direction: string;
  currency: string;
  amountCents: number;
  paymentMethod: string;
  paymentReference: string;
  actualPaymentAt: string;
}, now: number = Date.now()): PaymentCheck {
  if (input.netCents === 0) {
    return { ok: false, code: "INVALID_STATE", message: "净额为 0，用结清，不要登记付款" };
  }
  if (input.currency !== "CNY") {
    return { ok: false, code: "INVALID_DIRECTION", message: "只登记人民币" };
  }
  if (input.direction !== directionOf(input.netCents)) {
    return { ok: false, code: "INVALID_DIRECTION", message: "方向和净额不一致" };
  }
  if (input.amountCents !== Math.abs(input.netCents)) {
    return { ok: false, code: "INVALID_DIRECTION", message: "付款金额必须等于净额绝对值" };
  }
  if (!RECONCILIATION_PAYMENT_METHODS.includes(input.paymentMethod as ReconciliationPaymentMethod)) {
    return { ok: false, code: "PAYMENT_REFERENCE_REQUIRED", message: "付款方式无效" };
  }
  if (!input.paymentReference.trim()) {
    return { ok: false, code: "PAYMENT_REFERENCE_REQUIRED", message: "填写流水号" };
  }
  if (!isIsoUtc(input.actualPaymentAt)) {
    return { ok: false, code: "PAYMENT_REFERENCE_REQUIRED", message: "付款时间用 UTC 时间" };
  }
  if (Date.parse(input.actualPaymentAt) > now + PAYMENT_FUTURE_SKEW_MS) {
    return { ok: false, code: "PAYMENT_REFERENCE_REQUIRED", message: "付款时间不能晚于现在" };
  }
  return { ok: true };
}

export function validateClear(input: { netCents: number; hasPaymentFields: boolean }): PaymentCheck {
  if (input.netCents !== 0) {
    return { ok: false, code: "INVALID_STATE", message: "净额不是 0，不能结清" };
  }
  if (input.hasPaymentFields) {
    return { ok: false, code: "INVALID_STATE", message: "抵平不能填写付款方式或流水号" };
  }
  return { ok: true };
}

/** CSV 单元格。以 = + - @ 开头的文本加前缀，避免表格把内容当公式。 */
export function csvCell(value: string | number) {
  const text = String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function csvRow(cells: Array<string | number>) {
  return cells.map(csvCell).join(",");
}
