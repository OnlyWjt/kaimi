import { describe, expect, it } from "vitest";
import {
  buildEarningsTotals,
  issuedCdkSummaryLabel,
  type EarningDetailRow,
} from "./earnings-rows";

const order = (over: Partial<EarningDetailRow> = {}): EarningDetailRow => ({
  grossCents: 9900,
  costCents: 5600,
  estimatedFeeCents: 60,
  actualFeeCents: 64,
  earningCents: 4236,
  earningStatus: "pending",
  ...over,
});

describe("issuedCdkSummaryLabel", () => {
  it("一单多张时给整单进度，不再挑某一张卡的状态", () => {
    expect(issuedCdkSummaryLabel(5, 2)).toBe("已使用 2/5");
    expect(issuedCdkSummaryLabel(5, 0)).toBe("已使用 0/5");
  });

  it("一单一张读起来和以前一个意思", () => {
    expect(issuedCdkSummaryLabel(1, 1)).toBe("已使用 1/1");
    expect(issuedCdkSummaryLabel(1, 0)).toBe("已使用 0/1");
  });

  it("没有卡就留空，脏数字不会溢出", () => {
    expect(issuedCdkSummaryLabel(0, 0)).toBe("");
    expect(issuedCdkSummaryLabel(null, undefined)).toBe("");
    expect(issuedCdkSummaryLabel(3, 9)).toBe("已使用 3/3");
    expect(issuedCdkSummaryLabel(3, -2)).toBe("已使用 0/3");
  });
});

describe("buildEarningsTotals", () => {
  it("一单一行：汇总就是这一单本身", () => {
    const totals = buildEarningsTotals([order()], []);
    expect(totals.orderCount).toBe(1);
    expect(totals.grossCents).toBe(9900);
    expect(totals.costCents).toBe(5600);
    expect(totals.earningCents).toBe(4236);
    expect(totals.pendingCents).toBe(4236);
  });

  // 这就是导出把 ¥39.40 打成 ¥197.00 的那个 bug：5 张卡的订单被连接摊成 5 行。
  it("五张卡的订单摊成五行时，汇总会被乘上张数", () => {
    const inflated = buildEarningsTotals(Array.from({ length: 5 }, () => order()), []);
    expect(inflated.orderCount).toBe(5);
    expect(inflated.earningCents).toBe(4236 * 5);
    // 修好之后行数据来自标量子查询，五张卡也只有一行。
    const correct = buildEarningsTotals([order()], []);
    expect(correct.orderCount).toBe(1);
    expect(correct.earningCents).toBe(4236);
  });

  it("撤销的收益不计入总收益，但单独统计", () => {
    const totals = buildEarningsTotals(
      [order(), order({ earningStatus: "reversed" })],
      [],
    );
    expect(totals.earningCents).toBe(4236);
    expect(totals.reversedCents).toBe(4236);
    expect(totals.pendingCents).toBe(4236);
  });

  it("手续费差额只算网关回过真实金额的那些", () => {
    const totals = buildEarningsTotals(
      [order(), order({ actualFeeCents: null })],
      [],
    );
    expect(totals.estimatedFeeCents).toBe(120);
    expect(totals.actualFeeCents).toBe(64);
    expect(totals.feeDifferenceCents).toBe(4);
  });

  it("调整项按状态并进对应的桶", () => {
    const totals = buildEarningsTotals(
      [order({ earningStatus: "settled" })],
      [
        { amountCents: -500, status: "pending" },
        { amountCents: 200, status: "settled" },
      ],
    );
    expect(totals.adjustmentCents).toBe(-300);
    expect(totals.earningCents).toBe(4236 - 300);
    expect(totals.pendingCents).toBe(-500);
    expect(totals.settledCents).toBe(4236 + 200);
  });
});
