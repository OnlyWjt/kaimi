import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, platformPlans } from "@/db/schema";
import { isApiKeyContext, requireApiKey, type ApiKeyContext } from "@/lib/open-api/auth";
import { openOk } from "@/lib/open-api/respond";

async function plansFor(auth: ApiKeyContext) {
  if (auth.ownerType === "agent" && auth.agentId) {
    const rows = await db
      .select({
        planKey: platformPlans.planKey,
        name: platformPlans.name,
        description: platformPlans.description,
        category: platformPlans.category,
        costCents: platformPlans.globalCostPriceCents,
        costOverrideCents: agentPlanPrices.costOverrideCents,
        retailPriceCents: agentPlanPrices.retailPriceCents,
      })
      .from(agentPlanPrices)
      .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
      .where(
        and(
          eq(agentPlanPrices.agentId, auth.agentId),
          eq(agentPlanPrices.enabled, true),
          eq(platformPlans.enabled, true),
        ),
      )
      .orderBy(asc(platformPlans.sortOrder));
    return rows.map((row) => ({
      plan_key: row.planKey,
      name: row.name,
      description: row.description,
      category: row.category,
      cost_cents: row.costOverrideCents ?? row.costCents,
      retail_price_cents: row.retailPriceCents,
      currency: "CNY",
    }));
  }
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      description: platformPlans.description,
      category: platformPlans.category,
      costCents: platformPlans.globalCostPriceCents,
    })
    .from(platformPlans)
    .where(eq(platformPlans.enabled, true))
    .orderBy(asc(platformPlans.sortOrder));
  return rows.map((row) => ({
    plan_key: row.planKey,
    name: row.name,
    description: row.description,
    category: row.category,
    cost_cents: row.costCents,
    currency: "CNY",
  }));
}

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "plans:read");
  if (!isApiKeyContext(auth)) return auth;
  return openOk({ plans: await plansFor(auth) });
}
