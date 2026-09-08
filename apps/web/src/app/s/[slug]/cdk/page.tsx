import { AgentShopChrome } from "@/components/agent-shop-chrome";
import { CdkLookupForm } from "@/components/cdk-lookup-form";
import { loadAgentShopChrome } from "@/lib/agent-shop";

export default async function ShopCdkPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shop = await loadAgentShopChrome(slug, "/cdk");
  return (
    <AgentShopChrome shop={shop} active="cdk">
      <CdkLookupForm />
    </AgentShopChrome>
  );
}
