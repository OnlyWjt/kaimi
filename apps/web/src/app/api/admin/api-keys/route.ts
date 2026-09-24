import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, apiKeys } from "@/db/schema";
import { AGENT_SCOPES, OPEN_API_SCOPES } from "@/lib/open-api/scopes";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { hashLookupValue } from "@/lib/crypto";

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  ownerType: z.enum(["platform", "agent"]).default("platform"),
  agentId: z.number().int().positive().optional(),
  scopes: z.array(z.enum(OPEN_API_SCOPES)).min(1),
  rateLimitPerMin: z.number().int().min(1).max(600).optional(),
});

function newKey() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `km_live_${body}`;
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      ownerType: apiKeys.ownerType,
      agentId: apiKeys.agentId,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      status: apiKeys.status,
      rateLimitPerMin: apiKeys.rateLimitPerMin,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.id));
  return NextResponse.json({ list });
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数无效" }, { status: 400 });
  }
  if (parsed.data.ownerType === "agent") {
    if (!parsed.data.agentId) {
      return NextResponse.json({ error: "代理 Key 需要 agentId" }, { status: 400 });
    }
    const extra = parsed.data.scopes.filter((scope) => !(AGENT_SCOPES as readonly string[]).includes(scope));
    if (extra.length) {
      return NextResponse.json({ error: "代理 Key 不能包含该权限" }, { status: 400 });
    }
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, parsed.data.agentId),
      columns: { status: true },
    });
    if (!agent || agent.status !== "active") {
      return NextResponse.json({ error: "代理不存在或已停用" }, { status: 400 });
    }
  }
  const token = newKey();
  const [created] = await db
    .insert(apiKeys)
    .values({
      ownerType: parsed.data.ownerType,
      agentId: parsed.data.ownerType === "agent" ? parsed.data.agentId : null,
      name: parsed.data.name,
      keyPrefix: token.slice(0, 16),
      keyHash: hashLookupValue(token),
      scopes: JSON.stringify(parsed.data.scopes),
      rateLimitPerMin: parsed.data.rateLimitPerMin ?? 60,
      createdBy: session.id,
    })
    .returning({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix });
  await writeAuditLog({
    actor: session,
    action: "api_key_create",
    targetType: "api_key",
    targetId: created?.id,
  });
  return NextResponse.json({ id: created?.id, keyPrefix: created?.keyPrefix, token });
}

export async function DELETE(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const id = Number(new URL(req.url).searchParams.get("id") || 0);
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const now = new Date().toISOString();
  await db
    .update(apiKeys)
    .set({ status: "revoked", revokedAt: now })
    .where(eq(apiKeys.id, id));
  await writeAuditLog({
    actor: session,
    action: "api_key_revoke",
    targetType: "api_key",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
