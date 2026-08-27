import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { bootDb, getAppConfig } from "@/lib/config";
import { decryptSecret, verifyWebhookSignature } from "@/lib/crypto";
import { applyUpstreamStatus } from "@/lib/orders";
import { importPurchaseFromWebhook } from "@/lib/purchase-sync";

export const runtime = "nodejs";
const EVENT_CLAIM_TTL_MS = 60_000;

export async function POST(req: Request) {
  await bootDb();
  const cfg = await getAppConfig();
  const secret = decryptSecret(cfg.webhookSecret);
  const rawBody = Buffer.from(await req.arrayBuffer());
  const timestamp = req.headers.get("x-webhook-timestamp") || "";
  const signature = req.headers.get("x-signature") || "";
  const eventIdHeader = req.headers.get("x-webhook-id") || "";
  const eventTypeHeader = req.headers.get("x-webhook-event") || "";

  if (!secret) {
    if (process.env.KAIMI_ALLOW_INSECURE_WEBHOOK !== "1") {
      return NextResponse.json(
        { error: "webhook secret not configured", reason: "missing_secret" },
        { status: 401 },
      );
    }
  } else {
    const check = verifyWebhookSignature({
      secret,
      timestamp,
      rawBody,
      signature,
    });
    if (!check.ok) {
      return NextResponse.json({ error: "invalid signature", reason: check.reason }, { status: 401 });
    }
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const eventId = String(payload.event_id || eventIdHeader || "");
  const eventType = String(payload.event_type || eventTypeHeader || "");

  const data = (payload.data || payload) as Record<string, unknown>;
  let claimed = false;

  if (eventId) {
    const existed = await db.query.webhookEvents.findFirst({
      where: eq(webhookEvents.eventId, eventId),
    });
    if (existed) {
      if (existed.eventType.startsWith("processing:")) {
        const claimedAt = Date.parse(existed.processedAt);
        if (
          Number.isFinite(claimedAt) &&
          Date.now() - claimedAt < EVENT_CLAIM_TTL_MS
        ) {
          return NextResponse.json(
            { ok: false, processing: true },
            { status: 503 },
          );
        }
        // A process can die after claiming an event. Reclaim stale rows so
        // a later upstream retry is not blocked forever.
        await db.delete(webhookEvents).where(eq(webhookEvents.eventId, eventId));
      } else {
        return NextResponse.json({ ok: true, duplicated: true });
      }
    }
    try {
      await db.insert(webhookEvents).values({
        eventId,
        eventType: `processing:${eventType}`,
        payloadJson: rawBody.toString("utf8"),
        processedAt: new Date().toISOString(),
      });
      claimed = true;
    } catch (err) {
      const raced = await db.query.webhookEvents.findFirst({
        where: eq(webhookEvents.eventId, eventId),
      });
      if (raced) {
        if (raced.eventType.startsWith("processing:")) {
          return NextResponse.json(
            { ok: false, processing: true },
            { status: 503 },
          );
        }
        return NextResponse.json({ ok: true, duplicated: true });
      }
      throw err;
    }
  }

  try {
    if (eventType.startsWith("order.")) {
      await importPurchaseFromWebhook(eventType, data);
    } else if (
      eventType.startsWith("recharge.") ||
      eventType.startsWith("batch.") ||
      data.request_id
    ) {
      await applyUpstreamStatus({
        requestId: data.request_id ? String(data.request_id) : undefined,
        clientReference: data.client_reference ? String(data.client_reference) : undefined,
        status: data.status ? String(data.status) : undefined,
        message: data.message ? String(data.message) : undefined,
        cdkCode: data.cdk_code ? String(data.cdk_code) : undefined,
      });
    }

    if (claimed && eventId) {
      await db
        .update(webhookEvents)
        .set({ eventType, processedAt: new Date().toISOString() })
        .where(eq(webhookEvents.eventId, eventId));
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    // The event row is a processing claim. Remove it on failure so the
    // upstream retry can claim and process the same event again.
    if (claimed && eventId) {
      try {
        await db.delete(webhookEvents).where(eq(webhookEvents.eventId, eventId));
      } catch (cleanupErr) {
        console.error("[kaimi-webhook] failed to release event claim", eventId, cleanupErr);
      }
    }
    console.error("[kaimi-webhook] processing failed", eventType, err);
    return NextResponse.json(
      { ok: false, error: "webhook processing failed" },
      { status: 503 },
    );
  }
}
