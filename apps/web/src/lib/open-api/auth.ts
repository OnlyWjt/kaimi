import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, apiKeys } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { hashLookupValue } from "@/lib/crypto";
import { clientIp, enforceRateLimitFor } from "@/lib/rate-limit";
import { openFail } from "./respond";

const lastUsedWriteAt = new Map<number, number>();

export type OpenApiScope =
  | "plans:read"
  | "orders:read"
  | "orders:write"
  | "cdks:read"
  | "cdks:reveal"
  | "redeem:write"
  | "redeem:read"
  | "earnings:read"
  | "agents:read";

export type ApiKeyContext = {
  id: number;
  ownerType: string;
  agentId: number | null;
  scopes: string[];
  ip: string;
};

export async function requireApiKey(req: Request, scope: OpenApiScope) {
  await bootDb();
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return openFail("UNAUTHORIZED", "缺少 API Key");
  const row = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, hashLookupValue(token)),
  });
  if (!row || row.status !== "active") return openFail("UNAUTHORIZED", "API Key 无效");
  if (row.expiresAt && row.expiresAt < new Date().toISOString()) {
    return openFail("UNAUTHORIZED", "API Key 已过期");
  }
  let scopes: string[] = [];
  let allowlist: string[] = [];
  try {
    scopes = JSON.parse(row.scopes);
    allowlist = JSON.parse(row.ipAllowlist);
  } catch {
    return openFail("UNAUTHORIZED", "API Key 配置损坏");
  }
  if (!scopes.includes(scope)) return openFail("FORBIDDEN_SCOPE", "API Key 没有该权限");
  if (row.ownerType === "agent") {
    if (!row.agentId) return openFail("UNAUTHORIZED", "API Key 无效");
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, row.agentId),
      columns: { status: true },
    });
    if (!agent || agent.status !== "active") {
      return openFail("UNAUTHORIZED", "API Key 无效");
    }
  }
  const ip = clientIp(req);
  if (allowlist.length && !allowlist.includes(ip)) {
    return openFail("FORBIDDEN_SCOPE", "来源 IP 不在白名单");
  }
  const limited = enforceRateLimitFor(`open:${row.id}`, row.rateLimitPerMin);
  if (limited) return openFail("RATE_LIMITED", "请求过于频繁");
  const nowMs = Date.now();
  const lastWrite = lastUsedWriteAt.get(row.id) || 0;
  if (nowMs - lastWrite >= 60_000) {
    lastUsedWriteAt.set(row.id, nowMs);
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(nowMs).toISOString(), lastUsedIp: ip })
      .where(eq(apiKeys.id, row.id));
  }
  const context: ApiKeyContext = {
    id: row.id,
    ownerType: row.ownerType,
    agentId: row.agentId,
    scopes,
    ip,
  };
  return context;
}

export function isApiKeyContext(value: unknown): value is ApiKeyContext {
  return !!value && typeof value === "object" && "ownerType" in value && "id" in value;
}
