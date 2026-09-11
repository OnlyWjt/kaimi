import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { type AgentConsoleProfile } from "@/lib/agent-console-core";
import { getAgentRedeemUrl } from "@/lib/agent-redeem";
import { getSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";

export type { AgentConsoleProfile };

export async function requireAgentConsoleProfile(): Promise<AgentConsoleProfile> {
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

  return {
    ...profile,
    themeId: resolveThemeId(profile.themeId),
    redeemUrl: await getAgentRedeemUrl(profile.currentSlug),
  };
}
