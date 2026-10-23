import { describe, expect, it } from "vitest";
import { couponBelowCost, previewCouponWarnings } from "./coupon-core";
import { buildEarningsTotals } from "./earnings-rows";
import { assertInvoiceRateUnchanged, quoteStorePayment, type InvoicePolicy } from "./invoice-core";
import { maxReferralDiscount, referralCouponDiscount } from "./referral-core";

const feeRule = { ratePpm: 6000, fixedFeeCents: 0 };
const six: InvoicePolicy = { split: true, ratePct: 6, agentTaxBp: 100 };

describe("邀请券封顶按这单的开票规则算", () => {
  // ¥60 / 成本 ¥50：不开票最多减 ¥9.70；自定义 6% 开票时代理多出 6% 上的手续费，要少减几分
  const base = { listGoodsCents: 6000, costTotalCents: 5000, feeRule };

  it("不开票、老规则开票：封顶不变", () => {
    const plain = maxReferralDiscount(base);
    expect(plain).toBe(970);
    expect(maxReferralDiscount({ ...base, invoiceRequested: false, invoicePolicy: six })).toBe(plain);
    expect(maxReferralDiscount({ ...base, invoiceRequested: true })).toBe(plain);
  });

  it("自定义 6% 开票：封顶变小，减到底代理收益仍不为负", () => {
    const plain = maxReferralDiscount(base);
    const cap = maxReferralDiscount({ ...base, invoiceRequested: true, invoicePolicy: six });
    expect(cap).toBeLessThan(plain);
    const earning = (discount: number) =>
      quoteStorePayment({
        goodsCents: 6000 - discount,
        costTotalCents: 5000,
        invoiceRequested: true,
        feeRule,
        invoicePolicy: six,
      }).earningCents;
    expect(earning(cap)).toBeGreaterThanOrEqual(0);
    expect(earning(cap + 1)).toBeLessThan(0);
  });

  it("税点高时开票也不让分成去补更大的券：开不开票减的一样多", () => {
    const plain = maxReferralDiscount(base);
    for (const ratePct of [7, 10, 13, 17]) {
      const policy: InvoicePolicy = { split: true, ratePct, agentTaxBp: 100 };
      expect(maxReferralDiscount({ ...base, invoiceRequested: true, invoicePolicy: policy })).toBe(plain);
    }
  });

  it("结账：券面额超过封顶时按开票规则封底，单子能下", () => {
    const result = referralCouponDiscount({
      rewards: { plus: 5000 },
      planKey: "plus",
      ...base,
      invoiceRequested: true,
      invoicePolicy: six,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cappedByCost).toBe(true);
    const quote = quoteStorePayment({
      goodsCents: result.goodsCents,
      costTotalCents: 5000,
      invoiceRequested: true,
      feeRule,
      invoicePolicy: six,
    });
    expect(quote.earningCents).toBeGreaterThanOrEqual(0);
  });

  it("各种价位、税点随机核对：封底后开票单收益都不为负", () => {
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let i = 0; i < 2000; i += 1) {
      const list = 100 + next(500_000);
      const cost = next(list);
      const rule = { ratePpm: next(40000), fixedFeeCents: next(50) };
      const policy: InvoicePolicy = { split: true, ratePct: 6 + next(12), agentTaxBp: next(2001) };
      const cap = maxReferralDiscount({
        listGoodsCents: list,
        costTotalCents: cost,
        feeRule: rule,
        invoiceRequested: true,
        invoicePolicy: policy,
      });
      const earning = quoteStorePayment({
        goodsCents: list - cap,
        costTotalCents: cost,
        invoiceRequested: true,
        feeRule: rule,
        invoicePolicy: policy,
      }).earningCents;
      if (cap > 0) expect(earning).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("买家页面税点过期", () => {
  it("页面显示 10%、店铺已改成 17%：开票单拒绝，提示新税点", () => {
    expect(() =>
      assertInvoiceRateUnchanged({ invoiceRequested: true, expectedRatePct: 10, currentRatePct: 17 }),
    ).toThrow("17%");
  });

  it("税点一致、不开票、没传期望税点（老客户端）：都放行", () => {
    expect(() =>
      assertInvoiceRateUnchanged({ invoiceRequested: true, expectedRatePct: 17, currentRatePct: 17 }),
    ).not.toThrow();
    expect(() =>
      assertInvoiceRateUnchanged({ invoiceRequested: false, expectedRatePct: 10, currentRatePct: 17 }),
    ).not.toThrow();
    expect(() => assertInvoiceRateUnchanged({ invoiceRequested: true, currentRatePct: 17 })).not.toThrow();
  });
});

describe("店铺优惠券和开票", () => {
  it("券把不开票收益压到 0：自定义 6% 开票会低于成本，老规则开票不会", () => {
    const input = { goodsCents: 5030, costTotalCents: 5000, feeRule };
    expect(couponBelowCost(input)).toBe(false);
    expect(couponBelowCost({ ...input, invoiceRequested: true })).toBe(false);
    expect(couponBelowCost({ ...input, invoiceRequested: true, invoicePolicy: six })).toBe(true);
  });

  it("做券页提前提示：开通了自定义税点时，开票用不了的券会被标出来", () => {
    const common = {
      spec: { kind: "threshold" as const, percentZhe: 0, thresholdCents: 6000, amountCents: 970 },
      plans: [{ planKey: "plus", planName: "Plus", retailPriceCents: 6000, costPriceCents: 5000, enabled: true }],
      channels: [{ channel: "alipay" as const, feeRule }],
      planKeys: ["plus"],
      maxQuantity: 1,
    };
    expect(previewCouponWarnings(common)).toEqual([]);
    const warnings = previewCouponWarnings({ ...common, invoicePolicy: six });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toBe("below_cost");
    expect(warnings[0]?.message).toContain("开票");
    // 17% 的分成足够抵掉多出的手续费，不提示
    expect(previewCouponWarnings({ ...common, invoicePolicy: { ...six, ratePct: 17 } })).toEqual([]);
  });
});

describe("收益导出汇总", () => {
  it("开票分成合计和「客户实付」同口径，冲回行也算", () => {
    const row = (overrides: Partial<Parameters<typeof buildEarningsTotals>[0][number]>) => ({
      grossCents: 10000,
      costCents: 5000,
      estimatedFeeCents: 60,
      actualFeeCents: null,
      earningCents: 5000,
      earningStatus: "pending",
      invoiceShareCents: 1089,
      ...overrides,
    });
    const totals = buildEarningsTotals(
      [row({}), row({ earningStatus: "reversed" }), row({ invoiceShareCents: 0 })],
      [],
    );
    expect(totals.invoiceShareCents).toBe(1089 * 2);
  });
});
