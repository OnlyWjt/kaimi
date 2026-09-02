import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { normalizeAgentSlug, validateAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";

const createSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(64),
  slug: z.string().trim().optional(),
  notes: z.string().trim().max(500).optional().default(""),
});

async function authorize() {
  try {
    await requireAdmin();
    return null;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

function uniqueFailure(error: unknown) {
  return /UNIQUE|unique/i.test(error instanceof Error ? error.message : String(error));
}

export async function GET() {
  const denied = await authorize();
  if (denied) return denied;
  await bootDb();

  const list = await db
    .select({
      id: agents.id,
      displayName: agents.displayName,
      status: agents.status,
      currentSlug: agents.currentSlug,
      notes: agents.notes,
      username: users.username,
      lastLoginAt: users.lastLoginAt,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.agentId, agents.id))
    .orderBy(desc(agents.id));

  return NextResponse.json({ list });
}

export async function POST(req: Request) {
  const denied = await authorize();
  if (denied) return denied;
  await bootDb();

  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const username = data.username.toLowerCase();
  const requestedSlug = data.slug || normalizeAgentSlug(username);
  let checked = validateAgentSlug(requestedSlug);
  if (!checked.ok && !data.slug) {
    checked = validateAgentSlug(`agent-${nanoid(8).toLowerCase()}`);
  }
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: 400 });
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          displayName: data.displayName,
          currentSlug: checked.slug,
          notes: data.notes,
        })
        .returning();
      if (!agent) throw new Error("代理创建失败");

      const [user] = await tx
        .insert(users)
        .values({
          username,
          passwordHash: await bcrypt.hash(data.password, 10),
          role: "agent",
          status: "active",
          agentId: agent.id,
        })
        .returning({ id: users.id, username: users.username });
      if (!user) throw new Error("代理登录账号创建失败");
      return { ...agent, username: user.username };
    });
    return NextResponse.json({ agent: created }, { status: 201 });
  } catch (error) {
    if (uniqueFailure(error)) {
      return NextResponse.json(
        { error: "用户名或店铺标识已被占用" },
        { status: 409 },
      );
    }
    throw error;
  }
}
