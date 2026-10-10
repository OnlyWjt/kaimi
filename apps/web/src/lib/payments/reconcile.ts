import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarnings,
  paymentFeeReconciliations,
  storeOrders,
} from "@/db/schema";
import { getEpayConfig, epayReady } from "./config";
import { queryEpayOrder } from "./epay";
import { notifyOpsAlert } from "@/lib/notify";
import {
  computeOrderLedger,
  earningSnapshotFromOrder,
  isGatewayFeeAnomalous,
  ledgerInputFromOrder,
} from "@/lib/order-ledger-core";
import { LOCKED_EARNING_FEE_MESSAGE } from "./fee-lock-core";
import { writeOrderFee } from "./fee-lock-db";

/** 算出来是负收益：重试多少次都还是负的，直接转人工，不进退避阶梯。 */
class NegativeEarningError extends Error {}

function isGatewayFeeQueryUnsupported(message: string) {
  const text = message.toLowerCase();
  return (
    text.includes("no act") ||
    text.includes("not act") ||
    text.includes("act不存在") ||
    text.includes("不支持该接口") ||
    text.includes("不支持此接口")
  );
}

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
        ...earningSnapshotFromOrder(order),
        feeSource:
          order.feeReconcileStatus === "confirmed"
            ? "gateway_actual"
            : "configured_fallback",
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
    if (gateway.moneyCents !== order.grossCents) {
      throw new Error("网关订单金额不匹配");
    }

    const actualFee = gateway.actualFeeCents;
    const finalFee = actualFee ?? order.estimatedPaymentFeeCents;
    if (finalFee < 0 || finalFee > order.grossCents) {
      throw new Error("网关手续费金额异常");
    }
    if (
      actualFee !== null &&
      isGatewayFeeAnomalous(order.estimatedPaymentFeeCents, actualFee)
    ) {
      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx
          .update(storeOrders)
          .set({
            actualPaymentFeeCents: actualFee,
            feeReconcileStatus: "manual_review",
            feeReconcileAttempts: attemptNo,
            feeReconcileLastError: "网关手续费异常偏高，收益仍按估算",
            feeReconciledAt: now,
            updatedAt: now,
          })
          .where(eq(storeOrders.id, order.id));
        await tx
          .update(paymentFeeReconciliations)
          .set({
            gatewayTradeNo: gateway.tradeNo,
            actualFeeCents: actualFee,
            differenceCents: actualFee - order.estimatedPaymentFeeCents,
            status: "manual_review",
            errorMessage: "网关手续费异常偏高",
            finishedAt: now,
          })
          .where(eq(paymentFeeReconciliations.id, attempt.id));
      });
      await notifyOpsAlert(
        `${order.orderNo} 网关手续费 ${actualFee} 分，估算 ${order.estimatedPaymentFeeCents} 分，已转人工，收益未改`,
      );
      return await db.query.storeOrders.findFirst({
        where: eq(storeOrders.id, order.id),
      });
    }
    const ledger = computeOrderLedger(ledgerInputFromOrder(order), {
      gatewayFeeCents: finalFee,
    });
    const earning = ledger.agentEarningCents;
    // 网关手续费吃穿了毛利。createStoreOrder 和 recalculateEstimatedFees 都拦着不写负
    // 收益，这条路径以前没拦——负数会同时写进订单和收益表，再被结算拿去和别的单相抵。
    if (earning < 0) {
      throw new NegativeEarningError(
        `按网关手续费 ${finalFee} 分算出的代理收益为负，已转人工核对`,
      );
    }
    const status = gateway.feeSupported ? "confirmed" : "unsupported";
    const now = new Date().toISOString();
    let lockedForReview = false;
    await db.transaction(async (tx) => {
      // 收益未锁定（无收益行，或 pending 且未挂结算单）时才改订单金额；条件写在同一条
      // UPDATE 里，判断和写入不会被对账抢占拆开。
      const outcome = await writeOrderFee(tx, {
        orderId: order.id,
        reconcilableStatuses,
        actualFee,
        attemptNo,
        now,
        finalStatus: status,
        ledger,
      });
      const updatedOrder = outcome.kind === "applied";
      const lockedOrder = outcome.kind === "locked" ? outcome.status : undefined;
      lockedForReview = lockedOrder === "manual_review";
      await tx
        .update(paymentFeeReconciliations)
        .set({
          gatewayTradeNo: gateway.tradeNo,
          actualFeeCents: actualFee,
          differenceCents:
            actualFee === null
              ? null
              : actualFee - order.estimatedPaymentFeeCents,
          status: updatedOrder ? status : lockedOrder ?? "skipped",
          errorMessage: lockedForReview ? LOCKED_EARNING_FEE_MESSAGE : "",
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
            ...earningSnapshotFromOrder({
              ...order,
              agentFeeCents: ledger.agentFeeCents,
              finalPaymentFeeCents: ledger.finalPaymentFeeCents,
              agentEarningCents: ledger.agentEarningCents,
            }),
            feeSource: gateway.feeSupported
              ? "gateway_actual"
              : "configured_fallback",
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
    if (lockedForReview) {
      await notifyOpsAlert(
        `${order.orderNo} 网关手续费 ${actualFee ?? "-"} 分，估算 ${order.estimatedPaymentFeeCents} 分；${LOCKED_EARNING_FEE_MESSAGE}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "手续费对账失败";
    if (isGatewayFeeQueryUnsupported(message)) {
      const now = new Date().toISOString();
      const fallback = computeOrderLedger(ledgerInputFromOrder(order), {
        gatewayFeeCents: order.estimatedPaymentFeeCents,
      });
      let fallbackLocked = false;
      await db.transaction(async (tx) => {
        const outcome = await writeOrderFee(tx, {
          orderId: order.id,
          reconcilableStatuses,
          actualFee: null,
          attemptNo,
          now,
          finalStatus: "unsupported",
          ledger: fallback,
        });
        const updatedOrder = outcome.kind === "applied";
        const lockedOrder = outcome.kind === "locked" ? outcome.status : undefined;
        fallbackLocked = lockedOrder === "manual_review";
        await tx
          .update(paymentFeeReconciliations)
          .set({
            status: updatedOrder ? "unsupported" : lockedOrder ?? "skipped",
            errorMessage: (fallbackLocked
              ? `${LOCKED_EARNING_FEE_MESSAGE}；${message}`
              : message
            ).slice(0, 500),
            finishedAt: now,
          })
          .where(eq(paymentFeeReconciliations.id, attempt.id));
        if (!updatedOrder) return;
        await tx
          .update(agentEarnings)
          .set({
            ...earningSnapshotFromOrder({
              ...order,
              agentFeeCents: fallback.agentFeeCents,
              finalPaymentFeeCents: fallback.finalPaymentFeeCents,
              agentEarningCents: fallback.agentEarningCents,
            }),
            feeSource: "configured_fallback",
            updatedAt: now,
          })
          .where(
            and(
              eq(agentEarnings.orderId, order.id),
              eq(agentEarnings.status, "pending"),
              isNull(agentEarnings.settlementId),
            ),
          );
      });
      return await db.query.storeOrders.findFirst({
        where: eq(storeOrders.id, order.id),
      });
    }
    const manualReview =
      attemptNo >= 6 || error instanceof NegativeEarningError;
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
