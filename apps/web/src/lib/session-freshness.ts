/**
 * 判断一条已签发的会话是不是在密码改动之前发出的。
 *
 * 管理员重置代理密码后，对方手上的 cookie 还能用满 7 天，所以登录态要跟着密码走。
 * JWT 的 iat 只有秒，passwordChangedAt 带毫秒，直接比会把「改密码后立刻重新签发」
 * 的那条新会话也误判成旧的，所以两边都按秒取整再比。
 */
export function isSessionStale(
  passwordChangedAt: string | null | undefined,
  issuedAtSeconds: unknown,
) {
  if (!passwordChangedAt) return false;
  const changedAtMs = Date.parse(passwordChangedAt);
  if (!Number.isFinite(changedAtMs)) return false;
  if (typeof issuedAtSeconds !== "number" || !Number.isFinite(issuedAtSeconds)) {
    // 拿不到签发时间就没法判断新旧，当成旧的，让对方重新登录。
    return true;
  }
  return Math.floor(changedAtMs / 1000) > Math.floor(issuedAtSeconds);
}
