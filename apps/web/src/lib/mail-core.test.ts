import { describe, expect, it } from "vitest";
import { buildMailFrom, isValidMailFrom, mailDisplayName } from "./mail-core";

describe("mailDisplayName", () => {
  it("去掉 CR/LF 与双引号", () => {
    expect(mailDisplayName(' Kai"mi\r\nBcc: x@evil.com ')).toBe("KaimiBcc: x@evil.com");
  });
});

describe("isValidMailFrom", () => {
  it("空串允许（回退 SMTP 用户名）", () => {
    expect(isValidMailFrom("")).toBe(true);
    expect(isValidMailFrom("   ")).toBe(true);
  });
  it("合法邮箱通过，非法拒绝", () => {
    expect(isValidMailFrom("noreply@example.com")).toBe(true);
    expect(isValidMailFrom("not-an-email")).toBe(false);
    expect(isValidMailFrom("a@b.com\r\nBcc: c@d.com")).toBe(false);
  });
});

describe("buildMailFrom", () => {
  it("有显示名时返回对象", () => {
    expect(buildMailFrom('Shop "X"', " a@b.com ")).toEqual({ name: "Shop X", address: "a@b.com" });
  });
  it("无显示名时返回地址", () => {
    expect(buildMailFrom("  ", "a@b.com")).toBe("a@b.com");
  });
});
