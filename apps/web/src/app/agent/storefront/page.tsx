import { AgentShopIdentity } from "@/components/agent-shop-identity";
import { AgentStorefrontSettings } from "@/components/agent-storefront-settings";
import { requireAgentConsoleProfile } from "@/lib/agent-console";

export default async function AgentStorefrontPage() {
  const profile = await requireAgentConsoleProfile();
  return (
    <>
      <header className="km-acp-head">
        <div>
          <h1>店怎么给人看</h1>
          <p>主题、链接和装修文案都是「店」的事。改完主题可以直接在这一页预览。</p>
        </div>
        <div className="km-acp-tools">
          <a
            className="km-btn"
            href={`/s/${profile.currentSlug}`}
            target="_blank"
            rel="noreferrer"
          >
            打开店铺
          </a>
        </div>
      </header>
      <AgentShopIdentity initialSlug={profile.currentSlug} initialThemeId={profile.themeId} />
      <AgentStorefrontSettings />
    </>
  );
}
