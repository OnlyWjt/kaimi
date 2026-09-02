const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "login",
  "logout",
  "agent",
  "partner",
  "recharge",
  "lookup",
  "cdk",
  "shop",
  "order",
  "orders",
  "assets",
  "_next",
  "favicon",
  "www",
  "support",
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function normalizeAgentSlug(value: string) {
  return value.trim().toLowerCase();
}

export function validateAgentSlug(value: string) {
  const slug = normalizeAgentSlug(value);
  if (!SLUG_PATTERN.test(slug) || slug.includes("--")) {
    return {
      ok: false as const,
      error: "店铺标识须为 3–32 位小写字母、数字或单个短横线，且首尾不能是短横线",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false as const, error: "该店铺标识为系统保留词" };
  }
  return { ok: true as const, slug };
}
