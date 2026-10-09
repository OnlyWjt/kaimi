import { describe, expect, it } from "vitest";
import { signEpayParams, verifyEpayNotify } from "./epay";

const config = { apiBase: "https://pay.invalid", pid: "1001", key: "test-key" };

function signed(params: Record<string, string>) {
  return { ...params, sign: signEpayParams(params, config.key) };
}

describe("verifyEpayNotify pid check", () => {
  it("accepts matching pid", () => {
    expect(
      verifyEpayNotify(config, signed({ pid: "1001", money: "1.00", trade_status: "TRADE_SUCCESS" })),
    ).toEqual({ ok: true });
  });

  it("rejects missing pid even with a valid sign", () => {
    expect(
      verifyEpayNotify(config, signed({ money: "1.00", trade_status: "TRADE_SUCCESS" })),
    ).toEqual({ ok: false, error: "invalid pid" });
    expect(
      verifyEpayNotify(config, signed({ pid: " ", money: "1.00", trade_status: "TRADE_SUCCESS" })),
    ).toEqual({ ok: false, error: "invalid pid" });
  });

  it("rejects a different pid", () => {
    expect(
      verifyEpayNotify(config, signed({ pid: "2002", money: "1.00", trade_status: "TRADE_SUCCESS" })),
    ).toEqual({ ok: false, error: "invalid pid" });
  });
});
