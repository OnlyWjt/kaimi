import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { deriveSecretBytes } from "@/lib/crypto";
import { isSessionStale } from "@/lib/session-freshness";

const COOKIE = "kaimi_session";
const LEGACY_ADMIN_COOKIE = "kaimi_admin";

export type UserRole = "super_admin" | "agent";

export type AuthSession = {
  id: number;
  username: string;
  role: UserRole;
  agentId: number | null;
};

function secretKey() {
  return deriveSecretBytes("jwt-signing");
}

async function signSessionCookie(user: typeof users.$inferSelect) {
  const role = user.role as UserRole;
  const token = await new SignJWT({
    sub: String(user.id),
    username: user.username,
    role,
    agentId: user.agentId ?? null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  jar.delete(LEGACY_ADMIN_COOKIE);
}

/**
 * 改完密码要重新签发 cookie，否则新的 passwordChangedAt 会把自己这条会话
 * 也判成过期，等于改一次密码就把自己踢下线。
 */
export async function reissueSession(userId: number) {
  await bootDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.status !== "active") return false;
  await signSessionCookie(user);
  return true;
}

async function authenticate(
  username: string,
  password: string,
  requiredRole?: UserRole,
) {
  await bootDb();
  const normalized = username.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    where: eq(users.username, normalized),
  });
  if (!user || user.status !== "active") return null;
  if (requiredRole && user.role !== requiredRole) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  await signSessionCookie(user);
  await db
    .update(users)
    .set({ lastLoginAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(users.id, user.id));
  return user;
}

export function loginUser(username: string, password: string) {
  return authenticate(username, password);
}

export function loginAdmin(username: string, password: string) {
  return authenticate(username, password, "super_admin");
}

export async function logoutUser() {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(LEGACY_ADMIN_COOKIE);
}

export const logoutAdmin = logoutUser;

export async function getSession(): Promise<AuthSession | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value ?? jar.get(LEGACY_ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const id = Number(payload.sub);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    await bootDb();
    const user = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!user || user.status !== "active") return null;
    if (isSessionStale(user.passwordChangedAt, payload.iat)) return null;
    const role = user.role === "agent" ? "agent" : "super_admin";
    return {
      id: user.id,
      username: user.username,
      role,
      agentId: role === "agent" ? user.agentId : null,
    };
  } catch {
    return null;
  }
}

export async function getAdminSession() {
  const session = await getSession();
  return session?.role === "super_admin" ? session : null;
}

export async function requireAdmin() {
  const session = await getSession();
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (session.role !== "super_admin") {
    throw new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return session;
}

export async function requireAgent(): Promise<
  AuthSession & { role: "agent"; agentId: number }
> {
  const session = await getSession();
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (session.role !== "agent" || !session.agentId) {
    throw new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return { ...session, role: "agent", agentId: session.agentId };
}
