type Bucket = { n: number; reset: number };

const buckets = new Map<string, Bucket>();

/**
 * 限流用的调用方标识。
 *
 * 取 X-Forwarded-For 的第一跳是不行的：那一段完全由客户端自己写，换一个值就是一个全新
 * 的桶，匿名批量接口的额度等于没有。这里默认信任「我们前面正好有一层反向代理」——它会把
 * 真实对端追加到 XFF 末尾，所以从右往左数第 KAIMI_TRUSTED_PROXY_HOPS 跳才是可信的那个。
 *
 * 部署形态不一样时用环境变量改：
 * - KAIMI_CLIENT_IP_HEADER：由可信代理独占写入的头，优先级最高。Cloudflare 填
 *   `cf-connecting-ip`，这条路径不受 XFF 伪造影响。
 * - KAIMI_TRUSTED_PROXY_HOPS：我们前面有几层代理，默认 1。填 0 表示直连、完全不信 XFF。
 *
 * 本地开发没有任何代理，也就没有这些头，照旧回落到 "local"。
 */
const TRUSTED_CLIENT_IP_HEADER = (
  process.env.KAIMI_CLIENT_IP_HEADER || ""
).trim().toLowerCase();

function trustedProxyHops() {
  const raw = process.env.KAIMI_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.trunc(parsed);
}

/** 纯函数版，方便测。hops 是我们前面的可信代理层数。 */
export function pickClientIp(input: {
  forwardedFor?: string | null;
  realIp?: string | null;
  trustedHeaderValue?: string | null;
  hops?: number;
}) {
  const trusted = (input.trustedHeaderValue || "").trim();
  if (trusted) return trusted;
  const hops = Math.max(0, Math.trunc(input.hops ?? 1));
  if (hops > 0) {
    const chain = (input.forwardedFor || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // 从右往左数第 hops 跳。链子比声称的短就取最左边那个，不能越界拿到伪造段。
    const picked = chain[Math.max(0, chain.length - hops)];
    if (picked) return picked;
  }
  return (input.realIp || "").trim() || "local";
}

export function clientIp(req: Request) {
  return pickClientIp({
    forwardedFor: req.headers.get("x-forwarded-for"),
    realIp: req.headers.get("x-real-ip"),
    trustedHeaderValue: TRUSTED_CLIENT_IP_HEADER
      ? req.headers.get(TRUSTED_CLIENT_IP_HEADER)
      : "",
    hops: trustedProxyHops(),
  });
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
