/**
 * 已结算收益的手续费更正（事务体）。路由只负责鉴权/审计/HTTP 映射，金额与幂等逻辑都在这里，
 * 这样测试能在内存 SQLite 上连同真实的 insertOrderAdjustment 一起跑。
 *
 * 口径：已结算的收益行永远不改。订单上的手续费金额字段要反映「最终定稿的真实口径」，
 * 使 audit 的目标收益 L（= recomputeStoredLedger(订单)）等于「收益行 + 全部有效 fee_correction」(= E)。
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  agentEarnings,
  paymentFeeReconciliations,
  storeOrders,
} from "../../db/schema";
import { recomputeStoredLedger, type LedgerResult } from "../order-ledger-core";
import {
  ReconciliationError,
  effectiveEarningCents,
  insertOrderAdjustment,
} from "../reconciliation";
import {
  AUDIT_FEE_REVIEW_PENDING_MESSAGE,
  auditCorrectionEventKey,
  feeCorrectionDelta,
  feeReviewEventKey,
  feeReviewReason,
} from "./fee-lock-core";

type Executor = Parameters<typeof insertOrderAdjustment>[0];

export type CorrectionResult = {
  deltaCents: number;
  replayed: boolean;
  adjustmentId: number | null;
};

export type SettledFeeReviewInput = {
  orderId: number;
  orderNo: string;
  earningId: number;
  decision: "accept_gateway" | "keep_estimate";
  status: "confirmed" | "unsupported";
  note: string;
  now: string;
  estimatedFeeCents: number;
  /** accept_gateway 时是网关手续费，keep_estimate 时是估算手续费。 */
  gatewayFee: number;
  /** 按 gatewayFee 用 computeOrderLedger 算出的订单口径（与 pending 分支同一输入）。 */
  ledger: LedgerResult;
};

/**
 * fee-review 的已结算分支（必须在事务内调用）。
 * - 条件更新订单：仍是 paid、未退款、feeReconcileStatus 仍为 manual_review，才定稿；
 * - accept_gateway：同一条更新把订单金额字段改成网关口径，随后写 fee_correction（差额 = L − E）。
 *   订单金额因此和「收益行 + 有效调整」一致，之后 audit 不会再算出反向差额；
 * - keep_estimate：不改金额、不写调整，只定稿状态；
 * - 调整写入失败（下界校验等）抛错，整个事务回滚，订单仍是 manual_review。
 */
export async function applySettledFeeReview(
  tx: Executor,
  input: SettledFeeReviewInput,
): Promise<CorrectionResult> {
  const current = await tx.query.agentEarnings.findFirst({
    where: eq(agentEarnings.id, input.earningId),
  });
  if (!current || current.status !== "settled") {
    throw new ReconciliationError("SNAPSHOT_CHANGED", "收益状态已变化，请刷新后再处理", 409);
  }
  const accept = input.decision === "accept_gateway";
  const [claimed] = await tx
    .update(storeOrders)
    .set({
      ...(accept
        ? {
            finalPaymentFeeCents: input.ledger.finalPaymentFeeCents,
            agentFeeCents: input.ledger.agentFeeCents,
            platformFeeCents: input.ledger.platformFeeCents,
            agentEarningCents: input.ledger.agentEarningCents,
            platformProfitCents: input.ledger.platformProfitCents,
          }
        : {}),
      feeReconcileStatus: input.status,
      feeReconcileLastError: input.note,
      feeReconciledAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(storeOrders.id, input.orderId),
        eq(storeOrders.feeReconcileStatus, "manual_review"),
        eq(storeOrders.payStatus, "paid"),
        isNull(storeOrders.refundedAt),
      ),
    )
    .returning({ id: storeOrders.id });
  if (!claimed) {
    throw new ReconciliationError("SNAPSHOT_CHANGED", "订单状态已变化，手续费没有改", 409);
  }
  if (!accept) return { deltaCents: 0, replayed: false, adjustmentId: null };

  const effective = await effectiveEarningCents(tx, input.orderId, current.earningCents);
  const deltaCents = feeCorrectionDelta(input.ledger.agentEarningCents, effective);
  if (deltaCents === 0) return { deltaCents: 0, replayed: false, adjustmentId: null };
  const record = await tx.query.paymentFeeReconciliations.findFirst({
    where: and(
      eq(paymentFeeReconciliations.orderId, input.orderId),
      eq(paymentFeeReconciliations.actualFeeCents, input.gatewayFee),
    ),
    orderBy: [desc(paymentFeeReconciliations.attemptNo)],
  });
  const { adjustment, replayed } = await insertOrderAdjustment(tx, {
    agentId: current.agentId,
    orderId: input.orderId,
    sourceEarningId: current.id,
    type: "fee_correction",
    amountCents: deltaCents,
    reason: feeReviewReason(input.gatewayFee, input.estimatedFeeCents, deltaCents),
    reference: input.orderNo,
    businessEventKey: feeReviewEventKey(input.orderId, {
      reconciliationId: record?.id ?? null,
      actualFeeCents: input.gatewayFee,
    }),
    now: input.now,
  });
  return { deltaCents, replayed, adjustmentId: adjustment.id };
}

/**
 * earnings/audit POST 的已结算分支（必须在事务内调用）。
 * 目标收益 L 来自订单字段，E 来自收益行 + 有效调整；手续费还待核对（manual_review）的订单，
 * 订单字段仍是旧值，此时按它写更正会把后面的 fee-review 结果冲回去，所以直接拒绝。
 */
export async function applyAuditCorrection(
  tx: Executor,
  input: {
    orderId: number;
    orderNo: string;
    earningId: number;
    /** 路由读订单时的 updatedAt，事务内要求没有被别处改过。 */
    expectedUpdatedAt: string;
    now: string;
  },
): Promise<CorrectionResult> {
  const currentOrder = await tx.query.storeOrders.findFirst({ where: eq(storeOrders.id, input.orderId) });
  const current = await tx.query.agentEarnings.findFirst({ where: eq(agentEarnings.id, input.earningId) });
  if (currentOrder?.feeReconcileStatus === "manual_review") {
    throw new ReconciliationError("FEE_REVIEW_PENDING", AUDIT_FEE_REVIEW_PENDING_MESSAGE, 409);
  }
  if (
    !currentOrder || currentOrder.payStatus !== "paid" || currentOrder.refundedAt != null ||
    currentOrder.updatedAt !== input.expectedUpdatedAt ||
    !current || current.status !== "settled"
  ) {
    throw new Error("订单或收益状态已变化");
  }
  const effective = await effectiveEarningCents(tx, input.orderId, current.earningCents);
  const target = recomputeStoredLedger(currentOrder).agentEarningCents;
  const delta = feeCorrectionDelta(target, effective);
  if (delta === 0) return { deltaCents: 0, replayed: false, adjustmentId: null };
  // 键里带 L 和 E：状态不变时重复提交命中同一条（replayed）；差额写入后 E 变了，
  // 下一次真实差额得到新键。
  const { adjustment, replayed } = await insertOrderAdjustment(tx, {
    agentId: current.agentId,
    orderId: input.orderId,
    sourceEarningId: current.id,
    type: "fee_correction",
    amountCents: delta,
    reason: "按订单快照修正已返佣收益",
    reference: input.orderNo,
    businessEventKey: auditCorrectionEventKey(input.orderId, target, effective),
    now: input.now,
  });
  return { deltaCents: delta, replayed, adjustmentId: adjustment.id };
}
