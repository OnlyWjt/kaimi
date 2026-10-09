import { enforceRateLimit, rateLimitResponse } from "./rate-limit";

/**
 * 登录防爆破：
 * - 按 IP 限流：/api/auth 和 /api/setup(action=login) 共用同一个桶，换入口不能多拿额度；
 * - 按用户名记失败次数：窗口内失败 LOGIN_MAX_FAILURES 次就锁定该用户名，直到窗口过期。
 *   换 IP 轮询同一个账号也会被挡住。登录成功清零。
 *
 * 进程内存实现，和 rate-limit.ts 一样，多实例部署时各实例单独计数。
 */

export const LOGIN_RATE_BUCKET = "login";
export const LOGIN_RATE_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES = 10;

type FailureEntry = { n: number; reset: number };

const failures = new Map<string, FailureEntry>();
const MAX_TRACKED = 10_000;

function normalize(username: string) {
  return username.trim().toLowerCase();
}

function prune(now: number) {
  if (failures.size < MAX_TRACKED) return;
  for (const [key, entry] of failures) {
    if (now > entry.reset) failures.delete(key);
  }
}

/** 该用户名还要锁多少秒；0 表示未锁定。 */
export function loginLockedFor(username: string, now = Date.now()) {
  const key = normalize(username);
  const entry = failures.get(key);
  if (!entry) return 0;
  if (now > entry.reset) {
    failures.delete(key);
    return 0;
  }
  if (entry.n < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((entry.reset - now) / 1000));
}

/** 记一次失败。窗口从第一次失败开始算。 */
export function recordLoginFailure(username: string, now = Date.now()) {
  const key = normalize(username);
  if (!key) return;
  prune(now);
  const entry = failures.get(key);
  if (!entry || now > entry.reset) {
    failures.set(key, { n: 1, reset: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.n += 1;
}

export function clearLoginFailures(username: string) {
  failures.delete(normalize(username));
}

/** 测试用。 */
export function resetLoginLockouts() {
  failures.clear();
}

/** 登录入口统一前置检查：IP 限流 + 用户名锁定。返回非 null 时直接作为响应返回。 */
export function guardLoginAttempt(req: Request, username: string) {
  const limited = enforceRateLimit(req, LOGIN_RATE_BUCKET, LOGIN_RATE_LIMIT, LOGIN_WINDOW_MS);
  if (limited) return limited;
  const lockedSec = loginLockedFor(username);
  if (lockedSec > 0) return rateLimitResponse(lockedSec);
  return null;
}
