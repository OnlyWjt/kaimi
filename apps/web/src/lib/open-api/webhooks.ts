import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  apiWebhookDeliveries,
  apiWebhookEndpoints,
  backgroundJobs,
  orders,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  signWebhookBody,
  webhookBackoffMs,
  webhookEventForStatus,
  type WebhookEventName,
} from "./webhooks-core";

export async function enqueueRedemptionWebhook(orderNo: string) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
  });
  if (!order?.agentId) return;
  const event = webhookEventForStatus(order.fulfillStatus);
  if (!event) return;
  const endpoints = await db
    .select()
    .from(apiWebhookEndpoints)
    .where(
      and(
        eq(apiWebhookEndpoints.agentId, order.agentId),
        eq(apiWebhookEndpoints.status, "active"),
      ),
    );
  const now = new Date().toISOString();
  const payload = JSON.stringify({
    event,
    redemption_no: order.orderNo,
    status: order.fulfillStatus,
    message: order.message,
    plan_key: order.upstreamPlan,
    created_at: order.createdAt,
  });
  for (const endpoint of endpoints) {
    let events: string[] = [];
    try {
      events = JSON.parse(endpoint.events);
    } catch {
      events = [];
    }
    if (!events.includes(event)) continue;
    const [delivery] = await db
      .insert(apiWebhookDeliveries)
      .values({
        endpointId: endpoint.id,
        event,
        payloadJson: payload,
        attempt: 0,
        nextAttemptAt: now,
        createdAt: now,
      })
      .returning({ id: apiWebhookDeliveries.id });
    if (!delivery) continue;
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
  }
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
    const response = await fetch(endpoint.url, {
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
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = response.status;
    if (!response.ok) lastError = `HTTP ${response.status}`;
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
  return raw.filter((item): item is WebhookEventName =>
    item === "redemption.succeeded" || item === "redemption.failed",
  );
}
