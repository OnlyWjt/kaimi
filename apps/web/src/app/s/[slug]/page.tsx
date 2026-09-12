import { and, asc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  paymentChannelConfigs,
  platformPlans,
} from "@/db/schema";
import { AgentStorefront } from "@/components/agent-storefront";
import { ApplyTheme } from "@/components/apply-theme";
import { planToProduct, type StorefrontConfig } from "@/lib/agent-storefront-config";
import { getAgentRedeemUrl } from "@/lib/agent-redeem";
import { loadAgentShop } from "@/lib/agent-shop";
import { LOCAL_ACCOUNT_FULFILLMENT } from "@/lib/finished-account-core";
import { unusedFinishedAccountCounts } from "@/lib/finished-accounts";
import { getStoreSalesGate } from "@/lib/ops-health";
import { getMaxOrderQuantity } from "@/lib/store-quantity";

export default async function AgentStorePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug: rawSlug } = await params;
  const { agent, themeId, settings } = await loadAgentShop(rawSlug);
  const salesGate = await getStoreSalesGate();
  const open = agent.status === "active" && salesGate.open;

  const plans = open
    ? await db
        .select({
          planKey: platformPlans.planKey,
          name: platformPlans.name,
          description: platformPlans.description,
          category: platformPlans.category,
          fulfillmentKind: platformPlans.fulfillmentKind,
          retailPriceCents: agentPlanPrices.retailPriceCents,
          coverUrl: agentPlanPrices.coverUrl,
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
            or(
              eq(platformPlans.cardplatformSellable, true),
              eq(platformPlans.fulfillmentKind, LOCAL_ACCOUNT_FULFILLMENT),
            ),
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

  const unusedByPlan = await unusedFinishedAccountCounts(
    sellablePlans
      .filter((plan) => plan.fulfillmentKind === LOCAL_ACCOUNT_FULFILLMENT)
      .map((plan) => plan.planKey),
  );
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
          fulfillmentKind: plan.fulfillmentKind,
          available:
            plan.fulfillmentKind === LOCAL_ACCOUNT_FULFILLMENT
              ? (unusedByPlan.get(plan.planKey) || 0) > 0
              : true,
        },
        settings.productNames,
        plan.coverUrl,
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
        redeemUrl={await getAgentRedeemUrl(agent.currentSlug)}
      />
    </main>
  );
}
