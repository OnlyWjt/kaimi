import { NextResponse } from "next/server";
import { bootDb, getAppConfig, setSetting } from "@/lib/config";
import { getDefaultCardplatformAccount } from "@/lib/cardplatform/config";
import {
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  requireAdmin,
} from "@/lib/auth";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET() {
  await bootDb();
  const cfg = await getAppConfig();
  const session = await getAdminSession();
  const card = await getDefaultCardplatformAccount();
  return NextResponse.json({
    setupCompleted: cfg.setupCompleted,
    hasCardplatform: Boolean(card),
    paymentMode: cfg.paymentMode,
    admin: session ? { username: session.username } : null,
  });
}

const setupSchema = z.object({
  paymentMode: z.enum(["manual"]).optional().default("manual"),
  adminUser: z.string().min(3).optional(),
  adminPassword: z.string().min(6).optional(),
});

export async function POST(req: Request) {
  await bootDb();
  const body = await req.json();
  const action = body?.action as string;

  if (action === "login") {
    const limited = enforceRateLimit(req, "legacy-admin-login", 10, 15 * 60_000);
    if (limited) return limited;
    const user = await loginAdmin(String(body.username || ""), String(body.password || ""));
    if (!user) return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    return NextResponse.json({ ok: true, username: user.username });
  }

  if (action === "logout") {
    await logoutAdmin();
    return NextResponse.json({ ok: true });
  }

  if (action === "setup") {
    try {
      await requireAdmin();
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    await setSetting("payment_mode", parsed.data.paymentMode);
    await setSetting("setup_completed", "1");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
