import type { SessionCheckResult } from "../session-check";

/**
 * POST /sessions/check 的返回。
 *
 * level 说明这次校验做到哪一步，代理要据此判断结果有多可信：
 * - format：只看了格式（是不是登录后的 session JSON、有没有 accessToken）。不发外部请求，
 *   通过了也不代表 token 还有效。
 * - preflight：带了本店卖出的卡密，交给卡台按这张卡预检过。通过就说明拿这个 Session 兑这张卡能走通。
 */
export type SessionCheckLevel = "format" | "preflight";

export function sessionCheckPayload(result: SessionCheckResult, level: SessionCheckLevel) {
  return {
    ok: result.ok,
    level,
    email: result.email ?? null,
    name: result.name ?? null,
    has_access_token: result.hasAccessToken,
    plan_hint: result.planHint ?? null,
    has_active_subscription:
      level === "preflight" && typeof result.summary?.has_active_subscription === "boolean"
        ? result.summary.has_active_subscription
        : null,
    error_code: result.ok ? null : (result.errorCode ?? "SESSION_INVALID"),
    errors: result.errors,
    warnings: result.warnings,
  };
}
