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
          <p className="mt-2 text-sm leading-relaxed text-[var(--km-fg-muted)]">
            登录前先阅读本页。这里说明后台各功能如何使用，以及商店收益和提卡如何结算。登录后可在「使用说明」中查看更细的计算和常见问题。
          </p>
        </header>
        <AgentStartGuide />
      </section>
    </main>
  );
}
