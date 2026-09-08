import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  agentSlugHistory,
  agentStorefronts,
  agents,
  paymentChannelConfigs,
  platformPlans,
} from "@/db/schema";
import { AgentStorefront } from "@/components/agent-storefront";
import { ApplyTheme } from "@/components/apply-theme";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import {
  planToProduct,
  rowToSettings,
  type StorefrontConfig,
} from "@/lib/agent-storefront-config";
import { bootDb } from "@/lib/config";
import { getStoreSalesGate } from "@/lib/ops-health";
import { getMaxOrderQuantity } from "@/lib/store-quantity";
import { resolveThemeId } from "@/lib/storefront";

export default async function AgentStorePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await bootDb();
  const { slug: rawSlug } = await params;
  const slug = normalizeAgentSlug(rawSlug);
  const agent = await db.query.agents.findFirst({
    where: eq(agents.currentSlug, slug),
  });

  if (!agent) {
    const historical = await db.query.agentSlugHistory.findFirst({
      where: eq(agentSlugHistory.slug, slug),
    });
    if (historical) {
      const current = await db.query.agents.findFirst({
        where: eq(agents.id, historical.agentId),
      });
      if (current) redirect(`/s/${current.currentSlug}`);
    }
    notFound();
  }

  const themeId = resolveThemeId(agent.themeId);
  const salesGate = await getStoreSalesGate();
  const open = agent.status === "active" && salesGate.open;

  const plans = open
    ? await db
        .select({
          planKey: platformPlans.planKey,
          name: platformPlans.name,
          description: platformPlans.description,
          category: platformPlans.category,
          retailPriceCents: agentPlanPrices.retailPriceCents,
          globalCostPriceCents: platformPlans.globalCostPriceCents,
          costOverrideCents: agentPlanPrices.costOverrideCents,
        })
        .from(agentPlanPrices)
        .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
        .where(
          and(
            eq(agentPlanPrices.agentId, agent.id),
            eq(agentPlanPrices.enabled, true),
            eq(platformPlans.enabled, true),
            eq(platformPlans.cardplatformSellable, true),
          ),
        )
        .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id))
    : [];
  const sellablePlans = plans.filter(
    (plan) =>
      plan.retailPriceCents > 0 &&
      plan.retailPriceCents >=
        (plan.costOverrideCents ?? plan.globalCostPriceCents),
  );

  // 店铺关闭 / 停售时保留原来的简版提示页，别把装修页面挂在没货的店上
  if (!open) {
    return (
      <main data-theme={themeId} className="km-themed-page">
        <ApplyTheme themeId={themeId} />
        <section className="km-shell space-y-8 py-12 md:py-16">
          <header className="mx-auto max-w-xl space-y-3 text-center">
            <h1 className="km-page-title">{agent.displayName}</h1>
            <p className="km-lead mx-auto">
              {agent.status !== "active" ? "店铺暂时关闭。" : salesGate.publicReason}
            </p>
          </header>
        </section>
      </main>
    );
  }

  const settingsRow = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agent.id),
  });
  const channels = (
    await db.query.paymentChannelConfigs.findMany({
      where: eq(paymentChannelConfigs.enabled, true),
    })
  )
    .map((row) => row.channel)
    .filter(
      (channel): channel is "alipay" | "wxpay" =>
        channel === "alipay" || channel === "wxpay",
    );

  const settings = rowToSettings(settingsRow);
  const config: StorefrontConfig = {
    ...settings,
    shopName: agent.displayName,
    themeId,
    products: sellablePlans.map((plan) =>
      planToProduct(
        {
          planKey: plan.planKey,
          name: plan.name,
          description: plan.description,
          retailPriceCents: plan.retailPriceCents,
          category: plan.category,
        },
        settings.productNames,
      ),
    ),
  };

  return (
    <main data-theme={themeId} className="km-themed-page">
      <ApplyTheme themeId={themeId} />
      <AgentStorefront
        config={config}
        slug={agent.currentSlug}
        channels={channels}
        maxQuantity={await getMaxOrderQuantity()}
      />
    </main>
  );
}
