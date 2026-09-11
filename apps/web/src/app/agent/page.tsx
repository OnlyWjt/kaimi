import { AgentOverview } from "@/components/agent-overview";
import { requireAgentId } from "@/lib/agent-console";
import { loadAgentOverview } from "@/lib/agent-overview";

export default async function AgentPage() {
  const snapshot = await loadAgentOverview(await requireAgentId());
  return <AgentOverview snapshot={snapshot} />;
}
