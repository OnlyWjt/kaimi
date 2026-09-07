import { describe, expect, it } from "vitest";
import { buildAgentWelcomeText } from "./agent-welcome-core";

describe("agent welcome text", () => {
  it("fills login, start url, and password for a new agent", () => {
    expect(
      buildAgentWelcomeText({
        displayName: "小陈",
        loginUrl: "https://shop.example/login",
        startUrl: "https://shop.example/start",
        username: "chen",
        password: "secret-8",
      }),
    ).toBe(
      [
        "小陈，这是你的店铺后台。",
        "",
        "登录：https://shop.example/login",
        "用户名：chen",
        "密码：secret-8",
        "上手说明：https://shop.example/start",
        "",
        "登录后先改密码，再设店铺链接和零售价（必须落在可填区间里），然后把店铺链接发给客户。",
        "客户付款后自动出卡密，一张单可以买多张，不用你手动发货。",
        "客户用邮箱查单只能看到卡密后几位，完整卡密要用订单号。",
      ].join("\n"),
    );
  });

  it("omits password when the admin only has the username", () => {
    const text = buildAgentWelcomeText({
      loginUrl: "https://shop.example/login",
      startUrl: "https://shop.example/start",
      username: "chen",
    });
    expect(text).toContain("密码：用我单独发给你的那条");
    expect(text).not.toContain("密码：chen");
  });
});
