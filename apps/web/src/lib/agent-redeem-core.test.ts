import { describe, expect, it } from "vitest";
import { normalizeAgentRedeemUrl } from "./agent-redeem-core";

describe("normalizeAgentRedeemUrl", () => {
  it("保留完整的 http / https 网址，去掉末尾斜杠", () => {
    expect(normalizeAgentRedeemUrl("https://cdk.example.com/agent")).toBe(
      "https://cdk.example.com/agent",
    );
    expect(normalizeAgentRedeemUrl("  http://cdk.example.com/  ")).toBe(
      "http://cdk.example.com",
    );
  });

  it("相对路径和别的协议一律不收", () => {
    expect(normalizeAgentRedeemUrl("/recharge")).toBe("");
    expect(normalizeAgentRedeemUrl("cdk.example.com/agent")).toBe("");
    expect(normalizeAgentRedeemUrl("javascript:alert(1)")).toBe("");
    expect(normalizeAgentRedeemUrl("")).toBe("");
  });
});
