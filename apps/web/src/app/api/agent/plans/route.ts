import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, platformPlans } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function GET() {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();

  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      description: platformPlans.description,
      coverUrl: platformPlans.coverUrl,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      retailPriceCents: agentPlanPrices.retailPriceCents,
      enabled: agentPlanPrices.enabled,
      cardplatformSellable: platformPlans.cardplatformSellable,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, session.agentId),
        eq(platformPlans.enabled, true),
      ),
    )
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));

  return NextResponse.json({
    list: rows.map((row) => ({
      planKey: row.planKey,
      name: row.name,
      description: row.description,
      coverUrl: row.coverUrl,
      costPriceCents: row.costOverrideCents ?? row.globalCostPriceCents,
      retailPriceCents: row.retailPriceCents,
      enabled: row.enabled,
      cardplatformSellable: row.cardplatformSellable,
    })),
  });
}
