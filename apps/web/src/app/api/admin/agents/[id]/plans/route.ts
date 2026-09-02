import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, platformPlans } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const agentId = Number((await context.params).id);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "代理 ID 无效" }, { status: 400 });
  }
  const plans = await db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      platformEnabled: platformPlans.enabled,
      cardplatformSellable: platformPlans.cardplatformSellable,
      enabled: agentPlanPrices.enabled,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      retailPriceCents: agentPlanPrices.retailPriceCents,
    })
    .from(platformPlans)
    .leftJoin(
      agentPlanPrices,
      and(
        eq(agentPlanPrices.planId, platformPlans.id),
        eq(agentPlanPrices.agentId, agentId),
      ),
    )
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));
  return NextResponse.json({
    list: plans.map((plan) => ({
      ...plan,
      enabled: plan.enabled ?? false,
      retailPriceCents:
        plan.retailPriceCents ??
        plan.costOverrideCents ??
        plan.globalCostPriceCents,
    })),
  });
}
