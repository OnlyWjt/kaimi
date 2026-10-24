import { formatMinorAmount } from "../cardplatform/preflight-core";
import type { SessionCheckResult } from "../session-check";

/**
 * POST /sessions/check 的返回：卡台兑换预检（/api/v1/cdk/preflight）的结果，加上本站按卡密套餐
 * 做的资格判断。本地只先挡掉明显不是 session JSON 的输入，省一次卡台请求。
 *
 * error_code 是卡台的原因码（GPT_SESSION_INVALID、GPT_PLAN_ALREADY_ACTIVE…）或本站的
 * SESSION_INVALID；卡台没给码时才是 CARDPLATFORM_ERROR。
 */
export function sessionCheckPayload(result: SessionCheckResult) {
  const account = result.account;
  const quote = result.eligibility?.quote ?? null;
  return {
    ok: result.ok,
    email: result.email ?? null,
    // 老字段，和 current_plan 一样；卡台没返回当前套餐时退回 Session JSON 里的 planType。
    plan_hint: account
      ? account.currentPlan || account.currentPlanRaw || result.planHint || null
      : (result.planHint ?? null),
    has_active_subscription:
      typeof result.summary?.has_active_subscription === "boolean"
        ? result.summary.has_active_subscription
        : null,
    current_plan: account ? account.currentPlan || account.currentPlanRaw || null : null,
    subscription: account
      ? {
          active: account.subscription.active,
          will_renew: account.subscription.willRenew,
          delinquent: account.subscription.delinquent,
          recovery_required: account.subscription.recoveryRequired,
          expires_at: account.subscription.expiresAt || null,
          /** false 表示卡台只给了日期，expires_at 就是那一天，不是零点；没有到期时间时为 null。 */
          expires_at_has_time: account.subscription.expiresAt
            ? account.subscription.expiryHasTime
            : null,
        }
      : null,
    /** 卡密的产品线：gpt / x / grok。凭证格式按它来。 */
    target_product: result.target?.product || null,
    target_plan: result.target?.planKey || null,
    target_plan_name: result.target?.planName || null,
    payment_country: result.target?.paymentCountry || account?.paymentCountry || null,
    quote: quote
      ? {
          currency: quote.currency,
          amount_minor: quote.amountMinor,
          minor_unit_exponent: quote.minorUnitExponent,
          amount: formatMinorAmount(quote.amountMinor, quote.minorUnitExponent),
          tax: quote.tax || null,
        }
      : null,
    error_code: result.ok ? null : (result.errorCode ?? "SESSION_INVALID"),
    retryable: result.ok ? null : Boolean(result.retryable),
    errors: result.errors,
    warnings: result.warnings,
  };
}
