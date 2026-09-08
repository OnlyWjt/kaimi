import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AgentStorefrontSettings } from "@/components/agent-storefront-settings";
import { ApplyTheme } from "@/components/apply-theme";
import { getSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";

export default async function AgentStorefrontPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "agent" || !session.agentId) redirect("/admin");
  await bootDb();

  const [profile] = await db
    .select({
      currentSlug: agents.currentSlug,
      themeId: agents.themeId,
    })
    .from(agents)
    .where(eq(agents.id, session.agentId))
    .limit(1);
  if (!profile) redirect("/login");

  const themeId = resolveThemeId(profile.themeId);
  return (
    <main data-theme={themeId} className="km-themed-page">
      <ApplyTheme themeId={themeId} />
      <section className="km-shell space-y-6 py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="km-page-title">店铺装修</h1>
            <p className="mt-2 max-w-[56ch] text-sm text-[var(--km-fg-muted)]">
              买家在店铺首页看到的文案与模块都在这一页改。主题和店铺链接还在
              <Link className="mx-1 underline" href="/agent">
                我的店铺
              </Link>
              的「店铺外观与链接」里。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="km-btn"
              href={`/s/${profile.currentSlug}`}
              target="_blank"
              rel="noreferrer"
            >
              打开店铺
            </a>
            <Link href="/agent" className="km-btn km-btn-ghost">
              返回我的店铺
            </Link>
          </div>
        </header>
        <AgentStorefrontSettings />
      </section>
    </main>
  );
}
