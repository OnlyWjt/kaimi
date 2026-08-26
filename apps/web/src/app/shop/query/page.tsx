import { SiteFooter, SiteHeader } from "@/components/site-header";
import { ShopQueryForm } from "@/components/shop-query-form";
import { getSiteAppearance } from "@/lib/storefront";

export default async function ShopQueryPage() {
  const { siteName, themeId, buyCdkUrl } = await getSiteAppearance();
  return (
    <main data-theme={themeId} className="min-h-screen">
      <SiteHeader siteName={siteName} buyCdkUrl={buyCdkUrl} />
      <ShopQueryForm />
      <SiteFooter />
    </main>
  );
}
