import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { readMailSettings } from "@/lib/mail";
import { issueAgentBindCode, unbindAgentTelegram } from "@/lib/telegram-bind";

const saveSchema = z.object({
  action: z.literal("save"),
  telegramNotifyEnabled: z.boolean(),
  mailDeliveryEnabled: z.boolean(),
  mailFromName: z.string().max(80),
  mailReplyTo: z.string().max(200),
});

function cleanDisplayName(value: string) {
  return value.replace(/[\r\n"]/g, "").trim();
}

function validReplyTo(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

async function snapshot(agentId: number) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return null;
  const mail = await readMailSettings();
  return {
    telegramBound: Boolean(agent.telegramChatId),
    telegramUsername: agent.telegramUsername,
    telegramNotifyEnabled: agent.telegramNotifyEnabled,
    mailDeliveryEnabled: agent.mailDeliveryEnabled,
    mailFromName: agent.mailFromName,
    mailReplyTo: agent.mailReplyTo,
    platformMailReady: mail.enabled && mail.orderEnabled && Boolean(mail.host),
  };
}

export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await snapshot(session.agentId));
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
  const body = await req.json().catch(() => ({}));
  if (body.action === "bind") {
    try {
      const issued = await issueAgentBindCode(session.agentId);
      return NextResponse.json(issued);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "生成绑定码失败" },
        { status: 400 },
      );
    }
  }
  if (body.action === "unbind") {
    await unbindAgentTelegram(session.agentId);
    return NextResponse.json(await snapshot(session.agentId));
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "通知设置不完整" }, { status: 400 });
  }
  if (!validReplyTo(parsed.data.mailReplyTo)) {
    return NextResponse.json({ error: "回复邮箱格式不对" }, { status: 400 });
  }
  await db
    .update(agents)
    .set({
      telegramNotifyEnabled: parsed.data.telegramNotifyEnabled,
      mailDeliveryEnabled: parsed.data.mailDeliveryEnabled,
      mailFromName: cleanDisplayName(parsed.data.mailFromName),
      mailReplyTo: parsed.data.mailReplyTo.trim(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, session.agentId));
  return NextResponse.json(await snapshot(session.agentId));
}
