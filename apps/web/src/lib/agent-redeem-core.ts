/**
 * 兑换页面就是本站自己的 /recharge。用站内相对路径，不拼绝对地址：
 * 换域名、多域名、还没配公网地址的本地开发都不用管它，也就不会再出现
 * 「按钮还指着旧域名」这种事。管理员仍然可以在后台改成外部完整网址。
 */
export const DEFAULT_AGENT_REDEEM_URL = "/recharge";

/**
 * 历史上默认值写成了 https://cdk.jincieryi.top/agent，以为兑换页在卡台那边。
 * 这个域名其实就是本站，那个地址点开只会又回到代理后台自己。生产库里已经存了
 * 这一条，所以读的时候要认出来当没配过。
 */
const LEGACY_SELF_REDEEM_URL = "https://cdk.jincieryi.top/agent";

/** 代理后台自己的路径。兑换链接指到这里就是绕回原地，等于没配。 */
const AGENT_DASHBOARD_PATH = "/agent";

/**
 * 认两种写法：完整的 http / https 网址，或者本站的绝对路径（以 / 开头）。
 * 协议相对（//evil.com）和 /\evil.com 会被浏览器当成跨站跳转，一律不收。
 */
export function normalizeAgentRedeemUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) {
    if (trimmed[1] === "/" || trimmed[1] === "\\") return "";
    return trimmed.length > 1 ? trimmed.replace(/\/$/, "") : trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** 站内路径走普通跳转，外部地址才开新标签页，免得把代理后台整个换掉。 */
export function isExternalRedeemUrl(value: string) {
  return !value.startsWith("/");
}

function pointsAtOwnDashboard(stored: string, selfBaseUrl: string) {
  if (stored === LEGACY_SELF_REDEEM_URL) return true;
  if (!selfBaseUrl) return false;
  try {
    const target = new URL(stored);
    const self = new URL(selfBaseUrl);
    if (target.host !== self.host) return false;
    return target.pathname.replace(/\/$/, "") === AGENT_DASHBOARD_PATH;
  } catch {
    return false;
  }
}

/**
 * 存的地址如果解析下来就是本站自己的 /agent，当没配过用默认值——只改默认值
 * 修不了已经写进 site_settings 的老库。别的外部地址一律照存的用，不去猜。
 */
export function resolveAgentRedeemUrl(stored: string, selfBaseUrl = "") {
  const normalized = normalizeAgentRedeemUrl(stored);
  if (!normalized) return DEFAULT_AGENT_REDEEM_URL;
  if (normalized.startsWith("/")) {
    return normalized.replace(/\/$/, "") === AGENT_DASHBOARD_PATH
      ? DEFAULT_AGENT_REDEEM_URL
      : normalized;
  }
  return pointsAtOwnDashboard(normalized, selfBaseUrl)
    ? DEFAULT_AGENT_REDEEM_URL
    : normalized;
}

export function shopRedeemPath(slug: string) {
  const clean = slug.trim();
  return clean ? `/s/${clean}/recharge` : DEFAULT_AGENT_REDEEM_URL;
}

export function shopCdkPath(slug: string) {
  const clean = slug.trim();
  return clean ? `/s/${clean}/cdk` : "/cdk";
}

export function shopLookupPath(slug: string, orderNo = "") {
  const clean = slug.trim();
  const base = clean ? `/s/${clean}/lookup` : "/lookup";
  return orderNo ? `${base}?orderNo=${encodeURIComponent(orderNo)}` : base;
}

/** 当前在 /s/{slug}/… 就跟店走，否则回平台裸路径。 */
export function shopSlugFromPathname(pathname: string) {
  const match = /^\/s\/([^/?#]+)/.exec(pathname);
  return match?.[1]?.trim() || "";
}

/** 只有平台默认兑换页才改挂到店铺；管理员配的其它地址原样返回。 */
export function isPlatformRedeemPath(value: string) {
  const path = (value.split("?")[0] || "").replace(/\/$/, "");
  return path === "/recharge";
}

export function resolveShopRedeemUrl(stored: string, slug: string, selfBaseUrl = "") {
  const resolved = resolveAgentRedeemUrl(stored, selfBaseUrl);
  return isPlatformRedeemPath(resolved) ? shopRedeemPath(slug) : resolved;
}

export function keepSearchPath(pathname: string, search: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const trimmed = value?.trim();
    if (trimmed) query.set(key, trimmed);
  }
  const encoded = query.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
}

export function buildRechargePath(
  basePath: string,
  input: { codes: string[]; orderNo?: string; queryToken?: string },
) {
  if (isExternalRedeemUrl(basePath)) return basePath;
  const root =
    (basePath.split("?")[0] || DEFAULT_AGENT_REDEEM_URL).replace(/\/$/, "") ||
    DEFAULT_AGENT_REDEEM_URL;
  if (input.codes.length === 1 && input.codes[0]) {
    return `${root}?code=${encodeURIComponent(input.codes[0])}`;
  }
  if (input.codes.length > 1 && input.orderNo && input.queryToken) {
    return `${root}?order=${encodeURIComponent(input.orderNo)}&qt=${encodeURIComponent(input.queryToken)}`;
  }
  return root;
}
