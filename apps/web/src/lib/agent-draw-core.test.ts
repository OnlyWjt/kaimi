import { describe, expect, it } from "vitest";
import {
  beijingDateEndExclusiveIso,
  beijingDateStartIso,
  beijingDayStartIso,
  drawCodeUseLabel,
  billRevertOpen,
  buildDrawStatementText,
  computeDrawCredit,
  cooldownLeftMs,
  creditHeat,
  creditWarnCrossed,
  drawCreditError,
  drawDailyLimitError,
  drawNoTailMatches,
  drawOrderStatusFromIssued,
  drawQuantityError,
  drawSettingsError,
  drawTodayUsedCount,
  normalizeDrawPaymentMethod,
  toCsv,
  formatYuan,
  isDrawLinkToken,
  newDrawLinkToken,
  parseAllowedPlanKeys,
  planAllowed,
  resolveDrawUnitPrice,
  safeNextPath,
  summarizeDrawItems,
} from "./agent-draw-core";

describe("resolveDrawUnitPrice", () => {
  it("提卡专用价优先", () => {
    expect(
      resolveDrawUnitPrice({ drawPriceCents: 13000, costOverrideCents: 12000, globalCostPriceCents: 12500 }),
    ).toEqual({ unitPriceCents: 13000, source: "draw_override" });
  });

  it("默认按代理成本价", () => {
    expect(
      resolveDrawUnitPrice({ drawPriceCents: null, costOverrideCents: 12000, globalCostPriceCents: 12500 }),
    ).toEqual({ unitPriceCents: 12000, source: "agent_cost" });
  });

  it("代理没单独成本就用全局成本", () => {
    expect(
      resolveDrawUnitPrice({ drawPriceCents: null, costOverrideCents: null, globalCostPriceCents: 12500 }),
    ).toEqual({ unitPriceCents: 12500, source: "global_cost" });
  });

  it("0 视为未配置，全都没有就不能提", () => {
    expect(
      resolveDrawUnitPrice({ drawPriceCents: 0, costOverrideCents: 0, globalCostPriceCents: 12500 }),
    ).toEqual({ unitPriceCents: 12500, source: "global_cost" });
    expect(
      resolveDrawUnitPrice({ drawPriceCents: 0, costOverrideCents: 0, globalCostPriceCents: 0 }),
    ).toBeNull();
  });
});

describe("额度", () => {
  it("敞口 = 未结算 + 在途剩余", () => {
    const credit = computeDrawCredit({
      limitCents: 300000,
      unsettledCents: 50000,
      inflight: [
        { quantity: 3, issuedCount: 1, unitPriceCents: 12500 },
        { quantity: 2, issuedCount: 0, unitPriceCents: 10000 },
      ],
    });
    expect(credit.inflightCents).toBe(45000);
    expect(credit.exposureCents).toBe(95000);
    expect(credit.availableCents).toBe(205000);
  });

  it("刚好用满允许，多 1 分拒绝", () => {
    const credit = computeDrawCredit({ limitCents: 100000, unsettledCents: 62500, inflight: [] });
    expect(drawCreditError(credit, 37500)).toBeNull();
    expect(drawCreditError(credit, 37501)).toContain("还能提");
  });

  it("超额后可用额度不为负", () => {
    const credit = computeDrawCredit({ limitCents: 1000, unsettledCents: 5000, inflight: [] });
    expect(credit.availableCents).toBe(0);
  });

  it("预警只在第一次跨过 80% 时触发", () => {
    expect(creditWarnCrossed({ limitCents: 100000, exposureCents: 79999, alreadyWarned: false })).toBe(false);
    expect(creditWarnCrossed({ limitCents: 100000, exposureCents: 80000, alreadyWarned: false })).toBe(true);
    expect(creditWarnCrossed({ limitCents: 100000, exposureCents: 95000, alreadyWarned: true })).toBe(false);
  });
});

describe("上限", () => {
  it("每日上限 0 表示不限", () => {
    expect(drawDailyLimitError({ dailyLimitCount: 0, todayCount: 999, quantity: 10 })).toBeNull();
  });

  it("每日上限边界", () => {
    expect(drawDailyLimitError({ dailyLimitCount: 10, todayCount: 7, quantity: 3 })).toBeNull();
    expect(drawDailyLimitError({ dailyLimitCount: 10, todayCount: 7, quantity: 4 })).toContain("还能提 3 张");
    expect(drawDailyLimitError({ dailyLimitCount: 10, todayCount: 10, quantity: 1 })).toContain("已达每日上限");
  });

  it("单次张数", () => {
    expect(drawQuantityError(0, 10)).toBeTruthy();
    expect(drawQuantityError(1.5, 10)).toBeTruthy();
    expect(drawQuantityError(10, 10)).toBeNull();
    expect(drawQuantityError(11, 10)).toContain("10");
    expect(drawQuantityError(250, 500)).toContain("200");
  });

  it("北京时间零点切日", () => {
    expect(beijingDayStartIso(new Date("2026-09-30T15:59:59.000Z"))).toBe("2026-09-29T16:00:00.000Z");
    expect(beijingDayStartIso(new Date("2026-09-30T16:00:00.000Z"))).toBe("2026-09-30T16:00:00.000Z");
  });
});

describe("套餐白名单", () => {
  it("空数组表示全部", () => {
    expect(planAllowed([], "plus")).toBe(true);
    expect(planAllowed(["pro"], "plus")).toBe(false);
  });

  it("解析容错", () => {
    expect(parseAllowedPlanKeys('["plus"," pro ","plus",""]')).toEqual(["plus", "pro"]);
    expect(parseAllowedPlanKeys("oops")).toEqual([]);
    expect(parseAllowedPlanKeys('{"a":1}')).toEqual([]);
  });
});

describe("对账", () => {
  const items = [
    { planKey: "plus", planName: "Plus", amountCents: 12500, createdAt: "2026-09-23T02:12:00.000Z" },
    { planKey: "plus", planName: "Plus", amountCents: 12500, createdAt: "2026-09-24T02:12:00.000Z" },
    { planKey: "plus", planName: "Plus", amountCents: 13000, createdAt: "2026-09-25T02:12:00.000Z" },
    { planKey: "pro", planName: "Pro", amountCents: 18000, createdAt: "2026-09-30T07:30:00.000Z" },
  ];

  it("同套餐不同单价分行", () => {
    const summary = summarizeDrawItems(items);
    expect(summary).toHaveLength(3);
    expect(summary.find((row) => row.planKey === "plus" && row.unitPriceCents === 12500)?.count).toBe(2);
  });

  it("对账文本含合计和北京时间范围", () => {
    const text = buildDrawStatementText({ shopName: "Polus", items, voidCount: 1 });
    expect(text).toContain("【Kaimi 提卡对账】Polus");
    expect(text).toContain("2026-09-23 10:12 ～ 2026-09-30 15:30");
    expect(text).toContain("合计 4 张，应付 ¥560.00");
    expect(text).toContain("作废 1 张未计入");
  });

  it("没有未结算时给一句话", () => {
    expect(buildDrawStatementText({ shopName: "Polus", items: [] })).toContain("没有未结算");
  });
});

describe("杂项", () => {
  it("金额千分位", () => {
    expect(formatYuan(138500)).toBe("¥1,385.00");
    expect(formatYuan(5)).toBe("¥0.05");
    expect(formatYuan(-12500)).toBe("-¥125.00");
  });

  it("链接 token", () => {
    const token = newDrawLinkToken();
    expect(token).toHaveLength(24);
    expect(isDrawLinkToken(token)).toBe(true);
    expect(isDrawLinkToken("abc")).toBe(false);
    expect(isDrawLinkToken("I".repeat(24))).toBe(false);
  });

  it("冷却时间", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    expect(cooldownLeftMs(null, 1000, now)).toBe(0);
    expect(cooldownLeftMs("2026-09-30T11:00:00.000Z", 2 * 3_600_000, now)).toBe(3_600_000);
    expect(cooldownLeftMs("2026-09-30T08:00:00.000Z", 2 * 3_600_000, now)).toBe(0);
  });

  it("登录回跳只认站内路径", () => {
    expect(safeNextPath("/agent/draw/ABC")).toBe("/agent/draw/ABC");
    expect(safeNextPath("//evil.com")).toBe("");
    expect(safeNextPath("/\\evil.com")).toBe("");
    expect(safeNextPath("https://evil.com")).toBe("");
  });
});

describe("提卡第二版", () => {
  it("重放时按账本总张数定状态，新写入为 0 也不标失败", () => {
    expect(drawOrderStatusFromIssued(0, 3)).toBe("failed");
    expect(drawOrderStatusFromIssued(2, 3)).toBe("partial");
    expect(drawOrderStatusFromIssued(3, 3)).toBe("delivered");
  });

  it("账单 7 天内可撤销", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    expect(billRevertOpen("2026-09-24T12:00:00.001Z", now)).toBe(true);
    expect(billRevertOpen("2026-09-23T12:00:00.000Z", now)).toBe(false);
  });

  it("确认没出卡要核对单号后四位", () => {
    expect(drawNoTailMatches("DR20260930ABCD", "abcd")).toBe(true);
    expect(drawNoTailMatches("DR20260930ABCD", "abce")).toBe(false);
  });

  it("收款方式必须是预设的几种", () => {
    expect(normalizeDrawPaymentMethod("alipay")).toBe("alipay");
    expect(normalizeDrawPaymentMethod("cash")).toBeNull();
  });

  it("占用达到 80% 标橙，100% 标红", () => {
    expect(creditHeat(0.79)).toBe("ok");
    expect(creditHeat(0.8)).toBe("warn");
    expect(creditHeat(1)).toBe("full");
  });

  it("单次和每日上限的填写范围", () => {
    expect(drawSettingsError({ maxPerDraw: 10, dailyLimitCount: 0 })).toBeNull();
    expect(drawSettingsError({ maxPerDraw: 0, dailyLimitCount: 0 })).toContain("单次");
    expect(drawSettingsError({ maxPerDraw: 10, dailyLimitCount: -1 })).toContain("每日");
  });

  it("手动核销不显示成已作废", () => {
    expect(drawCodeUseLabel("disabled", true)).toBe("手动核销");
    expect(drawCodeUseLabel("unused", false)).toBe("未使用");
  });

  it("归档日期按北京时间切天", () => {
    expect(beijingDateStartIso("2026-10-03")).toBe("2026-10-02T16:00:00.000Z");
    expect(beijingDateEndExclusiveIso("2026-10-03")).toBe("2026-10-03T16:00:00.000Z");
    expect(beijingDateStartIso("10-03")).toBe("");
  });

  it("导出 CSV 带 BOM", () => {
    expect(toCsv(["卡密"], [["=cmd"]]).startsWith("\uFEFF")).toBe(true);
    expect(toCsv(["卡密"], [["=cmd"]])).toContain(`"'=cmd"`);
  });
});

describe("drawTodayUsedCount", () => {
  it("今日已出卡数加上在途单未出的张数", () => {
    expect(
      drawTodayUsedCount({
        todayItemCount: 3,
        inflight: [
          { quantity: 5, issuedCount: 2 },
          { quantity: 4, issuedCount: 0 },
        ],
      }),
    ).toBe(10);
  });

  it("已出满或超出的在途单不重复计数，负数今日数按 0", () => {
    expect(
      drawTodayUsedCount({
        todayItemCount: -1,
        inflight: [
          { quantity: 2, issuedCount: 2 },
          { quantity: 1, issuedCount: 3 },
        ],
      }),
    ).toBe(0);
  });
});
