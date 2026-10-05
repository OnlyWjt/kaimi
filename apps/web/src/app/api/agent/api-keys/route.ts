import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { hashLookupValue } from "@/lib/crypto";
import { AGENT_SCOPES, isDrawScope } from "@/lib/open-api/scopes";
import { agentCanSeeDrawApi } from "@/lib/open-api/draw-access";

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
});

function newKey() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `km_live_${body}`;
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
  const list = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      status: apiKeys.status,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.agentId, session.agentId))
    .orderBy(desc(apiKeys.id));
  const canDraw = await agentCanSeeDrawApi(session.agentId);
  const scopes = canDraw ? AGENT_SCOPES : AGENT_SCOPES.filter((scope) => !isDrawScope(scope));
  return NextResponse.json({ list, scopes });
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
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }
  if (parsed.data.scopes.some((scope) => isDrawScope(scope)) && !(await agentCanSeeDrawApi(session.agentId))) {
    return NextResponse.json({ error: "还没有提卡权限，不能勾提卡接口" }, { status: 400 });
  }
  const token = newKey();
  const [created] = await db
    .insert(apiKeys)
    .values({
      ownerType: "agent",
      agentId: session.agentId,
      name: parsed.data.name,
      keyPrefix: token.slice(0, 16),
      keyHash: hashLookupValue(token),
      scopes: JSON.stringify(parsed.data.scopes),
      createdBy: session.id,
    })
    .returning({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix });
  await writeAuditLog({
    actor: session,
    action: "agent_api_key_create",
    targetType: "api_key",
    targetId: created?.id,
  });
  return NextResponse.json({ id: created?.id, keyPrefix: created?.keyPrefix, token });
}

export async function DELETE(req: Request) {
  let session;
  try {
    session = await requireAgent();
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
    .where(and(eq(apiKeys.id, id), eq(apiKeys.agentId, session.agentId)));
  await writeAuditLog({
    actor: session,
    action: "agent_api_key_revoke",
    targetType: "api_key",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
