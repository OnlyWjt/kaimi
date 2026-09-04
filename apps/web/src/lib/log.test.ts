import { describe, expect, it } from "vitest";
import { maskRequestId } from "./log";

describe("maskRequestId", () => {
  it("只留够对账的头尾，令牌本体不出现在通知里", () => {
    const token = "abcdefghijklmnopqrstuvwx";
    const masked = maskRequestId(`cp:12:${token}`);
    expect(masked).toBe("cp:12:abcd***uvwx");
    expect(masked).not.toContain(token);
  });

  it("令牌短到头尾会拼出全貌时整段打掉", () => {
    expect(maskRequestId("cp:7:abcdefghijkl")).toBe("cp:7:***");
    expect(maskRequestId("cp:7:abc")).toBe("cp:7:***");
  });

  it("不是 cp: 形态的 request_id 原样返回", () => {
    // 自营发卡链路的 request_id 不含凭证，运维还得靠它对账。
    expect(maskRequestId("ord-20240101-0001")).toBe("ord-20240101-0001");
    expect(maskRequestId("")).toBe("");
    expect(maskRequestId(null)).toBe("");
    expect(maskRequestId(undefined)).toBe("");
  });
});
