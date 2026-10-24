import { describe, expect, it } from "vitest";
import type { SessionCheckResult } from "../session-check";
import { sessionCheckPayload } from "./session-check-core";

function result(overrides: Partial<SessionCheckResult>): SessionCheckResult {
  return { ok: true, hasAccessToken: true, errors: [], warnings: [], source: "cardplatform", ...overrides };
}

describe("sessionCheckPayload", () => {
  it("passes through a successful card platform preflight", () => {
    expect(
      sessionCheckPayload(
        result({
          email: "buyer@example.com",
          planHint: "free",
          summary: { has_active_subscription: false },
          warnings: ["当前账号没有有效订阅。"],
        }),
      ),
    ).toEqual({
      ok: true,
      email: "buyer@example.com",
      plan_hint: "free",
      has_active_subscription: false,
      current_plan: null,
      subscription: null,
      target_product: null,
      target_plan: null,
      target_plan_name: null,
      payment_country: null,
      quote: null,
      first_month_half_eligible: null,
      error_code: null,
      retryable: null,
      errors: [],
      warnings: ["当前账号没有有效订阅。"],
    });
  });

  it("exposes the account, target plan and formatted quote", () => {
    const quote = { country: "PH", currency: "PHP", upstreamPlan: "plus", amountMinor: 98214, listAmountMinor: null, minorUnitExponent: 2, tax: "exclusive" };
    const payload = sessionCheckPayload(
      result({
        planHint: "免费版",
        account: {
          email: "buyer@example.com",
          currentPlanRaw: "free",
          currentPlan: "free",
          subscription: { active: false, willRenew: false, recoveryRequired: false, delinquent: false, purchaseOrigin: "", expiresAt: "", expiryHasTime: false },
          preflightToken: "t",
          blockingReason: "",
          preflightExpiresAt: "",
          paymentCountry: "PH",
          paymentCurrency: "PHP",
          quotes: { plus: quote },
          quoteError: "",
          promotions: {},
        },
        target: { planKey: "plus", planName: "Plus", paymentCountry: "", product: "gpt" },
        eligibility: { verdict: "ok", code: null, reasons: [], warnings: [], quote },
      }),
    );
    expect(payload).toMatchObject({
      plan_hint: "free",
      current_plan: "free",
      subscription: {
        active: false,
        will_renew: false,
        delinquent: false,
        recovery_required: false,
        expires_at: null,
        expires_at_has_time: null,
      },
      target_product: "gpt",
      target_plan: "plus",
      target_plan_name: "Plus",
      payment_country: "PH",
      quote: { currency: "PHP", amount_minor: 98214, minor_unit_exponent: 2, amount: "982.14", tax: "exclusive" },
    });
  });

  it("passes eligibility blocks through as non-retryable", () => {
    const payload = sessionCheckPayload(
      result({ ok: false, errorCode: "GPT_CREDIT_REQUIRES_SUBSCRIPTION", retryable: false, errors: ["要先有订阅"] }),
    );
    expect(payload).toMatchObject({ ok: false, error_code: "GPT_CREDIT_REQUIRES_SUBSCRIPTION", retryable: false });
  });

  it("keeps the card platform error code and message", () => {
    const payload = sessionCheckPayload(
      result({ ok: false, errorCode: "CARDPLATFORM_ERROR", errors: ["会话已过期"] }),
    );
    expect(payload).toMatchObject({ ok: false, error_code: "CARDPLATFORM_ERROR", errors: ["会话已过期"] });
  });

  it("marks local format failures as SESSION_INVALID", () => {
    const payload = sessionCheckPayload(
      result({ ok: false, hasAccessToken: false, source: "local", errors: ["不是合法 JSON。"] }),
    );
    expect(payload.error_code).toBe("SESSION_INVALID");
    expect(payload.has_active_subscription).toBeNull();
  });
});
