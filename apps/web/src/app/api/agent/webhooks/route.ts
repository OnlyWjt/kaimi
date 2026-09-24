import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiWebhookEndpoints } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  newWebhookSecret,
  parseWebhookEvents,
  storeWebhookSecret,
} from "@/lib/open-api/webhooks";
import { WEBHOOK_EVENTS } from "@/lib/open-api/webhooks-core";

const createSchema = z.object({
  url: z.string().url().max(300),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db
    .select({
      id: apiWebhookEndpoints.id,
      url: apiWebhookEndpoints.url,
      events: apiWebhookEndpoints.events,
      status: apiWebhookEndpoints.status,
      createdAt: apiWebhookEndpoints.createdAt,
    })
    .from(apiWebhookEndpoints)
    .where(eq(apiWebhookEndpoints.agentId, session.agentId))
    .orderBy(desc(apiWebhookEndpoints.id));
  return NextResponse.json({ list, events: WEBHOOK_EVENTS });
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "请填写 https 回调地址和事件" }, { status: 400 });
  }
  if (!parsed.data.url.startsWith("https://")) {
    return NextResponse.json({ error: "回调地址必须是 https" }, { status: 400 });
  }
  const events = parseWebhookEvents(parsed.data.events);
  const secret = newWebhookSecret();
  const [created] = await db
    .insert(apiWebhookEndpoints)
    .values({
      ownerType: "agent",
      agentId: session.agentId,
      url: parsed.data.url,
      secretEncrypted: storeWebhookSecret(secret),
      events: JSON.stringify(events),
    })
    .returning({ id: apiWebhookEndpoints.id });
  return NextResponse.json({ id: created?.id, secret });
}

export async function DELETE(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const id = Number(new URL(req.url).searchParams.get("id") || 0);
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  await db
    .update(apiWebhookEndpoints)
    .set({ status: "disabled" })
    .where(and(eq(apiWebhookEndpoints.id, id), eq(apiWebhookEndpoints.agentId, session.agentId)));
  return NextResponse.json({ ok: true });
}
