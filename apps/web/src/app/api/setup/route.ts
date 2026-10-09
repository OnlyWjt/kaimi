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
import {
  clearLoginFailures,
  guardLoginAttempt,
  recordLoginFailure,
} from "@/lib/login-lockout";

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
});

export async function POST(req: Request) {
  await bootDb();
  const body: Record<string, unknown> | null = await req
    .json()
    .then((v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null))
    .catch(() => null);
  if (!body) return NextResponse.json({ error: "请求参数错误" }, { status: 400 });
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "login") {
    // admin 页面仍走这个入口；与 /api/auth 共用限流桶和用户名锁定
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const blocked = guardLoginAttempt(req, username);
    if (blocked) return blocked;
    const user = await loginAdmin(username, password);
    if (!user) {
      recordLoginFailure(username);
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }
    clearLoginFailures(username);
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
