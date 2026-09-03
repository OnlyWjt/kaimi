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
import { yuanTextFromCents } from "@/lib/money";
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
      <section className="km-shell space-y-8 py-14">
        <header className="km-page-hero">
          <h1 className="km-page-title">{agent.displayName}</h1>
          <p className="km-lead">
            {agent.status !== "active"
              ? "店铺暂时关闭。"
              : salesGate.open
                ? "选一个套餐付款，到账后立刻发一张新卡密。"
                : salesGate.reason || "店铺暂时停止售卖。"}
          </p>
        </header>
        {agent.status === "active" && salesGate.open ? (
          sellablePlans.length ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {sellablePlans.map((plan) => (
                <article key={plan.planKey} className="km-panel km-panel-hover km-shop-card">
                  <div>
                    <h2
                      className="text-xl font-semibold"
                      style={{ fontFamily: "var(--font-sora)" }}
                    >
                      {plan.name}
                    </h2>
                    {plan.description ? (
                      <p className="mt-2 text-sm leading-6 text-[var(--km-fg-muted)]">
                        {plan.description}
                      </p>
                    ) : (
                      <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
                        付款成功后即时发卡
                      </p>
                    )}
                  </div>
                  <p className="text-3xl font-semibold tracking-tight">
                    ¥{yuanTextFromCents(plan.retailPriceCents)}
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
