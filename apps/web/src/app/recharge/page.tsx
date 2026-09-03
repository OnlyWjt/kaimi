import { SiteFooter, SiteHeader } from "@/components/site-header";
import { getSiteAppearance, getStorefront } from "@/lib/storefront";
import { RechargeForm } from "@/components/recharge-form";

export default async function RechargePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const sf = await getStorefront("recharge");
  const { buyCdkUrl } = await getSiteAppearance();
  const { code = "" } = await searchParams;
  return (
    <main data-theme={sf.themeId} className="min-h-screen">
      <SiteHeader siteName={sf.brandName} buyCdkUrl={buyCdkUrl} />
      <section className="km-shell-narrow space-y-8 pb-4">
        <div className="km-page-hero km-rise">
          <p className="km-eyebrow">开始兑换</p>
          <h1 className="km-page-title">{sf.siteName}</h1>
          <p className="km-lead">{sf.announcement || "先校验卡密识别套餐，再填写 Session 提交开通"}</p>
        </div>
        <RechargeForm initialCode={code} />
      </section>
      <SiteFooter note={sf.afterSales || undefined} />
    </main>
  );
}
