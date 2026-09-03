import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  agentSlugHistory,
  agents,
  paymentChannelConfigs,
  platformPlans,
} from "@/db/schema";
import { ApplyTheme } from "@/components/apply-theme";
import { StoreCheckout } from "@/components/store-checkout";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";
import { getStoreSalesGate } from "@/lib/ops-health";
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
  const plans =
    agent.status === "active" && salesGate.open
      ? await db
          .select({
            planKey: platformPlans.planKey,
            name: platformPlans.name,
            description: platformPlans.description,
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
  return (
    <main data-theme={themeId} className="km-themed-page">
      <ApplyTheme themeId={themeId} />
      <section className="km-shell space-y-8 py-12 md:py-16">
        <header className="mx-auto max-w-xl space-y-3 text-center">
          <h1 className="km-page-title">{agent.displayName}</h1>
          <p className="km-lead mx-auto">
            {agent.status !== "active"
              ? "店铺暂时关闭。"
              : salesGate.open
                ? "选套餐付款，到账后立刻发一张新卡密。"
                : salesGate.reason || "店铺暂时停止售卖。"}
          </p>
        </header>
        {agent.status === "active" && salesGate.open ? (
          <StoreCheckout
            slug={agent.currentSlug}
            plans={sellablePlans}
            channels={channels}
          />
        ) : null}
      </section>
    </main>
  );
}
