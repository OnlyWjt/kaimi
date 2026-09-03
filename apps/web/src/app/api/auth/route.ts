import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession, loginUser, logoutUser, reissueSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { enforceRateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  action: z.literal("login"),
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

const passwordSchema = z.object({
  action: z.literal("change_password"),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export async function GET() {
  const session = await getSession();
  return NextResponse.json({
    user: session
      ? {
          username: session.username,
          role: session.role,
          agentId: session.agentId,
        }
      : null,
  });
}

export async function POST(req: Request) {
  const body: unknown = await req.json();
  if (
    typeof body === "object" &&
    body !== null &&
    "action" in body &&
    body.action === "logout"
  ) {
    await logoutUser();
    return NextResponse.json({ ok: true });
  }

  const login = loginSchema.safeParse(body);
  if (login.success) {
    const limited = enforceRateLimit(req, "auth-login", 10, 15 * 60_000);
    if (limited) return limited;
    const user = await loginUser(login.data.username, login.data.password);
    if (!user) {
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }
    return NextResponse.json({
      ok: true,
      username: user.username,
      role: user.role,
      redirectTo: user.role === "agent" ? "/agent" : "/admin",
    });
  }

  const password = passwordSchema.safeParse(body);
  if (password.success) {
    const limited = enforceRateLimit(
      req,
      "auth-change-password",
      10,
      15 * 60_000,
    );
    if (limited) return limited;
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    await bootDb();
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.id),
    });
    if (!user || !(await bcrypt.compare(password.data.currentPassword, user.passwordHash))) {
      return NextResponse.json({ error: "当前密码错误" }, { status: 400 });
    }
    const now = new Date().toISOString();
    await db
      .update(users)
      .set({
        passwordHash: await bcrypt.hash(password.data.newPassword, 10),
        passwordChangedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, session.id));
    // 改密码会让改动之前签发的会话全部作废，自己这条要换一张新的，
    // 其他设备上的登录态则按预期被踢掉。
    await reissueSession(session.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "请求参数错误" }, { status: 400 });
}
