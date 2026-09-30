import { describe, expect, it } from "vitest";
import {
  formatRegionWhitelist,
  groupPlansByBase,
  parseRegionWhitelist,
  planRegionCapable,
  planNameWithRegion,
  planWithRegion,
  regionConfirmationRequired,
  regionDisplay,
  sortRegionSpecs,
  type PlanGroupInput,
} from "./regions";

describe("regionDisplay", () => {
  it("空串是菲区", () => {
    expect(regionDisplay("")).toEqual({ country: "", code: "PH", zh: "菲区", en: "Philippines" });
  });

  it("空白和大小写都归一", () => {
    expect(regionDisplay(" us ").code).toBe("US");
  });

  it("已知地区", () => {
    expect(regionDisplay("US")).toMatchObject({ code: "US", zh: "美区", en: "United States" });
    expect(regionDisplay("CL")).toMatchObject({ code: "CL", zh: "智利区", en: "Chile" });
  });

  it("未知地区用短码加区", () => {
    expect(regionDisplay("JP")).toMatchObject({ code: "JP", zh: "JP区", en: "JP" });
  });

  it("region_label 只覆盖中文名", () => {
    expect(regionDisplay("US", "美国区")).toMatchObject({ zh: "美国区", en: "United States" });
    expect(regionDisplay("", "菲律宾")).toMatchObject({ zh: "菲律宾", code: "PH" });
  });
});

describe("planWithRegion", () => {
  it("两种拼法", () => {
    expect(planWithRegion("Plus", "US")).toBe("Plus · 美区");
    expect(planWithRegion("Plus", "US", "", "paren")).toBe("Plus（美区）");
    expect(planWithRegion("Plus", "")).toBe("Plus · 菲区");
  });

  it("没有地区概念时返回原名", () => {
    expect(planNameWithRegion("Codex 点数 500", false, "")).toBe("Codex 点数 500");
    expect(planNameWithRegion("Plus", true, "CL")).toBe("Plus · 智利区");
  });
});

describe("sortRegionSpecs", () => {
  it("菲区在前，其余按 sortOrder 再按地区码", () => {
    const sorted = sortRegionSpecs([
      { planKey: "plus:cl", paymentCountry: "CL", sortOrder: 2 },
      { planKey: "plus:us", paymentCountry: "US", sortOrder: 2 },
      { planKey: "plus", paymentCountry: "", sortOrder: 9 },
    ]);
    expect(sorted.map((item) => item.planKey)).toEqual(["plus", "plus:cl", "plus:us"]);
  });
});

function plan(partial: Partial<PlanGroupInput> & { planKey: string }): PlanGroupInput {
  return {
    basePlanKey: "",
    name: partial.planKey,
    paymentCountry: "",
    regionLabel: "",
    regionCapable: true,
    sortOrder: 0,
    ...partial,
  };
}

describe("groupPlansByBase", () => {
  it("按基础套餐分组，菲区行当代表", () => {
    const groups = groupPlansByBase([
      plan({ planKey: "plus:us", basePlanKey: "plus", paymentCountry: "US", sortOrder: 2 }),
      plan({ planKey: "plus", basePlanKey: "plus", name: "Plus", sortOrder: 1 }),
      plan({ planKey: "plus:cl", basePlanKey: "plus", paymentCountry: "CL", sortOrder: 2 }),
      plan({ planKey: "pro", basePlanKey: "pro", name: "Pro", sortOrder: 5 }),
    ]);
    expect(groups.map((group) => group.baseKey)).toEqual(["plus", "pro"]);
    expect(groups[0].primary.planKey).toBe("plus");
    expect(groups[0].plans.map((item) => item.planKey)).toEqual(["plus", "plus:cl", "plus:us"]);
  });

  it("组内没有菲区时取排序第一行", () => {
    const groups = groupPlansByBase([
      plan({ planKey: "plus:us", basePlanKey: "plus", paymentCountry: "US", sortOrder: 3 }),
      plan({ planKey: "plus:cl", basePlanKey: "plus", paymentCountry: "CL", sortOrder: 1 }),
    ]);
    expect(groups[0].primary.planKey).toBe("plus:cl");
  });

  it("老数据没有 base_plan_key 时自成一组", () => {
    const groups = groupPlansByBase([plan({ planKey: "plus", basePlanKey: "" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].baseKey).toBe("plus");
  });
});

describe("parseRegionWhitelist", () => {
  it("去重、归一、丢掉非法项", () => {
    expect(parseRegionWhitelist("us, CL, us, japan, P, US")).toEqual(["US", "CL"]);
    expect(formatRegionWhitelist(["cl", "US"])).toBe("CL,US");
  });
});

describe("planRegionCapable", () => {
  it("点数档和续费档不做地区版", () => {
    expect(planRegionCapable({ key: "plus", name: "Plus", raw: {} })).toBe(true);
    expect(
      planRegionCapable({ key: "credit500", name: "点数", raw: { registry: { is_credit: true } } }),
    ).toBe(false);
    expect(
      planRegionCapable({
        key: "plus_renew",
        name: "Plus 续费",
        raw: { registry: { requires_active_subscription: true } },
      }),
    ).toBe(false);
  });

  it("registry 没有标记时按名字兜底", () => {
    expect(planRegionCapable({ key: "plus", name: "Plus 续费", raw: {} })).toBe(false);
    expect(planRegionCapable({ key: "plus", name: "Plus", raw: {} })).toBe(true);
  });
});

describe("regionConfirmationRequired", () => {
  it("两个及以上地区才需要确认", () => {
    expect(regionConfirmationRequired(1)).toBe(false);
    expect(regionConfirmationRequired(2)).toBe(true);
  });
});
