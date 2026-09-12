import { redirect } from "next/navigation";
import { cache } from "react";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, agents, platformPlans, users } from "@/db/schema";
import { loadUnreadAnnouncement } from "@/lib/announcements";
import {
  type AgentConsoleProfile,
  type AgentPlanRow,
} from "@/lib/agent-console-core";
import { getAgentRedeemUrl } from "@/lib/agent-redeem";
import { getSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";

export type { AgentConsoleProfile };

export const requireAgentId = cache(async () => {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "agent" || !session.agentId) redirect("/admin");
  return session.agentId;
});

export async function listAgentConsolePlans(agentId: number): Promise<AgentPlanRow[]> {
  await bootDb();
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      maxRetailPriceCents: platformPlans.maxRetailPriceCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      retailPriceCents: agentPlanPrices.retailPriceCents,
      enabled: agentPlanPrices.enabled,
      cardplatformSellable: platformPlans.cardplatformSellable,
      fulfillmentKind: platformPlans.fulfillmentKind,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(and(eq(agentPlanPrices.agentId, agentId), eq(platformPlans.enabled, true)))
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));

  return rows.map((row) => ({
    planKey: row.planKey,
    name: row.name,
    costPriceCents: row.costOverrideCents ?? row.globalCostPriceCents,
    maxRetailPriceCents: row.maxRetailPriceCents,
    retailPriceCents: row.retailPriceCents,
    enabled: row.enabled,
    cardplatformSellable: row.cardplatformSellable,
    fulfillmentKind: row.fulfillmentKind,
  }));
}

export const requireAgentConsoleProfile = cache(async (): Promise<AgentConsoleProfile> => {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "agent" || !session.agentId) redirect("/admin");
  await bootDb();

  const [profile] = await db
    .select({
      username: users.username,
      displayName: agents.displayName,
      currentSlug: agents.currentSlug,
      themeId: agents.themeId,
    })
    .from(agents)
    .innerJoin(users, eq(users.agentId, agents.id))
    .where(eq(agents.id, session.agentId))
    .limit(1);
  if (!profile) redirect("/login");

  return {
    ...profile,
    themeId: resolveThemeId(profile.themeId),
    redeemUrl: await getAgentRedeemUrl(profile.currentSlug),
    unreadAnnouncement: await loadUnreadAnnouncement(session.agentId),
  };
});
