import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentSlugHistory, agents, users } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { validateAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";
import { isThemeId } from "@kaimi/themes";

const updateSchema = z.object({
  slug: z.string().trim().optional(),
  // 跟着 @kaimi/themes 走，新增主题不用再回来改这里。
  themeId: z.string().trim().refine(isThemeId, "主题不存在").optional(),
});

async function authorize() {
  try {
    return { session: await requireAgent(), denied: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, denied: error };
    throw error;
  }
}

export async function GET() {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();

  const [profile] = await db
    .select({
      id: agents.id,
      username: users.username,
      displayName: agents.displayName,
      status: agents.status,
      currentSlug: agents.currentSlug,
      themeId: agents.themeId,
      lastLoginAt: users.lastLoginAt,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.agentId, agents.id))
    .where(eq(agents.id, session.agentId))
    .limit(1);

  if (!profile) {
    return NextResponse.json({ error: "代理资料不存在" }, { status: 404 });
  }
  return NextResponse.json({
    profile: { ...profile, themeId: resolveThemeId(profile.themeId) },
  });
}

export async function PATCH(req: Request) {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();

  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "参数无效" }, { status: 400 });
  }
  const current = await db.query.agents.findFirst({
    where: eq(agents.id, session.agentId),
  });
  if (!current || current.status !== "active") {
    return NextResponse.json({ error: "代理账号不可用" }, { status: 403 });
  }

  let nextSlug = current.currentSlug;
  if (parsed.data.slug !== undefined) {
    const checked = validateAgentSlug(parsed.data.slug);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400 });
    }
    nextSlug = checked.slug;
  }
  const nextTheme = parsed.data.themeId
    ? resolveThemeId(parsed.data.themeId)
    : resolveThemeId(current.themeId);

  if (nextSlug !== current.currentSlug) {
    const occupiedAgent = await db.query.agents.findFirst({
      where: eq(agents.currentSlug, nextSlug),
    });
    if (occupiedAgent && occupiedAgent.id !== session.agentId) {
      return NextResponse.json({ error: "该店铺标识已被占用" }, { status: 409 });
    }
    const occupiedHistory = await db.query.agentSlugHistory.findFirst({
      where: eq(agentSlugHistory.slug, nextSlug),
    });
    if (occupiedHistory) {
      return NextResponse.json({ error: "该店铺标识已被占用" }, { status: 409 });
    }
  }

  try {
    await db.transaction(async (tx) => {
      if (nextSlug !== current.currentSlug) {
        await tx
          .insert(agentSlugHistory)
          .values({ agentId: session.agentId, slug: current.currentSlug });
      }
      await tx
        .update(agents)
        .set({
          currentSlug: nextSlug,
          themeId: nextTheme,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agents.id, session.agentId));
    });
  } catch (error) {
    if (/UNIQUE|unique/i.test(error instanceof Error ? error.message : String(error))) {
      return NextResponse.json({ error: "该店铺标识已被占用" }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true, slug: nextSlug, themeId: nextTheme });
}
