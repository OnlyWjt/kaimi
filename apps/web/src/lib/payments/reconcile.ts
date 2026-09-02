import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarnings,
  paymentFeeReconciliations,
  storeOrders,
} from "@/db/schema";
import { getEpayConfig, epayReady } from "./config";
import { queryEpayOrder } from "./epay";
import { calculateAgentEarningCents } from "./fees";

export async function reconcilePaymentFee(
  orderId: number,
  options: { allowManualReview?: boolean } = {},
) {
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
  });
  if (!order || order.payStatus !== "paid") return null;
  if (
    order.feeReconcileStatus === "confirmed" ||
    order.feeReconcileStatus === "unsupported"
  ) {
    await db
      .update(agentEarnings)
      .set({
        paymentFeeCents: order.finalPaymentFeeCents,
        feeSource:
          order.feeReconcileStatus === "confirmed"
            ? "gateway_actual"
            : "configured_fallback",
        earningCents: order.agentEarningCents,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(agentEarnings.orderId, order.id),
          eq(agentEarnings.status, "pending"),
          isNull(agentEarnings.settlementId),
        ),
      );
    return order;
  }
  const reconcilableStatuses = options.allowManualReview
    ? ["pending", "retrying", "manual_review"]
    : ["pending", "retrying"];
  if (!reconcilableStatuses.includes(order.feeReconcileStatus)) return order;

  const startedAt = new Date().toISOString();
  let attempt;
  try {
    attempt = await db.transaction(async (tx) => {
      const [{ nextAttempt }] = await tx
        .select({
          nextAttempt: sql<number>`coalesce(max(${paymentFeeReconciliations.attemptNo}), 0) + 1`,
        })
        .from(paymentFeeReconciliations)
        .where(eq(paymentFeeReconciliations.orderId, order.id));
      const [reserved] = await tx
        .insert(paymentFeeReconciliations)
        .values({
          orderId: order.id,
          attemptNo: Number(nextAttempt || 1),
          gatewayTradeNo: order.paymentTradeNo || "",
          estimatedFeeCents: order.estimatedPaymentFeeCents,
          status: "running",
          startedAt,
        })
        .returning();
      if (!reserved) throw new Error("手续费对账任务创建失败");
      return reserved;
    });
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) return order;
    throw error;
  }
  const attemptNo = attempt.attemptNo;

  try {
    const config = await getEpayConfig();
    if (!epayReady(config)) throw new Error("易支付未配置");
    const gateway = await queryEpayOrder(config, {
      outTradeNo: order.orderNo,
      tradeNo: order.paymentTradeNo || undefined,
    });
    if (!gateway.paid) throw new Error("网关订单尚未支付");
    if (gateway.outTradeNo && gateway.outTradeNo !== order.orderNo) {
      throw new Error("网关商户订单号不匹配");
    }
    if (gateway.moneyCents !== order.retailPriceCents) {
      throw new Error("网关订单金额不匹配");
    }

    const actualFee = gateway.actualFeeCents;
    const finalFee = actualFee ?? order.estimatedPaymentFeeCents;
    if (finalFee < 0 || finalFee > order.retailPriceCents) {
      throw new Error("网关手续费金额异常");
    }
    const earning = calculateAgentEarningCents(
      order.retailPriceCents,
      order.agentCostCents,
      finalFee,
    );
    const status = gateway.feeSupported ? "confirmed" : "unsupported";
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      const [updatedOrder] = await tx
        .update(storeOrders)
        .set({
          actualPaymentFeeCents: actualFee,
          finalPaymentFeeCents: finalFee,
          agentEarningCents: earning,
          feeReconcileStatus: status,
          feeReconcileAttempts: attemptNo,
          feeReconcileLastError: "",
          feeReconciledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            inArray(storeOrders.feeReconcileStatus, reconcilableStatuses),
          ),
        )
        .returning();
      await tx
        .update(paymentFeeReconciliations)
        .set({
          gatewayTradeNo: gateway.tradeNo,
          actualFeeCents: actualFee,
          differenceCents:
            actualFee === null
              ? null
              : actualFee - order.estimatedPaymentFeeCents,
          status: updatedOrder ? status : "skipped",
          responseSummaryJson: JSON.stringify({
            paid: gateway.paid,
            tradeNo: gateway.tradeNo,
            outTradeNo: gateway.outTradeNo,
            channel: gateway.channel,
            moneyCents: gateway.moneyCents,
            feeSupported: gateway.feeSupported,
          }),
          finishedAt: now,
        })
        .where(eq(paymentFeeReconciliations.id, attempt.id));
      if (updatedOrder) {
        await tx
          .update(agentEarnings)
          .set({
            paymentFeeCents: finalFee,
            feeSource: gateway.feeSupported
              ? "gateway_actual"
              : "configured_fallback",
            earningCents: earning,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentEarnings.orderId, order.id),
              eq(agentEarnings.status, "pending"),
              isNull(agentEarnings.settlementId),
            ),
          );
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "手续费对账失败";
    const manualReview = attemptNo >= 6;
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(paymentFeeReconciliations)
        .set({
          status: manualReview ? "manual_review" : "retrying",
          errorMessage: message.slice(0, 500),
          finishedAt: now,
        })
        .where(eq(paymentFeeReconciliations.id, attempt.id));
      await tx
        .update(storeOrders)
        .set({
          feeReconcileStatus: manualReview ? "manual_review" : "retrying",
          feeReconcileAttempts: attemptNo,
          feeReconcileLastError: message.slice(0, 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            inArray(storeOrders.feeReconcileStatus, reconcilableStatuses),
          ),
        );
    });
  }
  return await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, order.id),
  });
}

export async function reconcilePendingPaymentFees(limit = 20) {
  const rows = await db.query.storeOrders.findMany({
    where: and(
      eq(storeOrders.payStatus, "paid"),
      inArray(storeOrders.feeReconcileStatus, ["pending", "retrying"]),
    ),
    orderBy: [asc(storeOrders.paidAt)],
    limit: Math.max(1, Math.min(limit, 100)),
  });
  let reconciled = 0;
  let checked = 0;
  const retryDelaysMs = [
    0,
    60_000,
    5 * 60_000,
    30 * 60_000,
    2 * 60 * 60_000,
    12 * 60 * 60_000,
  ];
  for (const order of rows) {
    const last = await db.query.paymentFeeReconciliations.findFirst({
      where: eq(paymentFeeReconciliations.orderId, order.id),
      orderBy: [desc(paymentFeeReconciliations.attemptNo)],
    });
    if (last?.finishedAt) {
      const delay =
        retryDelaysMs[
          Math.min(last.attemptNo, retryDelaysMs.length - 1)
        ] ?? retryDelaysMs[retryDelaysMs.length - 1]!;
      if (Date.now() - new Date(last.finishedAt).getTime() < delay) continue;
    }
    checked += 1;
    const result = await reconcilePaymentFee(order.id);
    if (
      result?.feeReconcileStatus === "confirmed" ||
      result?.feeReconcileStatus === "unsupported"
    ) {
      reconciled += 1;
    }
  }
  return { checked, reconciled };
}
