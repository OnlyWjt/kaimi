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
      error_code: null,
      errors: [],
      warnings: ["当前账号没有有效订阅。"],
    });
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
