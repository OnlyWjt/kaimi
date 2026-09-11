import { AgentConsoleShell } from "@/components/agent-console-shell";
import { requireAgentConsoleProfile } from "@/lib/agent-console";

export default async function AgentLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireAgentConsoleProfile();
  return (
    <main data-theme={profile.themeId} className="km-themed-page">
      <AgentConsoleShell profile={profile}>{children}</AgentConsoleShell>
    </main>
  );
}
