import { AgentShopChrome } from "@/components/agent-shop-chrome";
import { RechargeSwitcher } from "@/components/recharge-switcher";
import { keepSearchPath, loadAgentShopChrome } from "@/lib/agent-shop";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
import { looksLikeStoreQueryToken } from "@/lib/store-order-access";

const DEFAULT_HINT = "先校验卡密识别套餐，再填写 Session 提交开通";

export default async function ShopRechargePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    code?: string;
    order?: string;
    qt?: string;
    token?: string;
  }>;
}) {
  const { slug } = await params;
  const { code = "", order = "", qt = "", token = "" } = await searchParams;
  const shop = await loadAgentShopChrome(
    slug,
    keepSearchPath("/recharge", { code, order, qt, token }),
  );
  const queryToken = looksLikeStoreQueryToken(qt)
    ? qt
    : looksLikeStoreQueryToken(token)
      ? token
      : "";
  const orderRef =
    order.trim() && queryToken
      ? { orderNo: order.trim(), queryToken }
      : undefined;

  return (
    <AgentShopChrome shop={shop} active="redeem">
      <section className="km-shell-narrow km-rx-body">
        <div className="km-rx-hero km-rise">
          <h1>{shop.shopName}</h1>
          <p>{shop.announcement || DEFAULT_HINT}</p>
        </div>
        <RechargeSwitcher
          initialCode={code}
          batchLimit={await getBatchRedeemLimit()}
          orderRef={orderRef}
        />
      </section>
    </AgentShopChrome>
  );
}
