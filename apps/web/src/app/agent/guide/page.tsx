import { AgentGuide } from "@/components/agent-guide";
import { requireAgentConsoleProfile } from "@/lib/agent-console";

export default async function AgentGuidePage() {
  const profile = await requireAgentConsoleProfile();
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>使用说明</h1>
          <p>
            {profile.displayName}，这里讲清楚你的店铺怎么开、钱怎么算、客户问你怎么答。
          </p>
        </div>
      </header>
      <AgentGuide slug={profile.currentSlug} />
    </>
  );
}
