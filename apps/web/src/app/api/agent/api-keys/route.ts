import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { hashLookupValue } from "@/lib/crypto";
import { checkKeyInput } from "@/lib/open-api/key-input";
import { AGENT_SCOPES, isDrawScope } from "@/lib/open-api/scopes";
import { agentCanSeeDrawApi } from "@/lib/open-api/draw-access";

const allowlistSchema = z.array(z.string().max(64)).max(50).default([]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  mode: z.enum(["live", "test"]).optional(),
  ipAllowlist: allowlistSchema,
});

/** 编辑：名称、权限、白名单。正式/测试不能改，Key 前缀里写着呢。 */
const updateSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  ipAllowlist: allowlistSchema,
});

function parseList(raw: string) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function newKey(mode: "live" | "test") {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `km_${mode}_${body}`;
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
      ipAllowlist: apiKeys.ipAllowlist,
      mode: apiKeys.mode,
      status: apiKeys.status,
      lastUsedAt: apiKeys.lastUsedAt,
      lastUsedIp: apiKeys.lastUsedIp,
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
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }
  if (parsed.data.scopes.some((scope) => isDrawScope(scope)) && !(await agentCanSeeDrawApi(session.agentId))) {
    return NextResponse.json({ error: "还没有提卡权限，不能勾提卡接口" }, { status: 400 });
  }
  const mode = parsed.data.mode ?? "live";
  const checked = checkKeyInput({
    ownerType: "agent",
    mode,
    scopes: parsed.data.scopes,
    ipAllowlist: parsed.data.ipAllowlist,
  });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const token = newKey(mode);
  const [created] = await db
    .insert(apiKeys)
    .values({
      ownerType: "agent",
      agentId: session.agentId,
      name: parsed.data.name,
      keyPrefix: token.slice(0, 16),
      keyHash: hashLookupValue(token),
      scopes: JSON.stringify(checked.scopes),
      ipAllowlist: JSON.stringify(checked.ipAllowlist),
      mode,
      createdBy: session.id,
    })
    .returning({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix });
  await writeAuditLog({
    actor: session,
    action: "agent_api_key_create",
    targetType: "api_key",
    targetId: created?.id,
    metadata: { mode, scopes: checked.scopes, ipAllowlist: checked.ipAllowlist },
  });
  return NextResponse.json({ id: created?.id, keyPrefix: created?.keyPrefix, token, mode });
}

export async function PATCH(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }
  const row = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.id, parsed.data.id), eq(apiKeys.agentId, session.agentId)),
  });
  if (!row) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });
  if (row.status !== "active") return NextResponse.json({ error: "已吊销的 Key 不能修改" }, { status: 400 });
  const before = parseList(row.scopes);
  // 已经有的提卡权限可以留着；新加提卡权限得先开通提卡。
  const addedDraw = parsed.data.scopes.some((scope) => isDrawScope(scope) && !before.includes(scope));
  if (addedDraw && !(await agentCanSeeDrawApi(session.agentId))) {
    return NextResponse.json({ error: "还没有提卡权限，不能勾提卡接口" }, { status: 400 });
  }
  const checked = checkKeyInput({
    ownerType: "agent",
    mode: row.mode === "test" ? "test" : "live",
    scopes: parsed.data.scopes,
    ipAllowlist: parsed.data.ipAllowlist,
  });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  await db
    .update(apiKeys)
    .set({
      name: parsed.data.name,
      scopes: JSON.stringify(checked.scopes),
      ipAllowlist: JSON.stringify(checked.ipAllowlist),
    })
    .where(and(eq(apiKeys.id, row.id), eq(apiKeys.agentId, session.agentId)));
  await writeAuditLog({
    actor: session,
    action: "agent_api_key_update",
    targetType: "api_key",
    targetId: row.id,
    metadata: {
      before: { name: row.name, scopes: before, ipAllowlist: parseList(row.ipAllowlist) },
      after: { name: parsed.data.name, scopes: checked.scopes, ipAllowlist: checked.ipAllowlist },
    },
  });
  return NextResponse.json({ ok: true });
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
