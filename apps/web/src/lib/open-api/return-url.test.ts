import { describe, expect, it } from "vitest";
import { buildReturnUrl, checkReturnUrl } from "./return-url";

describe("checkReturnUrl", () => {
  it("accepts https with the order placeholder", () => {
    expect(checkReturnUrl(" https://shop.example.com/pay/done?no={order_no} ")).toEqual({
      ok: true,
      url: "https://shop.example.com/pay/done?no={order_no}",
    });
  });

  it("rejects http, javascript and credentials", () => {
    expect(checkReturnUrl("http://shop.example.com/").ok).toBe(false);
    expect(checkReturnUrl("javascript:alert(1)").ok).toBe(false);
    expect(checkReturnUrl("https://u:p@example.com/").ok).toBe(false);
  });

  it("rejects empty, malformed and overlong values", () => {
    expect(checkReturnUrl("").ok).toBe(false);
    expect(checkReturnUrl("not a url").ok).toBe(false);
    expect(checkReturnUrl(`https://shop.example.com/${"a".repeat(500)}`).ok).toBe(false);
  });
});

describe("buildReturnUrl", () => {
  it("replaces every placeholder", () => {
    expect(buildReturnUrl("https://s.example.com/o/{order_no}?n={order_no}", "KS123")).toBe(
      "https://s.example.com/o/KS123?n=KS123",
    );
  });

  it("leaves urls without a placeholder alone", () => {
    expect(buildReturnUrl("https://s.example.com/done", "KS123")).toBe("https://s.example.com/done");
  });
});
