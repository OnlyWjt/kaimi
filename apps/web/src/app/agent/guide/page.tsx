import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AgentGuide } from "@/components/agent-guide";
import { getSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";

export default async function AgentGuidePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "agent" || !session.agentId) redirect("/admin");
  await bootDb();

  const [profile] = await db
    .select({
      displayName: agents.displayName,
      currentSlug: agents.currentSlug,
      themeId: agents.themeId,
    })
    .from(agents)
    .where(eq(agents.id, session.agentId))
    .limit(1);
  if (!profile) redirect("/login");

  return (
    <main data-theme={resolveThemeId(profile.themeId)} className="km-themed-page">
      <section className="km-shell py-10 space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="km-page-title">使用说明</h1>
            <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
              {profile.displayName}，这里讲清楚你的店铺怎么开、钱怎么算、客户问你怎么答。
            </p>
          </div>
          <Link href="/agent" className="km-btn km-btn-ghost">
            返回我的店铺
          </Link>
        </header>
        <AgentGuide slug={profile.currentSlug} />
      </section>
    </main>
  );
}
