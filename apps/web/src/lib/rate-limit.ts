type Bucket = { n: number; reset: number };

const buckets = new Map<string, Bucket>();

export function clientIp(req: Request) {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

/** 进程内滑动窗口限流。返回 ok=false 时应 429。 */
export function rateLimit(key: string, limit: number, windowMs = 60_000) {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || now > cur.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (cur.n >= limit) {
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil((cur.reset - now) / 1000) };
  }
  cur.n += 1;
  return { ok: true, remaining: limit - cur.n };
}

export function rateLimitResponse(retryAfterSec = 60) {
  return Response.json(
    { error: "请求过于频繁，请稍后再试", retry_after: retryAfterSec },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export function enforceRateLimit(req: Request, name: string, limit: number, windowMs = 60_000) {
  return enforceRateLimitFor(`${name}:${clientIp(req)}`, limit, windowMs);
}

/** 按调用方给的 key 限流。登录用户按身份计额度，别让同一个出口 IP 的人互相挤。 */
export function enforceRateLimitFor(key: string, limit: number, windowMs = 60_000) {
  const r = rateLimit(key, limit, windowMs);
  if (!r.ok) return rateLimitResponse(r.retryAfterSec);
  return null;
}
