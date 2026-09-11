import { AgentSell } from "@/components/agent-sell";
import { listAgentConsolePlans, requireAgentId } from "@/lib/agent-console";
import { listAgentCoupons } from "@/lib/coupons";

export default async function AgentSellPage() {
  const agentId = await requireAgentId();
  const [plans, coupons] = await Promise.all([
    listAgentConsolePlans(agentId),
    listAgentCoupons(agentId),
  ]);
  return <AgentSell initialPlans={plans} initialCoupons={coupons} />;
}
