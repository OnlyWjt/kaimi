import { Suspense } from "react";
import { AgentShopChrome } from "@/components/agent-shop-chrome";
import { OrderLookupForm } from "@/components/order-lookup-form";
import { keepSearchPath, loadAgentShopChrome } from "@/lib/agent-shop";

export default async function ShopLookupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ orderNo?: string }>;
}) {
  const { slug } = await params;
  const { orderNo } = await searchParams;
  const shop = await loadAgentShopChrome(
    slug,
    keepSearchPath("/lookup", { orderNo }),
  );
  return (
    <AgentShopChrome shop={shop} active="lookup">
      <Suspense
        fallback={
          <div className="km-shell-narrow py-10">
            <div className="km-panel">加载中…</div>
          </div>
        }
      >
        <OrderLookupForm />
      </Suspense>
    </AgentShopChrome>
  );
}
