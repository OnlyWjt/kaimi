import type { SessionCheckResult } from "../session-check";

/**
 * POST /sessions/check 的返回：卡台兑换预检（/api/v1/cdk/preflight）的结果原样转出来。
 * 本地只先挡掉明显不是 session JSON 的输入，省一次卡台请求。
 */
export function sessionCheckPayload(result: SessionCheckResult) {
  return {
    ok: result.ok,
    email: result.email ?? null,
    plan_hint: result.planHint ?? null,
    has_active_subscription:
      typeof result.summary?.has_active_subscription === "boolean"
        ? result.summary.has_active_subscription
        : null,
    error_code: result.ok ? null : (result.errorCode ?? "SESSION_INVALID"),
    errors: result.errors,
    warnings: result.warnings,
  };
}
