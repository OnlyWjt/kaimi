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
import { StoreCheckout } from "@/components/store-checkout";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { bootDb } from "@/lib/config";
import { getStoreSalesGate } from "@/lib/ops-health";
import { getSiteAppearance } from "@/lib/storefront";

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

  const appearance = await getSiteAppearance();
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
    <main data-theme={appearance.themeId} className="min-h-screen">
      <section className="km-shell space-y-8 py-12">
        <header className="km-page-hero">
          <p className="km-eyebrow">代理店铺</p>
          <h1 className="km-page-title">{agent.displayName}</h1>
          <p className="km-lead">
            {agent.status !== "active"
              ? "店铺暂时关闭。"
              : salesGate.open
                ? "选择套餐，付款成功后系统即时生成一张新卡密。"
                : salesGate.reason || "店铺暂时停止售卖。"}
          </p>
        </header>
        {agent.status === "active" && salesGate.open ? (
          sellablePlans.length ? (
            <div className="grid gap-4 md:grid-cols-3">
              {sellablePlans.map((plan) => (
                <article key={plan.planKey} className="km-panel space-y-3">
                  <div>
                    <h2 className="text-xl font-semibold">{plan.name}</h2>
                    {plan.description ? (
                      <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
                        {plan.description}
                      </p>
                    ) : null}
                  </div>
                  <p className="text-2xl font-semibold">
                    ¥{(plan.retailPriceCents / 100).toFixed(2)}
                  </p>
                  <StoreCheckout
                    slug={agent.currentSlug}
                    planKey={plan.planKey}
                    channels={channels}
                  />
                </article>
              ))}
            </div>
          ) : (
            <div className="km-panel text-center text-[var(--km-fg-muted)]">
              当前暂无可售套餐。
            </div>
          )
        ) : null}
      </section>
    </main>
  );
}
