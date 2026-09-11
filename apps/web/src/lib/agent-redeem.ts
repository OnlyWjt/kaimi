import { getSetting } from "@/lib/config";
import {
  isPlatformRedeemPath,
  resolveAgentRedeemUrl,
  resolveShopRedeemUrl,
  shopRedeemPath,
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
  const stored = await getSetting("agent_redeem_url", "");
  const resolved = resolveAgentRedeemUrl(stored);
  if (slug && isPlatformRedeemPath(resolved)) return shopRedeemPath(slug);
  if (resolved.startsWith("/")) return resolved;
  const selfBaseUrl = await getPublicBaseUrl();
  if (slug) return resolveShopRedeemUrl(stored, slug, selfBaseUrl);
  return resolveAgentRedeemUrl(stored, selfBaseUrl);
}
