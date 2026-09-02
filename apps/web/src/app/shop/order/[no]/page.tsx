import { SiteHeader } from "@/components/site-header";
import { StoreOrderResultPanel } from "@/components/store-order-result";
import { getSiteAppearance } from "@/lib/storefront";

export default async function ShopOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ no: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { no } = await params;
  const { token = "" } = await searchParams;
  const appearance = await getSiteAppearance();

  return (
    <main data-theme={appearance.themeId} className="min-h-screen pb-16">
      <SiteHeader siteName={appearance.siteName} buyCdkUrl={appearance.buyCdkUrl} />
      <section className="km-shell">
        <div className="km-page-hero km-rise">
          <p className="km-eyebrow">订单详情</p>
          <h1 className="km-page-title">订单 {no}</h1>
        </div>
        <StoreOrderResultPanel orderNo={no} token={token} />
      </section>
    </main>
  );
}
