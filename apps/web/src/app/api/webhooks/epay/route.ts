import { after, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  backgroundJobs,
  paymentWebhookEvents,
  storeOrders,
} from "@/db/schema";
import { bootDb } from "@/lib/config";
import { hashLookupValue } from "@/lib/crypto";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { epayReady, getEpayConfig } from "@/lib/payments/config";
import { parseMoneyYuan, verifyEpayNotify } from "@/lib/payments/epay";
import { writeAuditLog } from "@/lib/audit";
import { sanitizeLog } from "@/lib/log";
import { recordOpsAlert } from "@/lib/ops-health";

async function readParams(req: Request) {
  const params: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((value, key) => {
    params[key] = value;
  });
  if (req.method !== "GET") {
    const form = new URLSearchParams(await req.text());
    form.forEach((value, key) => {
      params[key] = value;
    });
  }
  return params;
}

function text(value: string, status = 200) {
  return new NextResponse(value, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handle(req: Request) {
  await bootDb();
  const config = await getEpayConfig();
  if (!epayReady(config)) return text("fail", 503);

  const params = await readParams(req);
  const verification = verifyEpayNotify(config, params);
  if (!verification.ok) {
    if (verification.error === "trade not success") return text("success");
    return text("fail", 400);
  }

  const orderNo = String(params.out_trade_no || "").trim();
  if (!orderNo.startsWith("KS")) return text("success");
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return text("success");

  let paidCents: number;
  try {
    paidCents = parseMoneyYuan(params.money);
  } catch {
    await writeAuditLog({
      action: "payment.notify.invalid_amount",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo },
    });
    return text("fail", 400);
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
    return text("fail", 400);
  }

  const tradeNo = String(params.trade_no || "").trim();
  if (!tradeNo) return text("fail", 400);
  if (
    order.paymentTradeNo &&
    tradeNo &&
    order.paymentTradeNo !== tradeNo
  ) {
    await writeAuditLog({
      action: "payment.notify.trade_mismatch",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo, receivedTradeNo: tradeNo },
    });
    return text("fail", 400);
  }
  const now = new Date().toISOString();
  const payloadHash = hashLookupValue(
    JSON.stringify(
      Object.entries(params)
        .filter(([key]) => key !== "sign")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  const eventKey = `${orderNo}:${tradeNo}:${params.trade_status || "success"}`;
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
    return text("fail", 409);
  }
  await db.transaction(async (tx) => {
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
        target: [
          paymentWebhookEvents.provider,
          paymentWebhookEvents.eventKey,
        ],
      });
    await tx
      .update(storeOrders)
      .set({
        payStatus: "paid",
        paymentTradeNo: tradeNo || order.paymentTradeNo,
        paidAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storeOrders.id, order.id),
          eq(storeOrders.payStatus, "unpaid"),
        ),
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

  after(async () => {
    await processBackgroundJobs(4).catch((error) => {
      console.error(
        `[store-order] background job failed order=${order.orderNo}`,
        sanitizeLog(error instanceof Error ? error.message : "unknown error"),
      );
    });
  });
  return text("success");
}

export const GET = handle;
export const POST = handle;
