import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPlanPrices, agents, platformPlans } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const updateSchema = z.object({
  enabled: z.boolean(),
  costOverrideCents: z.number().int().min(0).nullable().optional(),
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

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; planKey: string }> },
) {
  const denied = await authorize();
  if (denied) return denied;
  await bootDb();

  const params = await context.params;
  const agentId = Number(params.id);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "代理 ID 无效" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const [agent, plan] = await Promise.all([
    db.query.agents.findFirst({ where: eq(agents.id, agentId) }),
    db.query.platformPlans.findFirst({
      where: eq(platformPlans.planKey, params.planKey),
    }),
  ]);
  if (!agent) return NextResponse.json({ error: "代理不存在" }, { status: 404 });
  if (!plan) return NextResponse.json({ error: "套餐不存在" }, { status: 404 });

  const existing = await db.query.agentPlanPrices.findFirst({
    where: and(
      eq(agentPlanPrices.agentId, agentId),
      eq(agentPlanPrices.planId, plan.id),
    ),
  });
  const values = {
    enabled: parsed.data.enabled,
    costOverrideCents: parsed.data.costOverrideCents ?? null,
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    await db
      .update(agentPlanPrices)
      .set(values)
      .where(eq(agentPlanPrices.id, existing.id));
  } else {
    await db.insert(agentPlanPrices).values({
      agentId,
      planId: plan.id,
      retailPriceCents:
        parsed.data.costOverrideCents ?? plan.globalCostPriceCents,
      ...values,
    });
  }
  return NextResponse.json({ ok: true });
}
