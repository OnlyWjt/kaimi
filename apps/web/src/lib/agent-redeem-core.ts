/** 兑换页面在卡台那边，域名换了要能在后台直接改，不能写死在组件里。 */
export const DEFAULT_AGENT_REDEEM_URL = "https://cdk.jincieryi.top/agent";

/** 只认完整的 http / https 网址，填不对就当没填，别把相对路径塞进新标签页。 */
export function normalizeAgentRedeemUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
