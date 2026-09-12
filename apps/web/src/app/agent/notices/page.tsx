import { AgentNotices } from "@/components/agent-notices";
import { loadAgentNotices } from "@/lib/announcements";
import { requireAgentId } from "@/lib/agent-console";

export default async function AgentNoticesPage() {
  const snapshot = await loadAgentNotices(await requireAgentId());
  return <AgentNotices snapshot={snapshot} />;
}
