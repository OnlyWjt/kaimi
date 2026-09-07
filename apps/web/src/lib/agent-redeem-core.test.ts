import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_REDEEM_URL,
  isExternalRedeemUrl,
  normalizeAgentRedeemUrl,
  resolveAgentRedeemUrl,
} from "./agent-redeem-core";

describe("normalizeAgentRedeemUrl", () => {
  it("保留完整的 http / https 网址，去掉末尾斜杠", () => {
    expect(normalizeAgentRedeemUrl("https://cdk.example.com/agent")).toBe(
      "https://cdk.example.com/agent",
    );
    expect(normalizeAgentRedeemUrl("  http://cdk.example.com/  ")).toBe(
      "http://cdk.example.com",
    );
  });

  it("收本站的绝对路径", () => {
    expect(normalizeAgentRedeemUrl("/recharge")).toBe("/recharge");
    expect(normalizeAgentRedeemUrl("  /recharge/  ")).toBe("/recharge");
    expect(normalizeAgentRedeemUrl("/")).toBe("/");
  });

  it("会被浏览器当成跨站跳转的写法一律不收", () => {
    expect(normalizeAgentRedeemUrl("//evil.com")).toBe("");
    expect(normalizeAgentRedeemUrl("/\\evil.com")).toBe("");
    expect(normalizeAgentRedeemUrl("cdk.example.com/agent")).toBe("");
    expect(normalizeAgentRedeemUrl("javascript:alert(1)")).toBe("");
    expect(normalizeAgentRedeemUrl("")).toBe("");
  });
});

describe("isExternalRedeemUrl", () => {
  it("只有绝对网址才算站外", () => {
    expect(isExternalRedeemUrl("/recharge")).toBe(false);
    expect(isExternalRedeemUrl("https://cdk.example.com/agent")).toBe(true);
  });
});

describe("resolveAgentRedeemUrl", () => {
  it("没配过就用默认的站内兑换页", () => {
    expect(resolveAgentRedeemUrl("")).toBe(DEFAULT_AGENT_REDEEM_URL);
    expect(resolveAgentRedeemUrl("   ")).toBe("/recharge");
    expect(resolveAgentRedeemUrl("javascript:alert(1)")).toBe("/recharge");
  });

  it("把历史默认值当没配过", () => {
    // 生产库里存的就是这一条，只改默认值修不了它。
    expect(resolveAgentRedeemUrl("https://cdk.jincieryi.top/agent")).toBe(
      "/recharge",
    );
    expect(
      resolveAgentRedeemUrl("https://cdk.jincieryi.top/agent/"),
    ).toBe("/recharge");
  });

  it("解析到本站自己的 /agent 也当没配过", () => {
    expect(
      resolveAgentRedeemUrl("https://shop.example.com/agent", "https://shop.example.com"),
    ).toBe("/recharge");
    expect(resolveAgentRedeemUrl("/agent")).toBe("/recharge");
    expect(resolveAgentRedeemUrl("/agent/")).toBe("/recharge");
  });

  it("外部地址照存的用，不去猜", () => {
    expect(
      resolveAgentRedeemUrl("https://cdk.other.com/agent", "https://shop.example.com"),
    ).toBe("https://cdk.other.com/agent");
    // 同域但不是代理后台，是管理员自己指的，别动。
    expect(
      resolveAgentRedeemUrl("https://shop.example.com/redeem", "https://shop.example.com"),
    ).toBe("https://shop.example.com/redeem");
    expect(resolveAgentRedeemUrl("/cdk")).toBe("/cdk");
  });

  it("没配公网地址时不误伤外部地址", () => {
    expect(resolveAgentRedeemUrl("https://cdk.other.com/agent", "")).toBe(
      "https://cdk.other.com/agent",
    );
  });
});
