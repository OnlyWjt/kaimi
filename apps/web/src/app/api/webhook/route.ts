import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { bootDb, getAppConfig } from "@/lib/config";
import { decryptSecret, verifyWebhookSignature } from "@/lib/crypto";
import { applyUpstreamStatus } from "@/lib/orders";
import { syncCdksFromUpstream } from "@/lib/inventory";

export const runtime = "nodejs";

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

  if (eventId) {
    const existed = await db.query.webhookEvents.findFirst({
      where: eq(webhookEvents.eventId, eventId),
    });
    if (existed) {
      return NextResponse.json({ ok: true, duplicated: true });
    }
    await db.insert(webhookEvents).values({
      eventId,
      eventType,
      payloadJson: rawBody.toString("utf8"),
    });
  }

  const data = (payload.data || {}) as Record<string, unknown>;

  // Recharge terminal events
  if (eventType.startsWith("recharge.") || data.request_id || data.status) {
    await applyUpstreamStatus({
      requestId: data.request_id ? String(data.request_id) : undefined,
      clientReference: data.client_reference ? String(data.client_reference) : undefined,
      status: data.status ? String(data.status) : undefined,
      message: data.message ? String(data.message) : undefined,
      cdkCode: data.cdk_code ? String(data.cdk_code) : undefined,
    });
  }

  // Stock / order delivered — pull unused codes
  if (
    eventType.includes("order") ||
    eventType.includes("cdk") ||
    eventType.includes("delivered")
  ) {
    try {
      await syncCdksFromUpstream();
    } catch {
      // non-fatal; agent can sync manually
    }
  }

  return NextResponse.json({ ok: true });
}
