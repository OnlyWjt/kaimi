import { getSetting } from "@/lib/config";
import {
  DEFAULT_AGENT_REDEEM_URL,
  normalizeAgentRedeemUrl,
} from "@/lib/agent-redeem-core";

export {
  DEFAULT_AGENT_REDEEM_URL,
  normalizeAgentRedeemUrl,
} from "@/lib/agent-redeem-core";

export async function getAgentRedeemUrl() {
  const stored = normalizeAgentRedeemUrl(await getSetting("agent_redeem_url", ""));
  return stored || DEFAULT_AGENT_REDEEM_URL;
}
