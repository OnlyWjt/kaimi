import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_REDEEM_URL,
  buildRechargePath,
  isExternalRedeemUrl,
  isPlatformRedeemPath,
  keepSearchPath,
  normalizeAgentRedeemUrl,
  resolveAgentRedeemUrl,
  resolveShopRedeemUrl,
  shopCdkPath,
  shopLookupPath,
  shopRedeemPath,
  shopSlugFromPathname,
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

describe("resolveShopRedeemUrl", () => {
  it("默认兑换页挂到该店路径", () => {
    expect(shopRedeemPath("onlywjt")).toBe("/s/onlywjt/recharge");
    expect(resolveShopRedeemUrl("", "onlywjt")).toBe("/s/onlywjt/recharge");
    expect(resolveShopRedeemUrl("/recharge", "onlywjt")).toBe("/s/onlywjt/recharge");
    expect(
      resolveShopRedeemUrl("https://cdk.jincieryi.top/agent", "onlywjt"),
    ).toBe("/s/onlywjt/recharge");
    expect(isPlatformRedeemPath("/recharge?code=ab")).toBe(true);
  });

  it("管理员配的其它地址不改", () => {
    expect(resolveShopRedeemUrl("/cdk", "onlywjt")).toBe("/cdk");
    expect(
      resolveShopRedeemUrl("https://cdk.other.com/agent", "onlywjt"),
    ).toBe("https://cdk.other.com/agent");
  });
});

describe("buildRechargePath", () => {
  it("单张带卡密，多张带单号和查询凭证", () => {
    expect(
      buildRechargePath("/s/onlywjt/recharge", { codes: ["ABCD"] }),
    ).toBe("/s/onlywjt/recharge?code=ABCD");
    expect(
      buildRechargePath("/s/onlywjt/recharge", {
        codes: ["A", "B"],
        orderNo: "RS1",
        queryToken: "tok",
      }),
    ).toBe("/s/onlywjt/recharge?order=RS1&qt=tok");
  });

  it("外部兑换地址不加本站查询参数", () => {
    expect(
      buildRechargePath("https://cdk.other.com/agent", { codes: ["ABCD"] }),
    ).toBe("https://cdk.other.com/agent");
  });
});

describe("shop tool paths from pathname", () => {
  it("在店铺子页拼本店地址，平台页回裸路径", () => {
    expect(shopSlugFromPathname("/s/onlywjt/recharge")).toBe("onlywjt");
    expect(shopCdkPath("onlywjt")).toBe("/s/onlywjt/cdk");
    expect(shopLookupPath("onlywjt", "RS1")).toBe("/s/onlywjt/lookup?orderNo=RS1");
    expect(shopLookupPath("", "RS1")).toBe("/lookup?orderNo=RS1");
    expect(shopRedeemPath("")).toBe("/recharge");
  });
});

describe("keepSearchPath", () => {
  it("旧 slug 跳转时保住查询参数", () => {
    expect(keepSearchPath("/recharge", { code: "AB", order: "", qt: undefined })).toBe(
      "/recharge?code=AB",
    );
    expect(keepSearchPath("/cdk", {})).toBe("/cdk");
  });
});
