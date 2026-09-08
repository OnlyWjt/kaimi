import { describe, expect, it } from "vitest";
import { coverFromPlan, planToProduct } from "./agent-storefront-config";

const basePlan = {
  planKey: "plus",
  name: "ChatGPT Plus 月卡",
  description: "",
  retailPriceCents: 15000,
};

describe("planToProduct 分类映射", () => {
  it("没填分类时落到 all，前台不显示分类行", () => {
    const product = planToProduct(basePlan);
    expect(product.category).toBe("all");
    expect(product.categoryLabel).toBe("");
  });

  it("填了分类时标签同时当作分组 id", () => {
    const product = planToProduct({ ...basePlan, category: "Codex 点数" });
    expect(product.category).toBe("Codex 点数");
    expect(product.categoryLabel).toBe("Codex 点数");
  });

  it("写法不一致的同名分类会归到一组", () => {
    const a = planToProduct({ ...basePlan, category: " AI 会员 " });
    const b = planToProduct({ ...basePlan, planKey: "pro", category: "AI  会员" });
    expect(a.category).toBe(b.category);
  });
});

describe("coverFromPlan", () => {
  it("六个在售套餐各有带标识的封面", () => {
    expect(coverFromPlan("Plus", "plus")).toBe("/storefront/cover-plus.png?v=4");
    expect(coverFromPlan("Pro 5x", "pro_5x")).toBe("/storefront/cover-pro-5x.png?v=4");
    expect(coverFromPlan("Pro", "pro_20x")).toBe("/storefront/cover-pro.png?v=4");
    expect(coverFromPlan("Codex 点数 250", "credit250")).toBe("/storefront/cover-codex-250.png?v=4");
    expect(coverFromPlan("Codex 点数 500", "credit500")).toBe("/storefront/cover-codex-500.png?v=4");
    expect(coverFromPlan("Codex 点数 1000", "credit1000")).toBe(
      "/storefront/cover-codex-1000.png?v=4",
    );
  });

  it("没对上的套餐不硬套 GPT 图", () => {
    expect(coverFromPlan("其它套餐", "other")).toBe("");
    expect(coverFromPlan("Claude Pro", "claude")).toBe("/storefront/cover-claude.png?v=2");
  });
});
