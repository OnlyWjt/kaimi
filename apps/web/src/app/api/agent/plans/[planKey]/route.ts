import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPlanPrices, platformPlans } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const updateSchema = z.object({
  retailPriceCents: z.number().int().min(0),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ planKey: string }> },
) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();

  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { planKey } = await context.params;
  const [assignment] = await db
    .select({
      id: agentPlanPrices.id,
      enabled: agentPlanPrices.enabled,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      planEnabled: platformPlans.enabled,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, session.agentId),
        eq(platformPlans.planKey, planKey),
      ),
    )
    .limit(1);

  if (!assignment || !assignment.enabled || !assignment.planEnabled) {
    return NextResponse.json({ error: "该套餐未向当前代理开放" }, { status: 404 });
  }
  const costPrice =
    assignment.costOverrideCents ?? assignment.globalCostPriceCents;
  if (parsed.data.retailPriceCents < costPrice) {
    return NextResponse.json(
      { error: `零售价不能低于代理成本价 ${costPrice} 分` },
      { status: 400 },
    );
  }

  await db
    .update(agentPlanPrices)
    .set({
      retailPriceCents: parsed.data.retailPriceCents,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentPlanPrices.id, assignment.id));

  return NextResponse.json({ ok: true });
}
