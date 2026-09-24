import { describe, expect, it } from "vitest";
import { publicShopName } from "./agent-names";
import { agentIdentityLabel } from "./agent-identity-core";

describe("publicShopName", () => {
  it("prefers a trimmed shop name", () => {
    expect(publicShopName({ shopName: " 小店 ", displayName: "显示名" })).toBe("小店");
  });

  it("falls back to display name", () => {
    expect(publicShopName({ shopName: "  ", displayName: "显示名" })).toBe("显示名");
  });
});

describe("agentIdentityLabel", () => {
  it("puts real name, login and shop together", () => {
    expect(
      agentIdentityLabel({
        realName: "张三",
        displayName: "店长",
        username: "zhang",
        shopName: "小店",
      }),
    ).toBe("张三 · @zhang · 店铺 小店");
  });

  it("omits a shop name that repeats the primary name", () => {
    expect(
      agentIdentityLabel({
        displayName: "小店",
        shopName: "小店",
        username: "zhang",
      }),
    ).toBe("小店 · @zhang");
  });
});
