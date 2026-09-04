import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { BatchRedeemForm } from "@/components/batch-redeem-form";
import { getSession } from "@/lib/auth";
import { getBatchRedeemLimit } from "@/lib/batch-redeem-limit";
import { bootDb } from "@/lib/config";
import { resolveThemeId } from "@/lib/storefront";

export default async function AgentBatchRedeemPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "agent" || !session.agentId) redirect("/admin");
  await bootDb();

  const [profile] = await db
    .select({
      displayName: agents.displayName,
      themeId: agents.themeId,
    })
    .from(agents)
    .where(eq(agents.id, session.agentId))
    .limit(1);
  if (!profile) redirect("/login");

  const batchLimit = await getBatchRedeemLimit();
  return (
    <main data-theme={resolveThemeId(profile.themeId)} className="km-themed-page">
      <section className="km-shell-narrow space-y-6 py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="km-page-title">批量兑换</h1>
            <p className="mt-2 max-w-[52ch] text-sm text-[var(--km-fg-muted)]">
              把要兑换的卡密粘进来，填一次账号就能一起开通。一次最多 {batchLimit} 张。
            </p>
          </div>
          <Link href="/agent" className="km-btn km-btn-ghost">
            返回我的店铺
          </Link>
        </header>
        <div className="km-panel space-y-2">
          <p className="text-sm font-medium">这个工具只兑换你手动粘进来的卡密</p>
          <p className="text-sm leading-relaxed text-[var(--km-fg-muted)]">
            用来帮卡在兑换页的客户走完流程，或者兑换你自己买的卡。
            「我的卡密」列表里的卡已经卖给客户了，兑换掉就等于把客户付过钱的东西用了，
            所以那边不提供批量兑换，这里也不读那个列表。
          </p>
        </div>
        <BatchRedeemForm limit={batchLimit} />
      </section>
    </main>
  );
}
