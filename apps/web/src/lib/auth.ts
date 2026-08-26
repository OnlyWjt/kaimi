import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { adminUsers } from "@/db/schema";
import { bootDb } from "@/lib/config";

const COOKIE = "kaimi_admin";

function secretKey() {
  const raw = process.env.KAIMI_SECRET_KEY || "kaimi-dev-secret-change-me";
  return new TextEncoder().encode(raw);
}

export async function loginAdmin(username: string, password: string) {
  await bootDb();
  const user = await db.query.adminUsers.findFirst({
    where: eq(adminUsers.username, username),
  });
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  const token = await new SignJWT({ sub: String(user.id), username: user.username })
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
  return user;
}

export async function logoutAdmin() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getAdminSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return {
      id: Number(payload.sub),
      username: String(payload.username || ""),
    };
  } catch {
    return null;
  }
}

export async function requireAdmin() {
  const session = await getAdminSession();
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return session;
}
