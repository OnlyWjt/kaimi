import { describe, expect, it } from "vitest";
import {
  coverFromPlan,
  planToProduct,
  resolveProductName,
  rowToSettings,
  settingsToRow,
  shopNameSchema,
} from "./agent-storefront-config";

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

describe("resolveProductName", () => {
  it("没写覆盖时用平台套餐名", () => {
    expect(resolveProductName("plus", "Plus")).toEqual({ zh: "Plus", en: "Plus" });
  });

  it("代理写了中文名就覆盖前台标题", () => {
    expect(
      resolveProductName("plus", "Plus", { plus: { zh: "Codex Plus 月卡", en: "" } }),
    ).toEqual({ zh: "Codex Plus 月卡", en: "Codex Plus 月卡" });
  });
});

describe("planToProduct 自定义名称", () => {
  it("有覆盖时卡片标题用代理写的名字", () => {
    const product = planToProduct(basePlan, {
      plus: { zh: "我的 Plus", en: "My Plus" },
    });
    expect(product.name).toEqual({ zh: "我的 Plus", en: "My Plus" });
  });
});

describe("planToProduct 成品号", () => {
  it("成品号不显示库存数，缺货也只标补货中", () => {
    const product = planToProduct({
      planKey: "finished_gpt",
      name: "GPT 成品号",
      description: "",
      retailPriceCents: 990,
      fulfillmentKind: "local_account",
      available: false,
    });
    expect(product.kind).toBe("account");
    expect(product.available).toBe(false);
    expect(product.stock).toBeNull();
    expect(product.subtitle.zh).toContain("成品账号");
  });
});

describe("装修配置商品名落库", () => {
  it("空覆盖不落库，读回来还是空对象", () => {
    const row = settingsToRow({
      slogan: { zh: "", en: "" },
      logoLetter: "",
      announcement: { enabled: false, text: { zh: "", en: "" } },
      hero: { enabled: true, chip: { zh: "", en: "" }, title: { zh: "", en: "" }, sub: { zh: "", en: "" } },
      stats: { enabled: false, items: [] },
      searchEnabled: true,
      queryEnabled: true,
      contacts: [],
      defaultLang: "zh",
      languages: ["zh"],
      productNames: { plus: { zh: "店内 Plus", en: "" } },
    });
    expect(JSON.parse(row.productNamesJson)).toEqual({ plus: { zh: "店内 Plus", en: "" } });
    expect(rowToSettings(row).productNames).toEqual({ plus: { zh: "店内 Plus", en: "" } });
  });
});

describe("shopNameSchema", () => {
  it("收下 1–64 字的店名，空的不要", () => {
    expect(shopNameSchema.parse(" onlyWjt ")).toBe("onlyWjt");
    expect(shopNameSchema.safeParse("").success).toBe(false);
    expect(shopNameSchema.safeParse("x".repeat(65)).success).toBe(false);
  });
});

describe("coverFromPlan", () => {
  it("六个在售套餐各有带标识的封面", () => {
    expect(coverFromPlan("Plus", "plus")).toBe("/storefront/cover-plus.png?v=8");
    expect(coverFromPlan("Pro 5x", "pro_5x")).toBe("/storefront/cover-pro-5x.png?v=8");
    expect(coverFromPlan("Pro", "pro_20x")).toBe("/storefront/cover-pro.png?v=8");
    expect(coverFromPlan("Codex 点数 250", "credit250")).toBe("/storefront/cover-codex-250.png?v=8");
    expect(coverFromPlan("Codex 点数 500", "credit500")).toBe("/storefront/cover-codex-500.png?v=8");
    expect(coverFromPlan("Codex 点数 1000", "credit1000")).toBe(
      "/storefront/cover-codex-1000.png?v=8",
    );
  });

  it("没对上的套餐不硬套 GPT 图", () => {
    expect(coverFromPlan("其它套餐", "other")).toBe("");
    expect(coverFromPlan("Claude Pro", "claude")).toBe("/storefront/cover-claude.png?v=2");
  });
});
