import { eq } from "drizzle-orm";
import { SiteHeader } from "@/components/site-header";
import { StoreOrderResultPanel } from "@/components/store-order-result";
import { db } from "@/db";
import { agents, storeOrders } from "@/db/schema";
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
  if (order) {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, order.agentId),
    });
    if (agent) themeId = resolveThemeId(agent.themeId);
  }

  return (
    <main data-theme={themeId} className="km-themed-page pb-16">
      <SiteHeader siteName={appearance.siteName} buyCdkUrl={appearance.buyCdkUrl} />
      <section className="km-shell">
        <div className="km-page-hero km-rise">
          <h1 className="km-page-title">订单 {no}</h1>
        </div>
        <StoreOrderResultPanel orderNo={no} token={token} />
      </section>
    </main>
  );
}
