import { AgentStartGuide } from "@/components/agent-start-guide";
import { getSiteAppearance } from "@/lib/storefront";

export default async function AgentStartPage() {
  const appearance = await getSiteAppearance();
  return (
    <main data-theme={appearance.themeId} className="min-h-screen">
      <section className="km-shell max-w-3xl py-10 space-y-6">
        <header>
          <p className="km-eyebrow">{appearance.siteName}</p>
          <h1 className="km-page-title">代理快速上手</h1>
          <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
            平台把这个地址发给你就对了。登录后后台里还有更细的「使用说明」。
          </p>
        </header>
        <AgentStartGuide />
      </section>
    </main>
  );
}
