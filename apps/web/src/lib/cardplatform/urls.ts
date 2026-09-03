const DEFAULT_PREFIX = "/api/v1/webhooks/cardplatform/";

export function defaultAccountWebhookPath(accountId: number) {
  return `${DEFAULT_PREFIX}${accountId}`;
}

export function normalizeAccountWebhookPath(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("回调 URL 必填");
  let path = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    path = parsed.pathname || "";
  }
  path = path.replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/api/v1/webhooks/avanfinity") return path;
  if (!path.startsWith(DEFAULT_PREFIX)) {
    throw new Error("回调路径必须在 /api/v1/webhooks/cardplatform/ 下");
  }
  const rest = path.slice(DEFAULT_PREFIX.length);
  if (!rest || rest.includes("/")) {
    throw new Error("回调路径只能有一段，例如 /api/v1/webhooks/cardplatform/1");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) {
    throw new Error("路径含非法字符");
  }
  return path;
}

export function accountWebhookPublicUrl(
  origin: string,
  path: string,
  accountId: number,
) {
  const normalized = path.trim().replace(/\/+$/, "") || defaultAccountWebhookPath(accountId);
  return `${origin.replace(/\/+$/, "")}${normalized}`;
}

export function webhookPathForSlug(slug: string) {
  return `${DEFAULT_PREFIX}${slug.trim().replace(/^\/+|\/+$/g, "")}`;
}
