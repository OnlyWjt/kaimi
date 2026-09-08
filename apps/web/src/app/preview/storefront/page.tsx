import { AgentStorefront } from "@/components/agent-storefront";
import { DEMO_STOREFRONT_CONFIG } from "./demo";

export default function StorefrontPreviewPage() {
  return (
    <main className="km-themed-page">
      <AgentStorefront preview config={DEMO_STOREFRONT_CONFIG} channels={["alipay", "wxpay"]} />
    </main>
  );
}
