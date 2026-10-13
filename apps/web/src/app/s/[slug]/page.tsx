import { AgentStorefront } from "@/components/agent-storefront";
import { ApplyTheme } from "@/components/apply-theme";
import { plansToProducts, type StorefrontConfig } from "@/lib/agent-storefront-config";
import { getAgentRedeemUrl } from "@/lib/agent-redeem";
import { publicShopName } from "@/lib/agent-names";
import { loadAgentShop } from "@/lib/agent-shop";
import { enabledPaymentChannels, loadAgentSellablePlans } from "@/lib/agent-catalog";
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

  const sellablePlans = open ? await loadAgentSellablePlans(agent.id) : [];

  // 店铺关闭 / 停售时保留原来的简版提示页，别把装修页面挂在没货的店上
  if (!open) {
    return (
      <main data-theme={themeId} className="km-themed-page">
        <ApplyTheme themeId={themeId} />
        <section className="km-shell space-y-8 py-12 md:py-16">
          <header className="mx-auto max-w-xl space-y-3 text-center">
            <h1 className="km-page-title">{publicShopName(agent)}</h1>
            <p className="km-lead mx-auto">
              {agent.status !== "active" ? "店铺暂时关闭。" : salesGate.publicReason}
            </p>
          </header>
        </section>
      </main>
    );
  }

  const channels = await enabledPaymentChannels();
  const config: StorefrontConfig = {
    ...settings,
    shopName: publicShopName(agent),
    themeId,
    products: plansToProducts(
      sellablePlans.map((plan) => ({
        planKey: plan.planKey,
        basePlanKey: plan.basePlanKey,
        paymentCountry: plan.paymentCountry,
        regionLabel: plan.regionLabel,
        regionCapable: plan.regionCapable,
        regionNote: plan.regionNote,
        sortOrder: plan.sortOrder,
        name: plan.name,
        description: plan.description,
        retailPriceCents: plan.retailPriceCents,
        category: plan.category,
        fulfillmentKind: plan.fulfillmentKind,
        available: plan.available,
      })),
      settings.productNames,
      Object.fromEntries(sellablePlans.map((plan) => [plan.planKey, plan.coverUrl])),
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
