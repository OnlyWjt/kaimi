import { describe, expect, it } from "vitest";
import { maskOrderNo } from "./order-no-mask";

describe("maskOrderNo", () => {
  it("keeps prefix and last four of a real order number", () => {
    expect(maskOrderNo("KS2026091408307Q4FABCDEFGH")).toBe("KS2026…EFGH");
  });

  it("never returns the full value", () => {
    const full = "KS202609140830ABCDEFGHJK";
    expect(maskOrderNo(full)).not.toBe(full);
    expect(maskOrderNo(full).replace("…", "").length).toBeLessThan(full.length);
  });

  it("handles short values", () => {
    expect(maskOrderNo("ABCDEFG")).toBe("…DEFG");
    expect(maskOrderNo("ABC")).toBe("ABC");
  });
});
