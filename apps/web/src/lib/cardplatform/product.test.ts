import { describe, expect, it } from "vitest";
import { parsePlansCatalog } from "./client";
import { issueTargetFromSnapshot } from "./issue-target";
import { assessEligibility, parsePreflight } from "./preflight-core";
import {
  grokCredential,
  localPlanKey,
  productOfPlanKey,
  resolveCardProduct,
  scopePaymentRegions,
  summarizeProductSync,
  upstreamIssuePlanKey,
  xCredential,
  xCredentialEmail,
} from "./product";

describe("productOfPlanKey", () => {
  it("本站键按前缀分线，地区变体看冒号前面", () => {
    expect(productOfPlanKey("plus")).toBe("gpt");
    expect(productOfPlanKey("plus:us")).toBe("gpt");
    expect(productOfPlanKey("credit250")).toBe("gpt");
    expect(productOfPlanKey("pro_20x_renew")).toBe("gpt");
    expect(productOfPlanKey("x_premium_monthly")).toBe("x");
    expect(productOfPlanKey("x_premium_plus_yearly:us")).toBe("x");
    expect(productOfPlanKey("grok_premium_monthly")).toBe("grok");
    expect(productOfPlanKey("grok_super_yearly")).toBe("grok");
  });

  it("卡台裸键：premium_* 归 X，plus / super / ultra 与旧键归 Grok", () => {
    expect(productOfPlanKey("premium_monthly")).toBe("x");
    expect(productOfPlanKey("basic_yearly")).toBe("x");
    expect(productOfPlanKey("plus_monthly")).toBe("grok");
    expect(productOfPlanKey("ultra_yearly")).toBe("grok");
    expect(productOfPlanKey("heavy_monthly")).toBe("grok");
    expect(productOfPlanKey("monthly")).toBe("grok");
  });

  it("卡台 preview 给了 product 就用它", () => {
    expect(resolveCardProduct("grok", "premium_monthly")).toBe("grok");
    expect(resolveCardProduct("chatgpt", "plus")).toBe("gpt");
    expect(resolveCardProduct("", "premium_monthly")).toBe("x");
    expect(resolveCardProduct("plus", "plus")).toBe("gpt");
  });
});

describe("上游键", () => {
  it("X 发裸键，Grok 带 grok_，GPT 原样", () => {
    expect(localPlanKey("x", "premium_monthly")).toBe("x_premium_monthly");
    expect(localPlanKey("grok", "premium_monthly")).toBe("grok_premium_monthly");
    expect(localPlanKey("gpt", "plus")).toBe("plus");
    expect(upstreamIssuePlanKey("x", "x_premium_monthly:us")).toBe("premium_monthly");
    expect(upstreamIssuePlanKey("grok", "premium_monthly")).toBe("grok_premium_monthly");
    expect(upstreamIssuePlanKey("grok", "grok_plus_yearly")).toBe("grok_plus_yearly");
    expect(upstreamIssuePlanKey("gpt", "plus")).toBe("plus");
  });

  it("发码快照兜底：Grok 补 US，X 补 JP，老快照的 x_ 前缀去掉", () => {
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "grok_premium_monthly", upstreamPlanKeySnapshot: "", paymentCountrySnapshot: "" }),
    ).toEqual({ plan: "grok_premium_monthly", paymentCountry: "US" });
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "grok_premium_monthly", upstreamPlanKeySnapshot: "grok_premium_monthly", paymentCountrySnapshot: "JP" }),
    ).toEqual({ plan: "grok_premium_monthly", paymentCountry: "US" });
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "x_premium_monthly", upstreamPlanKeySnapshot: "x_premium_monthly", paymentCountrySnapshot: "" }),
    ).toEqual({ plan: "premium_monthly", paymentCountry: "JP" });
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "x_premium_monthly:us", upstreamPlanKeySnapshot: "premium_monthly", paymentCountrySnapshot: "us" }),
    ).toEqual({ plan: "premium_monthly", paymentCountry: "US" });
  });

  it("地区按产品收窄", () => {
    const regions = [
      { country: "PH", currency: "PHP" },
      { country: "US", currency: "USD" },
      { country: "CL", currency: "CLP" },
    ];
    expect(scopePaymentRegions("gpt", regions)).toEqual(regions);
    expect(scopePaymentRegions("grok", regions)).toEqual([{ country: "US", currency: "USD" }]);
    expect(scopePaymentRegions("x", regions).map((r) => r.country)).toEqual(["PH", "US"]);
    expect(scopePaymentRegions("x", [{ country: "CL", currency: "CLP" }])).toEqual([
      { country: "JP", currency: "JPY" },
    ]);
  });
});

describe("parsePlansCatalog", () => {
  // 卡台 ?product=x 的样子：定价表带前缀，注册表是裸键（取自 danew x_premium_test.go）。
  const xCatalog = {
    version: 7,
    plans: {
      plus: { enabled: true, serviceFeeUsdMinor: 0 },
      x_basic_monthly: { enabled: true, serviceFeeUsdMinor: 10 },
      x_premium_monthly: { enabled: true, serviceFeeUsdMinor: 10 },
      x_premium_plus_yearly: { enabled: false, serviceFeeUsdMinor: 10 },
    },
    registry: [
      { key: "premium_monthly", label: "X Premium 月付", sort_order: 2 },
      { key: "basic_monthly", label: "X Basic 月付", sort_order: 1 },
      { key: "premium_plus_yearly", label: "X Premium+ 年付", sort_order: 3 },
      { key: "premium_yearly", label: "没定价的档", sort_order: 4 },
    ],
    payment_regions: [
      { country: "JP", currency: "JPY" },
      { country: "CL", currency: "CLP" },
      { country: "US", currency: "USD" },
    ],
  };

  it("X：以注册表为准，键换成本站带前缀的键，停用和没定价的丢掉", () => {
    const { plans, regions } = parsePlansCatalog(xCatalog, "x");
    expect(plans.map((plan) => [plan.key, plan.upstreamKey, plan.name])).toEqual([
      ["x_basic_monthly", "basic_monthly", "X Basic 月付"],
      ["x_premium_monthly", "premium_monthly", "X Premium 月付"],
    ]);
    expect(plans.every((plan) => plan.product === "x")).toBe(true);
    expect(regions.map((region) => region.country)).toEqual(["JP", "US"]);
  });

  it("Grok：取 grok_ 前缀的定价，地区固定 US", () => {
    const { plans, regions } = parsePlansCatalog(
      {
        plans: {
          grok_premium_monthly: { enabled: true },
          grok_super_yearly: { enabled: true },
          premium_monthly: { enabled: true },
        },
        registry: [
          { key: "premium_monthly", label: "Grok Premium 月付", sort_order: 1 },
          { key: "super_yearly", label: "Grok Super 年付", sort_order: 2 },
        ],
        payment_regions: [{ country: "PH", currency: "PHP" }],
      },
      "grok",
    );
    expect(plans.map((plan) => [plan.key, plan.upstreamKey])).toEqual([
      ["grok_premium_monthly", "grok_premium_monthly"],
      ["grok_super_yearly", "grok_super_yearly"],
    ]);
    expect(regions).toEqual([{ country: "US", currency: "USD" }]);
  });

  it("老卡台不认 product 参数、回的是 GPT 目录：X / Grok 一条都不出", () => {
    const gptCatalog = {
      plans: { plus: { enabled: true }, pro_20x: { enabled: true } },
      registry: [{ key: "plus" }, { key: "pro_20x" }],
    };
    expect(parsePlansCatalog(gptCatalog, "x").plans).toEqual([]);
    expect(parsePlansCatalog(gptCatalog, "grok").plans).toEqual([]);
  });

  it("GPT 目录剔掉混进来的 x_* / grok_* 键", () => {
    const { plans } = parsePlansCatalog(
      {
        plans: {
          plus: { enabled: true },
          x_premium_monthly: { enabled: true },
          grok_premium_monthly: { enabled: true },
          claude_pro: { enabled: true },
        },
      },
      "gpt",
    );
    expect(plans.map((plan) => plan.key)).toEqual(["plus"]);
  });
});

describe("兑换凭证", () => {
  it("Grok：整段 cookie 原样，只粘值时补 sso=", () => {
    expect(grokCredential("foo=1; sso=abcdefghijklmnop; bar=2")).toEqual({
      ok: true,
      session: "foo=1; sso=abcdefghijklmnop; bar=2",
    });
    expect(grokCredential("eyJhbGciOiJIUzI1NiJ9.abc")).toEqual({
      ok: true,
      session: "sso=eyJhbGciOiJIUzI1NiJ9.abc",
    });
    expect(grokCredential('{"accessToken":"x"}').ok).toBe(false);
    expect(grokCredential("").ok).toBe(false);
  });

  it("X：要账单邮箱，加 auth_token / ct0 或 cookieHeader", () => {
    const tokens = JSON.stringify({
      billing_email: "a@b.co",
      auth_token: "a".repeat(40),
      ct0: "b".repeat(32),
    });
    expect(xCredential(tokens)).toEqual({ ok: true, session: tokens });
    expect(xCredentialEmail(tokens)).toBe("a@b.co");
    const header = JSON.stringify({
      billing_email: "a@b.co",
      cookieHeader: "auth_token=xxx; ct0=yyy",
    });
    expect(xCredential(header).ok).toBe(true);
    const noEmail = xCredential(JSON.stringify({ auth_token: "a".repeat(40), ct0: "b".repeat(32) }));
    expect(noEmail.ok).toBe(false);
    expect(xCredential("auth_token=xxx").ok).toBe(false);
  });
});

describe("X / Grok 的资格判断", () => {
  const account = (blocking_reason = "") =>
    parsePreflight({ code: 0, data: { email: "a@b.co", blocking_reason } });

  it("只认卡台给的拦截原因，不套 ChatGPT 的档位规则", () => {
    expect(assessEligibility(account(), "grok_premium_monthly").verdict).toBe("ok");
    const blocked = assessEligibility(account("该账号已有 SuperGrok 订阅"), "grok_premium_monthly");
    expect(blocked.verdict).toBe("block");
    expect(blocked.reasons).toEqual(["该账号已有 SuperGrok 订阅"]);
    expect(assessEligibility(account(), "x_premium_monthly").verdict).toBe("ok");
  });
});

describe("summarizeProductSync", () => {
  it("一句话汇总每条线", () => {
    expect(
      summarizeProductSync([
        { product: "gpt", count: 12, created: 0 },
        { product: "x", count: 6, created: 6 },
        { product: "grok", count: 0, error: "卡台超时" },
      ]),
    ).toBe("ChatGPT 12 个 · X 订阅码 6 个（新拉到 6 个） · Grok 失败：卡台超时");
  });
});

describe("多产品线的展示和兜底", () => {
  it("套餐名补产品名，已经带了不重复", async () => {
    const { brandedPlanName } = await import("./product");
    expect(brandedPlanName("grok", "Premium 月付")).toBe("Grok Premium 月付");
    expect(brandedPlanName("grok", "Grok Premium 月付")).toBe("Grok Premium 月付");
    expect(brandedPlanName("grok", "SuperGrok 月付")).toBe("Grok SuperGrok 月付");
    expect(brandedPlanName("x", "Premium+ 年付")).toBe("X Premium+ 年付");
    expect(brandedPlanName("x", "X Basic")).toBe("X Basic");
    expect(brandedPlanName("gpt", "Plus")).toBe("Plus");
  });

  it("裸 premium_* 分不清 X 还是 Grok", async () => {
    const { isAmbiguousBareKey } = await import("./product");
    expect(isAmbiguousBareKey("premium_monthly")).toBe(true);
    expect(isAmbiguousBareKey("premium_plus_monthly")).toBe(false);
    expect(isAmbiguousBareKey("x_premium_monthly")).toBe(false);
    expect(isAmbiguousBareKey("plus")).toBe(false);
  });

  it("店铺：多条线时按 ChatGPT → X → Grok 排，没分类的 ChatGPT 归到「ChatGPT」", async () => {
    const { arrangeStorefrontPlans } = await import("./product");
    const rows = arrangeStorefrontPlans([
      { planKey: "grok_premium_monthly", product: "grok", category: "Grok", sortOrder: 1 },
      { planKey: "plus", product: "gpt", category: "", sortOrder: 2 },
      { planKey: "x_basic_monthly", product: "x", category: "X 订阅码", sortOrder: 1 },
      { planKey: "finished_gpt", product: "gpt", category: "", sortOrder: 9, fulfillmentKind: "local_account" },
    ]);
    const sorted = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(sorted.map((row) => [row.planKey, row.category])).toEqual([
      ["plus", "ChatGPT"],
      ["finished_gpt", ""],
      ["x_basic_monthly", "X 订阅码"],
      ["grok_premium_monthly", "Grok"],
    ]);
    // 只卖 ChatGPT 时分类保持原样
    expect(arrangeStorefrontPlans([{ product: "gpt", category: "", sortOrder: 1 }])[0].category).toBe("");
  });

  it("发码快照里的产品线优先于按键推", () => {
    // 一个碰巧叫 plus_monthly 的 GPT 档：按键会被认成 Grok，带了快照就不会。
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "plus_monthly", productSnapshot: "gpt", upstreamPlanKeySnapshot: "plus_monthly" }),
    ).toEqual({ plan: "plus_monthly", paymentCountry: "" });
  });
});

describe("Grok 首月半价档位", () => {
  it("_half 键认成 Grok，去掉后缀拿到正价键；Plus 半价仍是 GPT", async () => {
    const { grokFullPricePlanKey, isGrokHalfPlanKey } = await import("./product");
    expect(productOfPlanKey("grok_premium_monthly_half")).toBe("grok");
    expect(productOfPlanKey("grok_ultra_monthly_half")).toBe("grok");
    expect(productOfPlanKey("plus_half")).toBe("gpt");
    expect(isGrokHalfPlanKey("grok_super_monthly_half")).toBe(true);
    expect(isGrokHalfPlanKey("GROK_Super_Monthly_HALF")).toBe(true);
    expect(isGrokHalfPlanKey("grok_super_monthly")).toBe(false);
    expect(isGrokHalfPlanKey("plus_half")).toBe(false);
    // 年付和 Plus 没有首月优惠，不是半价键
    expect(isGrokHalfPlanKey("grok_super_yearly_half")).toBe(false);
    expect(isGrokHalfPlanKey("grok_plus_monthly_half")).toBe(false);
    expect(grokFullPricePlanKey("grok_premium_monthly_half")).toBe("grok_premium_monthly");
    expect(grokFullPricePlanKey("grok_premium_monthly")).toBe("grok_premium_monthly");
  });

  it("只有月付 Premium / Super / Ultra 生成半价档位，发码用正价键", async () => {
    const { withGrokHalfPlans } = await import("./product");
    const plan = (key: string, name: string) => ({
      key,
      upstreamKey: key,
      name,
      enabled: true,
      raw: { enabled: true },
    });
    const rows = withGrokHalfPlans([
      plan("grok_plus_monthly", "Grok Plus 月付"),
      plan("grok_premium_monthly", "Grok Premium 月付"),
      plan("grok_super_yearly", "Grok Super 年付"),
      plan("grok_ultra_monthly", "Grok Ultra 月付"),
    ]);
    expect(rows.map((row) => [row.key, row.upstreamKey, row.name])).toEqual([
      ["grok_plus_monthly", "grok_plus_monthly", "Grok Plus 月付"],
      ["grok_premium_monthly", "grok_premium_monthly", "Grok Premium 月付"],
      ["grok_premium_monthly_half", "grok_premium_monthly", "Grok Premium 月付（首月半价）"],
      ["grok_super_yearly", "grok_super_yearly", "Grok Super 年付"],
      ["grok_ultra_monthly", "grok_ultra_monthly", "Grok Ultra 月付"],
      ["grok_ultra_monthly_half", "grok_ultra_monthly", "Grok Ultra 月付（首月半价）"],
    ]);
    expect(rows[2]?.raw).toEqual({ enabled: true, half_of: "grok_premium_monthly" });
  });

  it("半价订单发给卡台的是正价键，老快照没有上游键也一样", () => {
    expect(upstreamIssuePlanKey("grok", "grok_premium_monthly_half")).toBe("grok_premium_monthly");
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "grok_super_monthly_half", upstreamPlanKeySnapshot: "grok_super_monthly", productSnapshot: "grok" }),
    ).toEqual({ plan: "grok_super_monthly", paymentCountry: "US" });
    expect(
      issueTargetFromSnapshot({ planKeySnapshot: "grok_super_monthly_half", upstreamPlanKeySnapshot: "" }),
    ).toEqual({ plan: "grok_super_monthly", paymentCountry: "US" });
  });

  it("展示名补「（首月半价）」，已经带了或不是半价键不动", async () => {
    const { halfPlanDisplayName } = await import("./product");
    expect(halfPlanDisplayName("grok_premium_monthly_half", "Grok Premium 月付")).toBe("Grok Premium 月付（首月半价）");
    expect(halfPlanDisplayName("grok_premium_monthly_half", "Premium 首月半价")).toBe("Premium 首月半价");
    expect(halfPlanDisplayName("grok_premium_monthly", "Grok Premium 月付")).toBe("Grok Premium 月付");
  });
});

describe("splitHalfPlanName", () => {
  it("名字结尾的（首月半价）拿出来当标签；只有键也认", async () => {
    const { splitHalfPlanName } = await import("./product");
    expect(splitHalfPlanName("Grok Premium 月付（首月半价）")).toEqual({ name: "Grok Premium 月付", half: true });
    expect(splitHalfPlanName("代理A · Grok 会员（首月半价）", "grok_super_monthly_half")).toEqual({
      name: "代理A · Grok 会员",
      half: true,
    });
    expect(splitHalfPlanName("grok_premium_monthly_half", "grok_premium_monthly_half")).toEqual({
      name: "grok_premium_monthly_half",
      half: true,
    });
    expect(splitHalfPlanName("Grok Premium 月付", "grok_premium_monthly")).toEqual({ name: "Grok Premium 月付", half: false });
    expect(splitHalfPlanName("Plus 半价", "plus_half")).toEqual({ name: "Plus 半价", half: false });
  });
});
