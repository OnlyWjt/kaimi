import { describe, expect, it } from "vitest";
import {
  assessEligibility,
  basePlanKey,
  formatMinorAmount,
  parsePreflight,
  preflightRetryable,
} from "./preflight-core";

/** 卡台 /api/v1/cdk/preflight 的真实返回（免费号、菲区），令牌截短。 */
const FREE_ACCOUNT = {
  code: 0,
  msg: "ok",
  data: {
    email: "sophia.miller4637@mail.com",
    currentPlan: "free",
    subscription_has_active: false,
    subscription_will_renew: false,
    subscription_recovery_required: false,
    subscription_is_delinquent: false,
    subscription_purchase_origin: "chatgpt_not_purchased",
    credentialMode: "session",
    mailProvider: "",
    preflight_token: "v1.db7a49658390.token",
    preflight_expires_at: "2026-12-05T09:54:27.922Z",
    payment_country: "PH",
    payment_currency: "PHP",
    quotes: {
      go: { country: "PH", currency: "PHP", plan: "go", amountMinor: 30000, amountMajor: 300, minorUnitExponent: 2, tax: "inclusive", fetchedAt: 1792576467644 },
      plus: { country: "PH", currency: "PHP", plan: "plus", amountMinor: 98214, amountMajor: 982.14, minorUnitExponent: 2, tax: "exclusive", fetchedAt: 1792576467644 },
      pro_20x: { country: "PH", currency: "PHP", plan: "pro", amountMinor: 891964, amountMajor: 8919.64, minorUnitExponent: 2, tax: "exclusive", fetchedAt: 1792576467644 },
      pro_50x: { country: "PH", currency: "PHP", plan: "promax", amountMinor: 2900893, amountMajor: 29008.93, minorUnitExponent: 2, tax: "exclusive", fetchedAt: 1792576467644 },
      pro_5x: { country: "PH", currency: "PHP", plan: "prolite", amountMinor: 579464, amountMajor: 5794.64, minorUnitExponent: 2, tax: "exclusive", fetchedAt: 1792576467644 },
    },
    promotions: {
      plus_half: { kind: "half_price", eligible: false, list_amount_minor: 98214, currency: "PHP" },
    },
  },
};

function account(overrides: Record<string, unknown> = {}) {
  return parsePreflight({ ...FREE_ACCOUNT, data: { ...FREE_ACCOUNT.data, ...overrides } });
}

describe("parsePreflight", () => {
  it("reads the account fields from inside the data envelope", () => {
    const parsed = parsePreflight(FREE_ACCOUNT);
    expect(parsed).toMatchObject({
      email: "sophia.miller4637@mail.com",
      currentPlan: "free",
      currentPlanRaw: "free",
      subscription: { active: false, willRenew: false, delinquent: false, recoveryRequired: false },
      preflightToken: "v1.db7a49658390.token",
      paymentCountry: "PH",
      paymentCurrency: "PHP",
      quoteError: "",
    });
    expect(parsed.quotes.pro_20x).toEqual({
      country: "PH",
      currency: "PHP",
      upstreamPlan: "pro",
      amountMinor: 891964,
      listAmountMinor: null,
      minorUnitExponent: 2,
      tax: "exclusive",
    });
    expect(parsed.promotions.plus_half).toEqual({
      kind: "half_price",
      eligible: false,
      amountMinor: null,
      listAmountMinor: 98214,
    });
  });

  it("reads the subscription expiry from seconds, milliseconds or ISO", () => {
    expect(parsePreflight(FREE_ACCOUNT).subscription.expiresAt).toBe("");
    expect(account({ active_until: 1760000000 }).subscription.expiresAt).toBe("2025-10-09T08:53:20.000Z");
    expect(account({ subscription_expires_at: 1760000000000 }).subscription.expiresAt).toBe("2025-10-09T08:53:20.000Z");
    expect(account({ current_period_end: "1760000000" }).subscription.expiresAt).toBe("2025-10-09T08:53:20.000Z");
    expect(account({ current_period_end: "2026-11-20T00:00:00Z" }).subscription.expiresAt).toBe("2026-11-20T00:00:00.000Z");
    expect(account({ current_period_end: "not a date" }).subscription.expiresAt).toBe("");
    // 裸 expires_at 是令牌过期，不是订阅到期。
    expect(account({ expires_at: "2026-12-05T09:54:27.922Z" }).subscription.expiresAt).toBe("");
  });

  it("remembers whether the expiry is a time point or a bare date", () => {
    expect(account({ active_until: 1760000000 }).subscription.expiryHasTime).toBe(true);
    expect(
      account({ current_period_end: "2026-10-22T14:14:48+00:00" }).subscription.expiryHasTime,
    ).toBe(true);
    expect(account({ current_period_end: "2026-10-22" }).subscription).toMatchObject({
      expiresAt: "2026-10-22",
      expiryHasTime: false,
    });
    expect(parsePreflight(FREE_ACCOUNT).subscription.expiryHasTime).toBe(false);
  });

  it("maps ChatGPT plan names onto our plan keys", () => {
    expect(account({ currentPlan: "prolite" }).currentPlan).toBe("pro_5x");
    expect(account({ currentPlan: "pro" }).currentPlan).toBe("pro_20x");
    expect(account({ currentPlan: "promax" }).currentPlan).toBe("pro_50x");
    expect(account({ currentPlan: "enterprise" }).currentPlan).toBe("");
  });
});

describe("assessEligibility", () => {
  it("lets a free account open a new plan and returns that plan's quote", () => {
    const result = assessEligibility(account(), "pro_20x");
    expect(result.verdict).toBe("ok");
    expect(result.quote?.amountMinor).toBe(891964);
  });

  it("uses the base plan for region variants", () => {
    expect(basePlanKey("plus:us")).toBe("plus");
    expect(assessEligibility(account(), "plus:us").quote?.amountMinor).toBe(98214);
  });

  it("blocks credits for an account without a subscription", () => {
    const result = assessEligibility(account(), "credit250");
    expect(result).toMatchObject({ verdict: "block", code: "GPT_CREDIT_REQUIRES_SUBSCRIPTION", quote: null });
    expect(assessEligibility(account({ currentPlan: "plus", subscription_has_active: true }), "credit250").verdict).toBe("ok");
  });

  it("blocks renew plans unless the account is on that tier and still active", () => {
    expect(assessEligibility(account(), "pro_20x_renew").code).toBe("GPT_RENEW_TARGET_NOT_PRO");
    expect(
      assessEligibility(account({ currentPlan: "prolite", subscription_has_active: true }), "pro_20x_renew").code,
    ).toBe("GPT_RENEW_TARGET_NOT_PRO");
    expect(
      assessEligibility(account({ currentPlan: "pro", subscription_has_active: false }), "pro_20x_renew").code,
    ).toBe("GPT_RENEW_SUBSCRIPTION_EXPIRED");
    expect(
      assessEligibility(account({ currentPlan: "pro", subscription_has_active: true }), "pro_20x_renew").verdict,
    ).toBe("ok");
    expect(
      assessEligibility(account({ currentPlan: "prolite", subscription_has_active: true }), "pro_5x_renew").verdict,
    ).toBe("ok");
  });

  it("only warns when it cannot tell the current plan of a renew target", () => {
    const result = assessEligibility(account({ currentPlan: "", subscription_has_active: null }), "pro_20x_renew");
    expect(result.verdict).toBe("warn");
  });

  it("blocks the same plan while it is still active, warns for a different paid plan", () => {
    const plus = account({ currentPlan: "plus", subscription_has_active: true });
    expect(assessEligibility(plus, "plus").code).toBe("GPT_PLAN_ALREADY_ACTIVE");
    expect(assessEligibility(plus, "pro_5x").verdict).toBe("warn");
  });

  it("blocks plus_half when the account is not eligible for the promotion", () => {
    expect(assessEligibility(account(), "plus_half").code).toBe("PROMOTION_NOT_ELIGIBLE");
    const eligible = account({ promotions: { plus_half: { kind: "half_price", eligible: true } } });
    expect(assessEligibility(eligible, "plus_half").verdict).toBe("ok");
  });

  it("blocks on quote_error only when this plan has no quote", () => {
    const noQuotes = account({ quotes: {}, quote_error: "汇率不可用" });
    expect(assessEligibility(noQuotes, "plus").code).toBe("GPT_PRICE_UNCONFIRMED");
    expect(assessEligibility(account({ quote_error: "部分档位报价失败" }), "plus").verdict).toBe("warn");
    // 点数、续费不按报价扣款，quote_error 和它们无关。
    expect(assessEligibility(account({ currentPlan: "plus", subscription_has_active: true, quotes: {}, quote_error: "x" }), "credit500").verdict).toBe("ok");
  });

  it("warns about delinquent accounts and app store subscriptions", () => {
    expect(assessEligibility(account({ subscription_is_delinquent: true }), "plus").warnings).toHaveLength(1);
    const ios = account({ currentPlan: "plus", subscription_has_active: true, subscription_purchase_origin: "apple" });
    expect(assessEligibility(ios, "pro_20x").warnings.some((w) => w.includes("应用商店"))).toBe(true);
  });

  it("leaves unknown plans alone", () => {
    expect(assessEligibility(account(), "something_new").verdict).toBe("ok");
  });
});

/** 卡台 Grok 预检真实返回（节选，取自 danew grok_promo_test）：plus 原价，premium / super 月付首月五折。 */
const GROK_PREFLIGHT = {
  code: 0,
  msg: "ok",
  data: {
    email: "a@example.com",
    currentPlan: "",
    payment_country: "US",
    quotes: {
      plus_monthly: { currency: "USD", plan: "plus_monthly", amountMinor: 800, listAmountMinor: 800 },
      premium_monthly: { currency: "USD", plan: "premium_monthly", amountMinor: 1500, listAmountMinor: 3000, discounted: true },
      super_monthly: { currency: "USD", plan: "super_monthly", amountMinor: 5000, listAmountMinor: 10000, discounted: true },
      super_yearly: { currency: "USD", plan: "super_yearly", amountMinor: 100000, listAmountMinor: 100000 },
    },
    promotions: {
      plus_monthly: { kind: "first_month_discount", eligible: false, amount_minor: 800, list_amount_minor: 800 },
      premium_monthly: { kind: "first_month_discount", eligible: true, discount_percent: 50, amount_minor: 1500, list_amount_minor: 3000 },
      super_monthly: { kind: "first_month_discount", eligible: true, discount_percent: 50, amount_minor: 5000, list_amount_minor: 10000 },
    },
  },
};

function grokAccount(data: Record<string, unknown> = {}) {
  return parsePreflight({ ...GROK_PREFLIGHT, data: { ...GROK_PREFLIGHT.data, ...data } });
}

describe("Grok 首月半价", () => {
  it("解析时保留原价和优惠金额", () => {
    const parsed = grokAccount();
    expect(parsed.quotes.premium_monthly).toMatchObject({ amountMinor: 1500, listAmountMinor: 3000, currency: "USD" });
    expect(parsed.promotions.premium_monthly).toEqual({
      kind: "first_month_discount",
      eligible: true,
      amountMinor: 1500,
      listAmountMinor: 3000,
    });
  });

  it("首月价不超过原价一半才放行，结果里只有资格不带金额", () => {
    const ok = assessEligibility(grokAccount(), "grok_premium_monthly_half");
    expect(ok).toMatchObject({ verdict: "ok", code: null, quote: null, firstMonthHalf: { eligible: true } });
    expect(assessEligibility(grokAccount(), "grok_super_monthly_half").verdict).toBe("ok");
  });

  it("没有资格：首月按原价付、优惠信息说没资格、只打七折，都拦", () => {
    const fullPrice = grokAccount({
      quotes: { premium_monthly: { currency: "USD", amountMinor: 3000, listAmountMinor: 3000 } },
      promotions: { premium_monthly: { kind: "first_month_discount", eligible: false } },
    });
    const blocked = assessEligibility(fullPrice, "grok_premium_monthly_half");
    expect(blocked).toMatchObject({ verdict: "block", code: "PROMOTION_NOT_ELIGIBLE", firstMonthHalf: { eligible: false } });
    expect(blocked.reasons[0]).toContain("没有 Grok 首月半价资格");
    expect(blocked.reasons[0]).toContain("卡密没有被消耗");
    // 买家看得到这句话，不能带金额
    expect(blocked.reasons.join("")).not.toMatch(/d/);

    // 报价打了折，优惠信息却说没资格：两边对不上按没资格算
    const conflict = grokAccount({
      promotions: { premium_monthly: { kind: "first_month_discount", eligible: false } },
    });
    expect(assessEligibility(conflict, "grok_premium_monthly_half").code).toBe("PROMOTION_NOT_ELIGIBLE");

    // 报价是半价，优惠信息里的金额却是原价：按没资格算
    const promoFull = grokAccount({
      promotions: { premium_monthly: { kind: "first_month_discount", eligible: true, amount_minor: 3000, list_amount_minor: 3000 } },
    });
    expect(assessEligibility(promoFull, "grok_premium_monthly_half").code).toBe("PROMOTION_NOT_ELIGIBLE");
    // 报价缺失时不拿优惠信息顶替
    const promoOnly = grokAccount({ quotes: {} });
    expect(assessEligibility(promoOnly, "grok_premium_monthly_half").firstMonthHalf).toEqual({ eligible: null });

    const partial = grokAccount({
      quotes: { super_monthly: { amountMinor: "7000", listAmountMinor: "10000" } },
      promotions: {},
    });
    expect(assessEligibility(partial, "grok_super_monthly_half").verdict).toBe("block");
    // 首月免费也算半价以内，金额是字符串也认
    const free = grokAccount({ quotes: { super_monthly: { amountMinor: "0", listAmountMinor: "10000" } }, promotions: {} });
    expect(assessEligibility(free, "grok_super_monthly_half").verdict).toBe("ok");
  });

  it("报价缺失或没有原价时也拦，不像 plus_half 那样只警告", () => {
    const missing = assessEligibility(grokAccount(), "grok_ultra_monthly_half");
    expect(missing).toMatchObject({ verdict: "block", code: "PROMOTION_NOT_ELIGIBLE", firstMonthHalf: { eligible: null } });
    expect(missing.reasons[0]).toContain("无法确认首月半价资格");
    const noList = grokAccount({ quotes: { premium_monthly: { amountMinor: 1500 } } });
    expect(assessEligibility(noList, "grok_premium_monthly_half").verdict).toBe("block");
    expect(assessEligibility(grokAccount({ quotes: {}, promotions: {} }), "grok_premium_monthly_half").verdict).toBe("block");
  });

  it("报价带 grok_ 前缀的键也认", () => {
    const prefixed = grokAccount({
      quotes: { grok_ultra_monthly: { amountMinor: 15000, listAmountMinor: 30000 } },
      promotions: {},
    });
    expect(assessEligibility(prefixed, "grok_ultra_monthly_half").verdict).toBe("ok");
  });

  it("卡台已经拦了只报卡台的原因，不再补一句确认不了", () => {
    const result = assessEligibility(
      grokAccount({ blocking_reason: "登录态已失效", quotes: {}, promotions: {} }),
      "grok_premium_monthly_half",
    );
    expect(result).toMatchObject({ verdict: "block", code: "PRECHECK_BLOCKED", reasons: ["登录态已失效"] });
  });

  it("正价码不查首月价：首月按原价的账号照样放行", () => {
    const fullPrice = grokAccount({
      quotes: { premium_monthly: { amountMinor: 3000, listAmountMinor: 3000 } },
      promotions: { premium_monthly: { eligible: false } },
    });
    const result = assessEligibility(fullPrice, "grok_premium_monthly");
    expect(result.verdict).toBe("ok");
    expect(result.firstMonthHalf).toBeUndefined();
    expect(assessEligibility(grokAccount({ quotes: {} }), "grok_super_monthly").verdict).toBe("ok");
  });
});

describe("formatMinorAmount", () => {
  it("respects the minor unit exponent", () => {
    expect(formatMinorAmount(98214, 2)).toBe("982.14");
    expect(formatMinorAmount(5, 2)).toBe("0.05");
    expect(formatMinorAmount(3000, 0)).toBe("3000");
  });
});

describe("preflightRetryable", () => {
  it("is true only for rate limits and transient upstream errors", () => {
    expect(preflightRetryable("GPT_PREFLIGHT_RATE_LIMITED", 400)).toBe(true);
    expect(preflightRetryable("", 503)).toBe(true);
    expect(preflightRetryable("GPT_SESSION_INVALID", 400)).toBe(false);
    expect(preflightRetryable("", 400)).toBe(false);
  });
});
