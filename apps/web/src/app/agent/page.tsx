import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { AgentDashboard } from "@/components/agent-dashboard";
import { getSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";

export default async function AgentPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "agent" || !session.agentId) redirect("/admin");
  await bootDb();

  const [profile] = await db
    .select({
      username: users.username,
      displayName: agents.displayName,
      currentSlug: agents.currentSlug,
      themeId: agents.themeId,
    })
    .from(agents)
    .innerJoin(users, eq(users.agentId, agents.id))
    .where(eq(agents.id, session.agentId))
    .limit(1);
  if (!profile) redirect("/login");

  const themeId = resolveThemeId(profile.themeId);
  return (
    <main data-theme={themeId} className="km-themed-page">
      <section className="km-shell py-10">
        <AgentDashboard initialProfile={{ ...profile, themeId }} />
      </section>
    </main>
  );
}
