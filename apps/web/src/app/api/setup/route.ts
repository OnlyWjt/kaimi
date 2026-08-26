import { NextResponse } from "next/server";
import { bootDb, getAppConfig, setSetting } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { getAdminSession, loginAdmin, logoutAdmin } from "@/lib/auth";
import { z } from "zod";

export async function GET() {
  await bootDb();
  const cfg = await getAppConfig();
  const session = await getAdminSession();
  return NextResponse.json({
    setupCompleted: cfg.setupCompleted,
    hasUpstream: Boolean(cfg.upstreamBaseUrl && cfg.upstreamApiKey),
    paymentMode: cfg.paymentMode,
    admin: session ? { username: session.username } : null,
  });
}

const setupSchema = z.object({
  upstreamBaseUrl: z.string().url(),
  upstreamApiKey: z.string().min(8),
  webhookSecret: z.string().optional().default(""),
  paymentMode: z.enum(["manual"]).optional().default("manual"),
  adminUser: z.string().min(3).optional(),
  adminPassword: z.string().min(6).optional(),
});

export async function POST(req: Request) {
  await bootDb();
  const body = await req.json();
  const action = body?.action as string;

  if (action === "login") {
    const user = await loginAdmin(String(body.username || ""), String(body.password || ""));
    if (!user) return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    return NextResponse.json({ ok: true, username: user.username });
  }

  if (action === "logout") {
    await logoutAdmin();
    return NextResponse.json({ ok: true });
  }

  if (action === "setup") {
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;
    await setSetting("upstream_base_url", data.upstreamBaseUrl.replace(/\/+$/, ""));
    await setSetting("upstream_api_key", encryptSecret(data.upstreamApiKey));
    if (data.webhookSecret) {
      await setSetting("webhook_secret", encryptSecret(data.webhookSecret));
    }
    await setSetting("payment_mode", data.paymentMode);
    await setSetting("setup_completed", "1");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
