import { describe, expect, it } from "vitest";
import type { SessionCheckResult } from "../session-check";
import { sessionCheckPayload } from "./session-check-core";

function result(overrides: Partial<SessionCheckResult>): SessionCheckResult {
  return { ok: true, hasAccessToken: true, errors: [], warnings: [], source: "local", ...overrides };
}

describe("sessionCheckPayload", () => {
  it("reports a well-formed session at format level", () => {
    const payload = sessionCheckPayload(result({ email: "buyer@example.com", name: "Buyer" }), "format");
    expect(payload).toMatchObject({
      ok: true,
      level: "format",
      email: "buyer@example.com",
      has_access_token: true,
      has_active_subscription: null,
      error_code: null,
    });
  });

  it("defaults the error code when a format check fails", () => {
    const payload = sessionCheckPayload(
      result({ ok: false, hasAccessToken: false, errors: ["不是合法 JSON。"] }),
      "format",
    );
    expect(payload).toMatchObject({ ok: false, error_code: "SESSION_INVALID", has_access_token: false });
    expect(payload.errors).toEqual(["不是合法 JSON。"]);
  });

  it("ignores subscription data at format level", () => {
    const payload = sessionCheckPayload(result({ summary: { has_active_subscription: true } }), "format");
    expect(payload.has_active_subscription).toBeNull();
  });

  it("passes through subscription and card platform errors at preflight level", () => {
    expect(
      sessionCheckPayload(
        result({
          source: "cardplatform",
          summary: { has_active_subscription: false },
          warnings: ["当前账号没有有效订阅。"],
        }),
        "preflight",
      ),
    ).toMatchObject({ ok: true, level: "preflight", has_active_subscription: false });
    expect(
      sessionCheckPayload(
        result({ ok: false, source: "cardplatform", errorCode: "CARDPLATFORM_ERROR", errors: ["会话已过期"] }),
        "preflight",
      ).error_code,
    ).toBe("CARDPLATFORM_ERROR");
  });
});
