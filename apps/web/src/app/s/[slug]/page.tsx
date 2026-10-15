import { AgentStorefront } from "@/components/agent-storefront";
import { ApplyTheme } from "@/components/apply-theme";
import { plansToProducts, type StorefrontConfig } from "@/lib/agent-storefront-config";
import { getAgentRedeemUrl } from "@/lib/agent-redeem";
import { publicShopName } from "@/lib/agent-names";
import { loadAgentShop } from "@/lib/agent-shop";
import { enabledPaymentChannels, loadAgentSellablePlans } from "@/lib/agent-catalog";
import { getStoreSalesGate } from "@/lib/ops-health";
import { agentContactGate, loadAgentContacts } from "@/lib/agent-contact";
import { afterSalesContacts, contactHref, contactTypeLabel } from "@/lib/agent-contact-core";
import { getMaxOrderQuantity } from "@/lib/store-quantity";

export default async function AgentStorePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug: rawSlug } = await params;
  const { agent, themeId, settings } = await loadAgentShop(rawSlug);
  const salesGate = await getStoreSalesGate();
  const contactBlocked = (await agentContactGate(agent.id)).state === "blocked";
  const open = agent.status === "active" && salesGate.open && !contactBlocked;

  const sellablePlans = open ? await loadAgentSellablePlans(agent.id) : [];

  // 店铺关闭 / 停售时保留原来的简版提示页，别把装修页面挂在没货的店上。
  // 但已经买过的人还得能去兑换、查进度、找到店主，不能只给一句「请稍后再来」。
  if (!open) {
    const active = agent.status === "active";
    const contacts = active
      ? afterSalesContacts(await loadAgentContacts(agent.id))
      : [];
    const redeemUrl = await getAgentRedeemUrl(agent.currentSlug);
    return (
      <main data-theme={themeId} className="km-themed-page">
        <ApplyTheme themeId={themeId} />
        <section className="km-shell space-y-8 py-12 md:py-16">
          <header className="mx-auto max-w-xl space-y-3 text-center">
            <h1 className="km-page-title">{publicShopName(agent)}</h1>
            <p className="km-lead mx-auto">
              {!active
                ? "店铺暂时关闭。"
                : contactBlocked
                  ? "店铺暂停接单，请稍后再来。"
                  : salesGate.publicReason}
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-3">
              <a href={redeemUrl} className="km-btn km-btn-pair">
                去兑换卡密
              </a>
              <a
                href={`/s/${encodeURIComponent(agent.currentSlug)}/lookup`}
                className="km-btn km-btn-ghost km-btn-pair"
              >
                查兑换进度
              </a>
            </div>
            <p className="pt-1 text-sm text-[var(--km-fg-muted)]">
              已经付过款的订单不受影响，订单页链接和发货邮件仍然有效。
            </p>
            {contacts.length ? (
              <ul className="space-y-1 pt-4 text-sm">
                {contacts.map((contact) => {
                  const label = contact.label.zh.trim() || contactTypeLabel(contact.type);
                  const href = contactHref(contact);
                  return (
                    <li key={`${contact.type}:${contact.value}`}>
                      <span className="text-[var(--km-fg-muted)]">{label}：</span>
                      {href ? (
                        <a href={href} className="underline" target="_blank" rel="noreferrer">
                          {contact.value.trim()}
                        </a>
                      ) : (
                        <span className="select-all">{contact.value.trim()}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
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
