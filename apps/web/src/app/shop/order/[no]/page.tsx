import { eq } from "drizzle-orm";
import { ApplyTheme } from "@/components/apply-theme";
import { SiteHeader, type NavLink } from "@/components/site-header";
import { StoreOrderResultPanel } from "@/components/store-order-result";
import { db } from "@/db";
import { agentStorefronts, agents, storeOrders } from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { bootDb } from "@/lib/config";
import { getSiteAppearance, resolveThemeId } from "@/lib/storefront";

export default async function ShopOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ no: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { no } = await params;
  const { token = "" } = await searchParams;
  await bootDb();
  const appearance = await getSiteAppearance();
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, no),
  });
  let themeId = appearance.themeId;
  let siteName = appearance.siteName;
  let homeHref: string | undefined;
  let brandLetter: string | undefined;
  let links: NavLink[] | undefined;
  // 代理店铺的单：顶栏用代理的店名，导航回到这家店，买家不会被带到平台首页。
  if (order) {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, order.agentId),
    });
    if (agent) {
      themeId = resolveThemeId(agent.themeId);
      if (agent.currentSlug) {
        const storefront = await db.query.agentStorefronts.findFirst({
          where: eq(agentStorefronts.agentId, agent.id),
          columns: { logoLetter: true },
        });
        siteName = publicShopName(agent);
        homeHref = `/s/${agent.currentSlug}`;
        brandLetter = (storefront?.logoLetter || siteName.trim().charAt(0) || "K").toUpperCase();
        links = [
          { href: `/s/${agent.currentSlug}`, label: "返回店铺" },
          { href: `/s/${agent.currentSlug}/recharge`, label: "去兑换" },
        ];
      }
    }
  }

  return (
    <main data-theme={themeId} className="km-themed-page pb-16">
      <ApplyTheme themeId={themeId} />
      <SiteHeader siteName={siteName} homeHref={homeHref} brandLetter={brandLetter} links={links} />
      <section className="km-shell pt-8 md:pt-12">
        <StoreOrderResultPanel orderNo={no} token={token} />
      </section>
    </main>
  );
}
