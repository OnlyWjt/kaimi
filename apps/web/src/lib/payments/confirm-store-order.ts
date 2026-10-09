import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  backgroundJobs,
  paymentWebhookEvents,
  storeOrders,
} from "@/db/schema";
import { hashLookupValue } from "@/lib/crypto";
import { writeAuditLog } from "@/lib/audit";
import { sanitizeLog } from "@/lib/log";
import { notifyStoreInvoicePaid } from "@/lib/notify";
import { recordOpsAlert } from "@/lib/ops-health";
import { epayReady, getEpayConfig } from "@/lib/payments/config";
import { moneyYuan, parseMoneyYuan, queryEpayOrder } from "@/lib/payments/epay";

export type ConfirmPaidResult =
  | { kind: "missing" }
  | { kind: "rejected"; status: number; error: string }
  | {
      kind: "ok";
      order: typeof storeOrders.$inferSelect;
      newlyPaid: boolean;
    };

function webhookEventKey(orderNo: string, tradeNo: string, status: string) {
  return `${orderNo}:${tradeNo}:${status || "success"}`;
}

export async function confirmStoreOrderPaid(input: {
  orderNo: string;
  moneyYuan: string;
  tradeNo: string;
  rawParams?: Record<string, string>;
  recordWebhookEvent?: boolean;
}): Promise<ConfirmPaidResult> {
  const orderNo = input.orderNo.trim();
  const tradeNo = input.tradeNo.trim();
  if (!orderNo.startsWith("KS") || !tradeNo) {
    return { kind: "rejected", status: 400, error: "支付通知缺少订单号或流水号" };
  }

  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return { kind: "missing" };

  let paidCents: number;
  try {
    paidCents = parseMoneyYuan(input.moneyYuan);
  } catch {
    await writeAuditLog({
      action: "payment.notify.invalid_amount",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo },
    });
    return { kind: "rejected", status: 400, error: "支付通知金额无效" };
  }

  // 比的是整单总额，不是单价；一单多张时拿单价比会把正常付款当成金额不符。
  if (paidCents !== order.grossCents) {
    await db
      .update(storeOrders)
      .set({
        feeReconcileStatus: "manual_review",
        feeReconcileLastError: `支付通知金额不符：${paidCents}`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeOrders.id, order.id));
    await writeAuditLog({
      action: "payment.notify.amount_mismatch",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo, expectedCents: order.grossCents, paidCents },
    });
    await recordOpsAlert({
      level: "critical",
      code: "payment.notify.amount_mismatch",
      message: `订单 ${orderNo} 支付通知金额不符：到账 ${paidCents} 分，订单 ${order.grossCents} 分`,
    });
    return { kind: "rejected", status: 400, error: "支付通知金额不符" };
  }

  if (order.paymentTradeNo && order.paymentTradeNo !== tradeNo) {
    await writeAuditLog({
      action: "payment.notify.trade_mismatch",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo, receivedTradeNo: tradeNo },
    });
    return { kind: "rejected", status: 400, error: "支付流水号与订单不符" };
  }

  const now = new Date().toISOString();
  const rawParams = input.rawParams || {};
  const eventKey = webhookEventKey(
    orderNo,
    tradeNo,
    rawParams.trade_status || "success",
  );
  const payloadHash = hashLookupValue(
    JSON.stringify(
      Object.entries(rawParams)
        .filter(([key]) => key !== "sign")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );

  if (input.recordWebhookEvent !== false) {
    const existingEvent = await db.query.paymentWebhookEvents.findFirst({
      where: and(
        eq(paymentWebhookEvents.provider, "epay"),
        eq(paymentWebhookEvents.eventKey, eventKey),
      ),
    });
    if (existingEvent && existingEvent.payloadHash !== payloadHash) {
      await writeAuditLog({
        action: "payment.notify.payload_conflict",
        targetType: "store_order",
        targetId: order.id,
        metadata: { orderNo, tradeNo, eventKey },
      });
      return { kind: "rejected", status: 409, error: "支付通知内容冲突" };
    }
  }

  type TxOutcome =
    | { kind: "paid"; order: typeof storeOrders.$inferSelect }
    | { kind: "already_paid" }
    | { kind: "trade_mismatch"; current: typeof storeOrders.$inferSelect }
    | { kind: "unexpected_state"; current: typeof storeOrders.$inferSelect | undefined };

  const outcome: TxOutcome = await db.transaction(async (tx): Promise<TxOutcome> => {
    // 事务内重读，避免用事务外的旧快照判断 tradeNo / 状态。
    const current = await tx.query.storeOrders.findFirst({
      where: eq(storeOrders.id, order.id),
    });
    if (current?.paymentTradeNo && current.paymentTradeNo !== tradeNo) {
      return { kind: "trade_mismatch", current };
    }
    if (current?.payStatus === "paid" && current.paymentTradeNo === tradeNo) {
      // 同一流水的重复通知：幂等成功，不重复入队/通知。
      return { kind: "already_paid" };
    }
    if (current?.payStatus !== "unpaid") {
      return { kind: "unexpected_state", current };
    }
    if (input.recordWebhookEvent !== false) {
      await tx
        .insert(paymentWebhookEvents)
        .values({
          provider: "epay",
          eventKey,
          orderId: order.id,
          tradeNo,
          payloadHash,
          status: "processed",
          receivedAt: now,
          processedAt: now,
        })
        .onConflictDoNothing({
          target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventKey],
        });
    }
    const [updated] = await tx
      .update(storeOrders)
      .set({
        payStatus: "paid",
        paymentTradeNo: tradeNo,
        paidAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storeOrders.id, order.id),
          eq(storeOrders.payStatus, "unpaid"),
          or(
            isNull(storeOrders.paymentTradeNo),
            eq(storeOrders.paymentTradeNo, ""),
            eq(storeOrders.paymentTradeNo, tradeNo),
          ),
        ),
      )
      .returning();
    if (!updated) {
      const after = await tx.query.storeOrders.findFirst({
        where: eq(storeOrders.id, order.id),
      });
      if (after?.payStatus === "paid" && after.paymentTradeNo === tradeNo) {
        return { kind: "already_paid" };
      }
      return { kind: "unexpected_state", current: after };
    }
    await tx
      .insert(backgroundJobs)
      .values([
        {
          type: "fulfill_store_order",
          dedupeKey: `fulfill_store_order:${order.id}`,
          payloadJson: JSON.stringify({ orderId: order.id }),
          runAfter: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          type: "reconcile_payment_fee",
          dedupeKey: `reconcile_payment_fee:${order.id}`,
          payloadJson: JSON.stringify({ orderId: order.id }),
          runAfter: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing({ target: backgroundJobs.dedupeKey });
    return { kind: "paid", order: updated };
  });

  if (outcome.kind === "trade_mismatch") {
    await writeAuditLog({
      action: "payment.notify.trade_mismatch",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo, receivedTradeNo: tradeNo },
    });
    return { kind: "rejected", status: 400, error: "支付流水号与订单不符" };
  }
  if (outcome.kind === "unexpected_state") {
    // 已关闭/已退款/退款中的订单又收到付款，或并发写入了别的流水：可能重复收款，转人工。
    const currentStatus = outcome.current?.payStatus ?? "missing";
    await writeAuditLog({
      action: "payment.notify.unexpected_state",
      targetType: "store_order",
      targetId: order.id,
      metadata: {
        orderNo,
        tradeNo,
        paidCents,
        payStatus: currentStatus,
        currentTradeNo: outcome.current?.paymentTradeNo ?? null,
      },
    });
    await recordOpsAlert({
      level: "critical",
      code: `payment.notify.unexpected_state:${orderNo}`,
      message: `订单 ${orderNo} 在状态 ${currentStatus} 下收到付款（流水 ${tradeNo}），可能重复收款或已关闭订单收款，需人工处理`,
    }).catch((err) => {
      console.warn("[kaimi-pay] ops alert failed", sanitizeLog(err));
    });
    return {
      kind: "rejected",
      status: 409,
      error: "订单状态不允许确认收款，需人工处理",
    };
  }

  const newlyPaid = outcome.kind === "paid";
  const latest = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, order.id),
  });
  const paid = latest || (outcome.kind === "paid" ? outcome.order : order);
  if (newlyPaid && paid.invoiceNotifyStatus !== "sent") {
    void notifyStoreInvoicePaid(paid).catch((err) => {
      console.warn("[kaimi-notify] invoice paid skipped", sanitizeLog(err));
    });
  }
  return {
    kind: "ok",
    order: paid,
    newlyPaid,
  };
}

export async function confirmStoreOrderPaidFromGateway(orderNo: string) {
  const config = await getEpayConfig();
  if (!epayReady(config)) {
    return { kind: "rejected" as const, status: 503, error: "易支付未配置" };
  }
  const gateway = await queryEpayOrder(config, { outTradeNo: orderNo });
  if (!gateway.paid) {
    return { kind: "unpaid" as const };
  }
  if (gateway.outTradeNo !== orderNo) {
    await writeAuditLog({
      action: "payment.query.order_mismatch",
      targetType: "store_order",
      targetId: orderNo,
      metadata: { orderNo, gatewayOutTradeNo: gateway.outTradeNo },
    });
    return {
      kind: "rejected" as const,
      status: 502,
      error: "支付网关返回的订单号与查询不符",
    };
  }
  return confirmStoreOrderPaid({
    orderNo,
    moneyYuan: moneyYuan(gateway.moneyCents),
    tradeNo: gateway.tradeNo,
    recordWebhookEvent: false,
  });
}
