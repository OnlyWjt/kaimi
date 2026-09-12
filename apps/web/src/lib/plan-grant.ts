import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, agents, platformPlans } from "@/db/schema";
import {
  GRANT_PLANS_SAVE_FIRST,
  formatGrantPlansToast,
  grantPlansLabel,
  nextGrantAction,
} from "@/lib/plan-grant-core";

export { GRANT_PLANS_SAVE_FIRST };

export type GrantPlansInput = {
  planKey?: string;
  planKeys?: string[];
  allEnabled?: boolean;
};

export type GrantPlansResult = {
  planKeys: string[];
  planNames: string[];
  grantedAgentCount: number;
  alreadyAgentCount: number;
  inserted: number;
  enabled: number;
  skipped: number;
  message: string;
};

function requestedKeys(input: GrantPlansInput) {
  const keys = [
    ...(input.planKey ? [input.planKey] : []),
    ...(input.planKeys ?? []),
  ]
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

export async function grantPlanToActiveAgents(
  input: GrantPlansInput,
): Promise<GrantPlansResult> {
  const catalog = await db.query.platformPlans.findMany();
  const byKey = new Map(catalog.map((plan) => [plan.planKey, plan]));
  const enabledCatalog = catalog.filter((plan) => plan.enabled);

  let targets = enabledCatalog;
  if (!input.allEnabled) {
    const keys = requestedKeys(input);
    if (keys.length === 0) {
      throw new Error("请指定要开放的套餐");
    }
    targets = [];
    for (const key of keys) {
      const plan = byKey.get(key);
      if (!plan) throw new Error("套餐不存在");
      if (!plan.enabled) throw new Error(GRANT_PLANS_SAVE_FIRST);
      targets.push(plan);
    }
  }

  if (targets.length === 0) {
    throw new Error(GRANT_PLANS_SAVE_FIRST);
  }

  const activeAgents = await db.query.agents.findMany({
    where: eq(agents.status, "active"),
  });
  const agentIds = activeAgents.map((agent) => agent.id);
  const planIds = targets.map((plan) => plan.id);
  const now = new Date().toISOString();

  let inserted = 0;
  let enabled = 0;
  let skipped = 0;
  const grantedAgents = new Set<number>();
  const alreadyAgents = new Set<number>();

  await db.transaction(async (tx) => {
    const existingRows =
      agentIds.length && planIds.length
        ? await tx
            .select()
            .from(agentPlanPrices)
            .where(
              and(
                inArray(agentPlanPrices.agentId, agentIds),
                inArray(agentPlanPrices.planId, planIds),
              ),
            )
        : [];
    const existingByPair = new Map(
      existingRows.map((row) => [`${row.agentId}:${row.planId}`, row]),
    );

    for (const agent of activeAgents) {
      let granted = false;
      let alreadyAll = true;
      for (const plan of targets) {
        const existing = existingByPair.get(`${agent.id}:${plan.id}`);
        const action = nextGrantAction(existing);
        if (action === "insert") {
          await tx.insert(agentPlanPrices).values({
            agentId: agent.id,
            planId: plan.id,
            enabled: true,
            costOverrideCents: null,
            retailPriceCents: plan.globalCostPriceCents,
            updatedAt: now,
          });
          inserted += 1;
          granted = true;
          alreadyAll = false;
        } else if (action === "enable" && existing) {
          await tx
            .update(agentPlanPrices)
            .set({ enabled: true, updatedAt: now })
            .where(eq(agentPlanPrices.id, existing.id));
          enabled += 1;
          granted = true;
          alreadyAll = false;
        } else {
          skipped += 1;
        }
      }
      if (granted) grantedAgents.add(agent.id);
      else if (alreadyAll) alreadyAgents.add(agent.id);
    }
  });

  const planNames = targets.map((plan) => plan.name);
  const grantedAgentCount = grantedAgents.size;
  const alreadyAgentCount = alreadyAgents.size;
  return {
    planKeys: targets.map((plan) => plan.planKey),
    planNames,
    grantedAgentCount,
    alreadyAgentCount,
    inserted,
    enabled,
    skipped,
    message: formatGrantPlansToast({
      planLabel: grantPlansLabel(planNames),
      grantedAgentCount,
      alreadyAgentCount,
    }),
  };
}
