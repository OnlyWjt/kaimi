import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  backgroundJobs,
  paymentWebhookEvents,
  storeOrders,
} from "@/db/schema";
import { hashLookupValue } from "@/lib/crypto";
import { writeAuditLog } from "@/lib/audit";
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

  if (paidCents !== order.retailPriceCents) {
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
      metadata: { orderNo, expectedCents: order.retailPriceCents, paidCents },
    });
    await recordOpsAlert({
      level: "critical",
      code: "payment.notify.amount_mismatch",
      message: `订单 ${orderNo} 支付通知金额不符：到账 ${paidCents} 分，订单 ${order.retailPriceCents} 分`,
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

  await db.transaction(async (tx) => {
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
    await tx
      .update(storeOrders)
      .set({
        payStatus: "paid",
        paymentTradeNo: tradeNo || order.paymentTradeNo,
        paidAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(storeOrders.id, order.id), eq(storeOrders.payStatus, "unpaid")),
      );
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
  });

  const latest = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, order.id),
  });
  return {
    kind: "ok",
    order: latest || order,
    newlyPaid: order.payStatus === "unpaid",
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
  return confirmStoreOrderPaid({
    orderNo,
    moneyYuan: moneyYuan(gateway.moneyCents),
    tradeNo: gateway.tradeNo,
    recordWebhookEvent: false,
  });
}
