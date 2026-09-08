import { describe, expect, it } from "vitest";
import { planToProduct } from "./agent-storefront-config";

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
