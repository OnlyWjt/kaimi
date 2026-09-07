import { getSetting } from "@/lib/config";
import { resolveAgentRedeemUrl } from "@/lib/agent-redeem-core";
import { getPublicBaseUrl } from "@/lib/public-url";

export {
  DEFAULT_AGENT_REDEEM_URL,
  isExternalRedeemUrl,
  normalizeAgentRedeemUrl,
  resolveAgentRedeemUrl,
} from "@/lib/agent-redeem-core";

export async function getAgentRedeemUrl() {
  const [stored, selfBaseUrl] = await Promise.all([
    getSetting("agent_redeem_url", ""),
    getPublicBaseUrl(),
  ]);
  return resolveAgentRedeemUrl(stored, selfBaseUrl);
}
