import { SiteFooter, SiteHeader } from "@/components/site-header";
import { getStorefront } from "@/lib/storefront";
import { RechargeSwitcher } from "@/components/recharge-switcher";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
import { looksLikeStoreQueryToken } from "@/lib/store-order-access";

export default async function RechargePage({
  searchParams,
}: {
  searchParams: Promise<{
    code?: string;
    order?: string;
    qt?: string;
    token?: string;
  }>;
}) {
  const sf = await getStorefront("recharge");
  const { code = "", order = "", qt = "", token = "" } = await searchParams;
  // 多张卡不走地址栏：只认单号加订单查询凭证，卡密由批量表单自己去订单接口取。
  const queryToken = looksLikeStoreQueryToken(qt)
    ? qt
    : looksLikeStoreQueryToken(token)
      ? token
      : "";
  const orderRef =
    order.trim() && queryToken
      ? { orderNo: order.trim(), queryToken }
      : undefined;
  const batchLimit = await getBatchRedeemLimit();
  return (
    <main data-theme={sf.themeId} className="min-h-screen">
      <SiteHeader siteName={sf.brandName} />
      <section className="km-shell-narrow space-y-8 pb-4">
        <div className="km-page-hero km-rise">
          <p className="km-eyebrow">开始兑换</p>
          <h1 className="km-page-title">{sf.siteName}</h1>
          <p className="km-lead">{sf.announcement || "先校验卡密识别套餐，再填写 Session 提交开通"}</p>
        </div>
        <RechargeSwitcher
          initialCode={code}
          batchLimit={batchLimit}
          orderRef={orderRef}
        />
      </section>
      <SiteFooter note={sf.afterSales || undefined} />
    </main>
  );
}
