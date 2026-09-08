import { describe, expect, it } from "vitest";
import { MAX_CATEGORY_LENGTH, normalizeCategory } from "./plan-category";

describe("normalizeCategory", () => {
  it("空值统一成空串", () => {
    expect(normalizeCategory(null)).toBe("");
    expect(normalizeCategory(undefined)).toBe("");
    expect(normalizeCategory("   ")).toBe("");
  });

  it("同一个分类的不同写法收敛成一个", () => {
    expect(normalizeCategory(" AI 会员 ")).toBe("AI 会员");
    expect(normalizeCategory("AI  会员")).toBe("AI 会员");
    expect(normalizeCategory("AI\t会员")).toBe("AI 会员");
  });

  it("超长标签截断到上限", () => {
    const long = "分".repeat(MAX_CATEGORY_LENGTH + 5);
    expect(normalizeCategory(long)).toHaveLength(MAX_CATEGORY_LENGTH);
  });
});
