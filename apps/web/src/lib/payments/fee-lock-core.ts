/**
 * 手续费回写与对账快照之间的锁定规则（纯函数，不读数据库，便于测试）。
 *
 * 收益行一旦进入对账（settling）或已结算（settled），批次快照与 assertSourcesStable
 * 只认收益行自身字段。此时再改订单金额，订单就和快照对不上；正确做法是订单金额保持
 * 不动，差额另写 fee_correction 调整，进入下一批次。
 */

/** 订单上由手续费推导出来的金额字段：收益锁定后都不能再改。 */
export const ORDER_FEE_AMOUNT_FIELDS = [
  "finalPaymentFeeCents",
  "agentFeeCents",
  "platformFeeCents",
  "agentEarningCents",
  "platformProfitCents",
] as const;

export const LOCKED_EARNING_FEE_MESSAGE = "收益已进入对账/已结算，手续费差额需人工更正";
export const FEE_REVIEW_SETTLING_MESSAGE = "这单在对账批次中，先结清或取消批次再处理手续费";
export const AUDIT_FEE_REVIEW_PENDING_MESSAGE = "这单手续费待核对，请先在手续费核对里处理";
export const RECALC_SETTLING_MESSAGE = "这单在对账批次中，先取消批次";
export const RECALC_SETTLED_MESSAGE = "已结算，差额请走手续费更正";

/**
 * 订单更新的条件：该订单存在「已锁定」收益行（非 pending，或已挂结算单）。
 * 写在 UPDATE store_orders 的 WHERE 里，判断和写入在同一条语句完成。
 */
export const LOCKED_EARNING_EXISTS_SQL = `EXISTS (
  SELECT 1 FROM agent_earnings
  WHERE agent_earnings.order_id = store_orders.id
    AND (agent_earnings.status != 'pending' OR agent_earnings.settlement_id IS NOT NULL)
)`;

export const NO_LOCKED_EARNING_SQL = `NOT ${LOCKED_EARNING_EXISTS_SQL}`;

export type EarningLockState = "none" | "open" | "settling" | "settled" | "other";

export function earningLockState(
  earning: { status: string; settlementId: number | null } | null | undefined,
): EarningLockState {
  if (!earning) return "none";
  if (earning.status === "pending" && earning.settlementId == null) return "open";
  if (earning.status === "settling") return "settling";
  if (earning.status === "settled") return "settled";
  // pending 但挂着旧结算单，或 reversed 等：都按锁定处理，不同步改金额。
  return "other";
}

export function isEarningOpen(state: EarningLockState) {
  return state === "none" || state === "open";
}

type OrderFeeAmounts = {
  finalPaymentFeeCents: number;
  agentFeeCents: number;
  platformFeeCents: number;
  agentEarningCents: number;
  platformProfitCents: number | null;
};

/** 新算出的金额和订单现有金额完全一致（锁定时无需人工）。 */
export function feeAmountsEqual(order: OrderFeeAmounts, ledger: OrderFeeAmounts) {
  return ORDER_FEE_AMOUNT_FIELDS.every((field) => order[field] === ledger[field]);
}

/** 已结收益的手续费更正金额：目标收益 − 当前有效收益（原收益 + 有效调整）。 */
export function feeCorrectionDelta(targetEarningCents: number, effectiveEarningCents: number) {
  return targetEarningCents - effectiveEarningCents;
}

/** fee-review 的业务事件键：同一次审核（同一条对账记录 / 同一网关手续费）得到同一个键。 */
export function feeReviewEventKey(
  orderId: number,
  source: { reconciliationId?: number | null; actualFeeCents: number },
) {
  return source.reconciliationId != null
    ? `fee-review:${orderId}:rec${source.reconciliationId}`
    : `fee-review:${orderId}:fee${source.actualFeeCents}`;
}

export function feeReviewReason(actualFeeCents: number, estimatedFeeCents: number, deltaCents: number) {
  return `网关手续费 ${actualFeeCents} 分，估算 ${estimatedFeeCents} 分，代理收益差额 ${deltaCents} 分`;
}

/**
 * audit 修正的业务事件键：L = 订单快照重算出的目标收益，E = 当前有效收益。
 * 状态不变时重复提交得到同一个键；差额写入后 E 变化，下一次真实差额得到新键。
 */
export function auditCorrectionEventKey(orderId: number, targetEarningCents: number, effectiveEarningCents: number) {
  return `audit:${orderId}:${targetEarningCents}:${effectiveEarningCents}`;
}
