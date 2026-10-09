import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { readMailSettings, saveMailSettings, sendTestMail } from "@/lib/mail";
import { isValidMailFrom } from "@/lib/mail-core";

const saveSchema = z.object({
  enabled: z.boolean(),
  orderEnabled: z.boolean(),
  starttls: z.boolean(),
  ssl: z.boolean(),
  host: z.string().max(200),
  port: z.string().max(6),
  user: z.string().max(200),
  password: z.string().max(200).optional(),
  from: z.string().max(200),
  fromName: z.string().max(80),
});

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  return NextResponse.json(await readMailSettings());
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const body = await req.json().catch(() => ({}));
  if (body.action === "test") {
    const to = String(body.to || "").trim();
    if (!to.includes("@")) return NextResponse.json({ error: "填写收件邮箱" }, { status: 400 });
    try {
      await sendTestMail(to);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "发送失败" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "邮件配置无效" }, { status: 400 });
  // saveMailSettings 对非法发件邮箱会 throw，这里先校验返回 400，避免变成 500
  if (!isValidMailFrom(parsed.data.from)) {
    return NextResponse.json({ error: "发件邮箱格式不正确" }, { status: 400 });
  }
  await saveMailSettings(parsed.data);
  return NextResponse.json({ ok: true });
}
