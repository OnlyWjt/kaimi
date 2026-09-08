import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, agentStorefronts, agents, platformPlans } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  rowToSettings,
  settingsToRow,
  storefrontSettingsSchema,
} from "@/lib/agent-storefront-config";

async function authorize() {
  try {
    return { session: await requireAgent(), denied: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, denied: error };
    throw error;
  }
}

async function listAssignedPlans(agentId: number) {
  return db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, agentId),
        eq(agentPlanPrices.enabled, true),
        eq(platformPlans.enabled, true),
      ),
    )
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));
}

export async function GET() {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();

  const row = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, session.agentId),
  });
  return NextResponse.json({
    settings: rowToSettings(row),
    plans: await listAssignedPlans(session.agentId),
  });
}

export async function PATCH(req: Request) {
  const { session, denied } = await authorize();
  if (denied || !session) return denied;
  await bootDb();

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, session.agentId),
  });
  if (!agent || agent.status !== "active") {
    return NextResponse.json({ error: "代理账号不可用" }, { status: 403 });
  }

  const parsed = storefrontSettingsSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }

  const columns = settingsToRow(parsed.data);
  const now = new Date().toISOString();
  await db
    .insert(agentStorefronts)
    .values({ agentId: session.agentId, ...columns, updatedAt: now })
    .onConflictDoUpdate({
      target: agentStorefronts.agentId,
      set: { ...columns, updatedAt: now },
    });

  return NextResponse.json({ ok: true, settings: parsed.data });
}
