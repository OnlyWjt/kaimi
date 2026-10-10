import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentEarningsQuery,
  paymentMethodLabel,
  beijingPeriodBounds,
  beijingRangeYmd,
  legacySettlementStatusLabel,
  moneyYuan,
  moneyYuanAbs,
  netDirectionLabel,
  netDirectionText,
  reconciliationStatusLabel,
  signedMoneyYuan,
} from "./agent-console-core";

describe("signedMoneyYuan", () => {
  it("正数、零不带符号", () => {
    expect(signedMoneyYuan(50000)).toBe("¥500.00");
    expect(signedMoneyYuan(0)).toBe("¥0.00");
    expect(signedMoneyYuan(-0)).toBe("¥0.00");
  });

  it("负数显示 −¥，不再压成 0", () => {
    expect(signedMoneyYuan(-4000)).toBe("−¥40.00");
    expect(signedMoneyYuan(-5)).toBe("−¥0.05");
    // 旧函数行为保持不变：负数仍是 0
    expect(moneyYuan(-4000)).toBe("¥0.00");
  });

  it("带千分位", () => {
    expect(signedMoneyYuan(123456789)).toBe("¥1,234,567.89");
    expect(signedMoneyYuan(-123456789)).toBe("−¥1,234,567.89");
    expect(signedMoneyYuan(100000)).toBe("¥1,000.00");
    expect(signedMoneyYuan(99999)).toBe("¥999.99");
  });

  it("非整数、非法输入", () => {
    expect(signedMoneyYuan(1234.9)).toBe("¥12.34");
    expect(signedMoneyYuan(-1234.9)).toBe("−¥12.34");
    expect(signedMoneyYuan(-0.4)).toBe("¥0.00");
    expect(signedMoneyYuan(Number.NaN)).toBe("¥0.00");
  });
});

describe("moneyYuanAbs", () => {
  it("取绝对值并带千分位", () => {
    expect(moneyYuanAbs(-30000)).toBe("¥300.00");
    expect(moneyYuanAbs(30000)).toBe("¥300.00");
    expect(moneyYuanAbs(0)).toBe("¥0.00");
    expect(moneyYuanAbs(-1234567)).toBe("¥12,345.67");
    expect(moneyYuanAbs(-99.7)).toBe("¥0.99");
  });
});

describe("净额方向", () => {
  it("正/负/零", () => {
    expect(netDirectionLabel(50000)).toBe("平台转给我");
    expect(netDirectionLabel(-30000)).toBe("我转给平台");
    expect(netDirectionLabel(0)).toBe("已抵平");
    expect(netDirectionText(-30000)).toBe("我转给平台 ¥300.00");
    expect(netDirectionText(123456)).toBe("平台转给我 ¥1,234.56");
    expect(netDirectionText(0)).toBe("已抵平 ¥0.00");
  });
});

describe("状态文案", () => {
  it("对账批次", () => {
    expect(reconciliationStatusLabel("draft")).toBe("平台核对中");
    expect(reconciliationStatusLabel("pending_payment")).toBe("待付款");
    expect(reconciliationStatusLabel("paid")).toBe("已付款");
    expect(reconciliationStatusLabel("cleared")).toBe("已抵平结清");
    expect(reconciliationStatusLabel("cancelled")).toBe("已取消");
    expect(reconciliationStatusLabel("correction_pending")).toBe("更正中");
    expect(reconciliationStatusLabel("corrected")).toBe("已更正");
  });

  it("旧周结", () => {
    expect(legacySettlementStatusLabel("paid")).toBe("已返佣");
    expect(legacySettlementStatusLabel("pending_payment")).toBe("待返佣（平台核验中）");
    expect(legacySettlementStatusLabel("cancelled")).toBe("已取消");
  });
});

describe("paymentMethodLabel", () => {
  it("已知值转中文，未知显示其他，空显示 —", () => {
    expect(paymentMethodLabel("alipay")).toBe("支付宝");
    expect(paymentMethodLabel("wechat")).toBe("微信");
    expect(paymentMethodLabel("bank")).toBe("银行卡");
    expect(paymentMethodLabel("other")).toBe("其他");
    expect(paymentMethodLabel("ALIPAY")).toBe("支付宝");
    expect(paymentMethodLabel("paypal")).toBe("其他");
    expect(paymentMethodLabel("")).toBe("—");
    expect(paymentMethodLabel(null)).toBe("—");
    expect(paymentMethodLabel(undefined)).toBe("—");
  });
});

describe("agentEarningsQuery 与账本页同一北京日期范围", () => {
  // 北京时间 2026-09-03 01:00，UTC 仍是 09-02；本地时区无论是什么，结果都必须按北京时间。
  const crossMidnight = new Date("2026-09-02T17:00:00.000Z");

  it("今天 / 近 7 天 / 本月和 beijingRangeYmd 一致", () => {
    for (const range of ["today", "7d", "month"] as const) {
      const { start, end } = beijingRangeYmd(range, crossMidnight);
      expect(agentEarningsQuery(range, crossMidnight)).toBe(`&start=${start}&end=${end}`);
    }
    expect(agentEarningsQuery("today", crossMidnight)).toBe("&start=2026-09-03&end=2026-09-03");
  });

  it("全部不传参数", () => {
    expect(agentEarningsQuery("all", crossMidnight)).toBe("");
  });

  it("东八区午夜前后一毫秒落在不同的一天，和进程时区无关", () => {
    expect(agentEarningsQuery("today", new Date("2026-09-02T15:59:59.999Z"))).toBe(
      "&start=2026-09-02&end=2026-09-02",
    );
    expect(agentEarningsQuery("today", new Date("2026-09-02T16:00:00.000Z"))).toBe(
      "&start=2026-09-03&end=2026-09-03",
    );
  });

  it("实现不读本地时间字段", () => {
    const source = readFileSync(new URL("./agent-console-core.ts", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("function beijingYmd"), source.indexOf("export function beijingPeriodBounds"));
    expect(block).not.toMatch(/getFullYear|getMonth\(|getDate\(|getHours|getTimezoneOffset/);
    const query = source.slice(source.indexOf("export function agentEarningsQuery"), source.indexOf("export function moneyYuan("));
    expect(query).toContain("beijingRangeYmd");
    expect(query).not.toContain("agentRangeYmd");
  });
});

describe("期间边界（北京时间、左闭右开）", () => {
  it("纯日期：end 取次日 0 点", () => {
    expect(beijingPeriodBounds("2026-09-02", "2026-09-02")).toEqual({
      start: "2026-09-01T16:00:00.000Z",
      end: "2026-09-02T16:00:00.000Z",
    });
  });

  it("恰在 end 的记录不计入，end 前 1ms 计入", () => {
    const { start, end } = beijingPeriodBounds("2026-09-02", "2026-09-02");
    const inRange = (at: string) => at >= start && at < end;
    expect(inRange("2026-09-01T16:00:00.000Z")).toBe(true);
    expect(inRange("2026-09-02T15:59:59.999Z")).toBe(true);
    expect(inRange("2026-09-02T16:00:00.000Z")).toBe(false);
    expect(inRange("2026-09-01T15:59:59.999Z")).toBe(false);
  });

  it("带时间的值原样作为边界", () => {
    expect(beijingPeriodBounds("2026-09-02T00:00:00.000Z", "2026-09-03T00:00:00.000Z")).toEqual({
      start: "2026-09-02T00:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
    });
  });

  it("非法或倒置范围报错", () => {
    expect(() => beijingPeriodBounds("", "2026-09-02")).toThrow();
    expect(() => beijingPeriodBounds("abc", "2026-09-02")).toThrow();
    expect(() => beijingPeriodBounds("2026-09-03", "2026-09-02")).toThrow();
  });

  it("前端区间按北京时间切日", () => {
    // 北京时间 2026-09-03 01:00 = UTC 09-02 17:00
    const now = new Date("2026-09-02T17:00:00.000Z");
    expect(beijingRangeYmd("today", now)).toEqual({ start: "2026-09-03", end: "2026-09-03" });
    expect(beijingRangeYmd("7d", now)).toEqual({ start: "2026-08-28", end: "2026-09-03" });
    expect(beijingRangeYmd("month", now)).toEqual({ start: "2026-09-01", end: "2026-09-03" });
    expect(beijingRangeYmd("all", now)).toEqual({ start: "2020-01-01", end: "2026-09-03" });
  });
});
