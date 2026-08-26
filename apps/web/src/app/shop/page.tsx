import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { getStorefront, getSiteAppearance } from "@/lib/storefront";
import { ShopCatalog } from "@/components/shop-catalog";

export default async function ShopPage() {
  const sf = await getStorefront("shop");
  const { buyCdkUrl, shopEnabled } = await getSiteAppearance();
  return (
    <main data-theme={sf.themeId} className="min-h-screen">
      <SiteHeader siteName={sf.brandName} buyCdkUrl={buyCdkUrl} />
      <section className="km-shell space-y-8">
        <div className="km-page-hero km-rise">
          <p className="km-eyebrow">{shopEnabled ? "购买卡密" : "购卡"}</p>
          <h1 className="km-page-title">{sf.siteName}</h1>
          <p className="km-lead">
            {shopEnabled
              ? sf.announcement || sf.homeBanner || "选择套餐下单后即可获得卡密。"
              : "请先购买卡密，再到本站兑换开通。"}
          </p>
          {buyCdkUrl ? (
            <p className="text-sm text-[var(--km-fg-muted)]">
              <a className="underline" href={buyCdkUrl} target="_blank" rel="noopener noreferrer">
                前往购买
              </a>
            </p>
          ) : null}
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link href="/recharge" className="km-btn km-btn-pair">
              去兑换开通
            </Link>
            <Link href="/lookup" className="km-btn km-btn-ghost km-btn-pair">
              查询进度
            </Link>
          </div>
        </div>
        {shopEnabled ? <ShopCatalog /> : null}
      </section>
      <SiteFooter note={shopEnabled ? sf.afterSales || undefined : undefined} />
    </main>
  );
}
