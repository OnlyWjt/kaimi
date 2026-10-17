import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  apiWebhookDeliveries,
  apiWebhookEndpoints,
  backgroundJobs,
  orders,
  storeOrders,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { redemptionRegionFields } from "./cdk-region";
import { checkWebhookUrl } from "./webhook-url";
import {
  isWebhookEvent,
  WEBHOOK_PING_EVENT,
  signWebhookBody,
  webhookBackoffMs,
  webhookEventForStatus,
  type WebhookEventName,
} from "./webhooks-core";

/** 给订阅了该事件的代理回调地址各排一条投递。沙箱订单也走这里，负载里 livemode=false。 */
export async function enqueueAgentWebhook(
  agentId: number,
  event: WebhookEventName,
  body: Record<string, unknown>,
) {
  const endpoints = await db
    .select()
    .from(apiWebhookEndpoints)
    .where(
      and(
        eq(apiWebhookEndpoints.agentId, agentId),
        eq(apiWebhookEndpoints.status, "active"),
      ),
    );
  const payload = JSON.stringify({ event, ...body });
  for (const endpoint of endpoints) {
    let events: string[] = [];
    try {
      events = JSON.parse(endpoint.events);
    } catch {
      events = [];
    }
    if (!events.includes(event)) continue;
    await queueDelivery(endpoint.id, event, payload);
  }
}

/** 写一条投递记录并排上第一次发送。返回投递 id。 */
async function queueDelivery(endpointId: number, event: string, payloadJson: string) {
  const now = new Date().toISOString();
  const [delivery] = await db
    .insert(apiWebhookDeliveries)
    .values({
      endpointId,
      event,
      payloadJson,
      attempt: 0,
      nextAttemptAt: now,
      createdAt: now,
    })
    .returning({ id: apiWebhookDeliveries.id });
  if (!delivery) return null;
  await db
    .insert(backgroundJobs)
    .values({
      type: "deliver_api_webhook",
      dedupeKey: `deliver_api_webhook:${delivery.id}:1`,
      payloadJson: JSON.stringify({ deliveryId: delivery.id }),
      maxAttempts: 1,
      runAfter: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: backgroundJobs.dedupeKey });
  return delivery.id;
}

/** 代理后台点「发送测试」：不看订阅，直接给这个地址推一条 ping。 */
export async function queueWebhookPing(endpointId: number) {
  const payload = JSON.stringify({
    event: WEBHOOK_PING_EVENT,
    message: "这是一条测试推送。收到并返回 2xx 说明回调地址和验签都通了。",
    sent_at: new Date().toISOString(),
  });
  return queueDelivery(endpointId, WEBHOOK_PING_EVENT, payload);
}

/** 原样重发一条历史投递。签名在发送时现算，时间戳是新的。 */
export async function redeliverWebhook(deliveryId: number) {
  const original = await db.query.apiWebhookDeliveries.findFirst({
    where: eq(apiWebhookDeliveries.id, deliveryId),
  });
  if (!original) return null;
  return queueDelivery(original.endpointId, original.event, original.payloadJson);
}

export async function enqueueRedemptionWebhook(orderNo: string) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
  });
  if (!order?.agentId) return;
  const event = webhookEventForStatus(order.fulfillStatus);
  if (!event) return;
  await enqueueAgentWebhook(order.agentId, event, {
    redemption_no: order.orderNo,
    status: order.fulfillStatus,
    message: order.message,
    plan_key: order.upstreamPlan,
    ...(await redemptionRegionFields(order.issuedCdkId)),
    created_at: order.createdAt,
  });
}

/**
 * 店铺销售订单的状态推送。负载里不带卡密，代理收到后用 GET /orders/{orderNo} 取。
 * 调用方在状态真正切换的那一次调用，重复推送由代理按 order_no + event 去重。
 */
export async function enqueueStoreOrderWebhook(
  orderId: number,
  event: "order.paid" | "order.delivered",
) {
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
  });
  if (!order) return;
  await enqueueAgentWebhook(order.agentId, event, {
    livemode: true,
    order_no: order.orderNo,
    pay_status: order.payStatus,
    fulfill_status: order.fulfillStatus,
    plan_key: order.planKeySnapshot,
    payment_country: order.paymentCountrySnapshot,
    product_name: order.productNameSnapshot,
    quantity: order.quantity,
    gross_cents: order.grossCents,
    currency: order.currency,
    customer_email: order.customerEmail,
    created_at: order.createdAt,
    paid_at: order.paidAt,
    delivered_at: order.deliveredAt,
  });
}

export async function deliverApiWebhook(deliveryId: number) {
  const delivery = await db.query.apiWebhookDeliveries.findFirst({
    where: eq(apiWebhookDeliveries.id, deliveryId),
  });
  if (!delivery || delivery.deliveredAt) return;
  const endpoint = await db.query.apiWebhookEndpoints.findFirst({
    where: eq(apiWebhookEndpoints.id, delivery.endpointId),
  });
  if (!endpoint || endpoint.status !== "active") return;
  const attempt = delivery.attempt + 1;
  const now = new Date();
  let lastStatus = 0;
  let lastError = "";
  try {
    const secret = decryptSecret(endpoint.secretEncrypted);
    // 每次投递都重新校验：登记后 DNS 可能被改指向内网
    const check = await checkWebhookUrl(endpoint.url);
    if (!check.ok) throw new Error(check.error);
    const response = await fetch(check.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kaimi-Event": delivery.event,
        "X-Kaimi-Signature": signWebhookBody(
          secret,
          delivery.payloadJson,
          Math.floor(now.getTime() / 1000),
        ),
      },
      body: delivery.payloadJson,
      // 不跟随跳转，防止公网地址 302 到内网；3xx 记为投递失败
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      lastError = `HTTP ${response.status}（不跟随重定向）`;
    } else if (!response.ok) {
      lastError = `HTTP ${response.status}`;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "投递失败";
  }
  const delivered = lastStatus >= 200 && lastStatus < 300;
  const delay = delivered ? null : webhookBackoffMs(attempt);
  const nextAt = delay ? new Date(now.getTime() + delay).toISOString() : null;
  await db
    .update(apiWebhookDeliveries)
    .set({
      attempt,
      lastStatus: lastStatus || null,
      lastError,
      deliveredAt: delivered ? now.toISOString() : null,
      nextAttemptAt: nextAt,
    })
    .where(eq(apiWebhookDeliveries.id, delivery.id));
  if (!delivered && nextAt) {
    await db
      .insert(backgroundJobs)
      .values({
        type: "deliver_api_webhook",
        dedupeKey: `deliver_api_webhook:${delivery.id}:${attempt + 1}`,
        payloadJson: JSON.stringify({ deliveryId: delivery.id }),
        maxAttempts: 1,
        runAfter: nextAt,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .onConflictDoNothing({ target: backgroundJobs.dedupeKey });
  }
}

export function newWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let body = "";
  for (const byte of bytes) body += "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36];
  return `whsec_${body}`;
}

export function storeWebhookSecret(secret: string) {
  return encryptSecret(secret);
}

export function parseWebhookEvents(raw: unknown): WebhookEventName[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isWebhookEvent))];
}

/** 投递记录保留 30 天。最慢的一次重试在建立后约 15 小时，30 天前的早已结束。 */
export const WEBHOOK_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneWebhookDeliveries(now = Date.now()) {
  const deleted = await db
    .delete(apiWebhookDeliveries)
    .where(lt(apiWebhookDeliveries.createdAt, new Date(now - WEBHOOK_DELIVERY_RETENTION_MS).toISOString()))
    .returning({ id: apiWebhookDeliveries.id });
  return deleted.length;
}
