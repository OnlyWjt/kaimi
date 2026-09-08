import { getSetting } from "@/lib/config";
import {
  resolveAgentRedeemUrl,
  resolveShopRedeemUrl,
} from "@/lib/agent-redeem-core";
import { getPublicBaseUrl } from "@/lib/public-url";

export {
  DEFAULT_AGENT_REDEEM_URL,
  buildRechargePath,
  isExternalRedeemUrl,
  isPlatformRedeemPath,
  normalizeAgentRedeemUrl,
  resolveAgentRedeemUrl,
  resolveShopRedeemUrl,
  shopRedeemPath,
} from "@/lib/agent-redeem-core";

export async function getAgentRedeemUrl(slug?: string) {
  const [stored, selfBaseUrl] = await Promise.all([
    getSetting("agent_redeem_url", ""),
    getPublicBaseUrl(),
  ]);
  if (slug) return resolveShopRedeemUrl(stored, slug, selfBaseUrl);
  return resolveAgentRedeemUrl(stored, selfBaseUrl);
}
