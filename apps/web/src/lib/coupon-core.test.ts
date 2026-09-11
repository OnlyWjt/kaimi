import { describe, expect, it } from "vitest";
import {
  applyCoupon,
  couponBelowCost,
  describeCoupon,
  normalizeCouponCode,
  parseCouponDraft,
  previewCouponWarnings,
  quoteCouponTicket,
} from "./coupon-core";

const feeRule = { ratePpm: 60_000, fixedFeeCents: 0 };

describe("normalizeCouponCode", () => {
  it("转大写并校验长度", () => {
    expect(normalizeCouponCode(" plus10 ")).toBe("PLUS10");
    expect(() => normalizeCouponCode("ab")).toThrow(/4–20/);
    expect(() => normalizeCouponCode("坏券码")).toThrow(/字母或数字/);
  });
});

describe("applyCoupon", () => {
  it("折扣按几折四舍五入", () => {
    expect(applyCoupon(15000, { kind: "percent", percentZhe: 8, thresholdCents: 0, amountCents: 0 })).toEqual({
      ok: true,
      goodsCents: 12000,
      discountCents: 3000,
    });
  });

  it("满减未达标时报错，达标后减免且不超过原价", () => {
    const spec = { kind: "threshold" as const, percentZhe: 0, thresholdCents: 10000, amountCents: 2000 };
    expect(applyCoupon(9999, spec).ok).toBe(false);
    expect(applyCoupon(15000, spec)).toEqual({
      ok: true,
      goodsCents: 13000,
      discountCents: 2000,
    });
    expect(applyCoupon(1500, { ...spec, thresholdCents: 1000, amountCents: 2000 })).toEqual({
      ok: true,
      goodsCents: 0,
      discountCents: 1500,
    });
  });
});

describe("quoteCouponTicket", () => {
  it("折扣券按买 1 张算出券后价、开票价和收益", () => {
    const ticket = quoteCouponTicket({
      spec: { kind: "percent", percentZhe: 8, thresholdCents: 0, amountCents: 0 },
      listCents: 15000,
      costCents: 3000,
      feeRule,
    });
    expect(ticket).toMatchObject({
      applied: true,
      listCents: 15000,
      discountCents: 3000,
      goodsCents: 12000,
      invoicePayCents: 13200,
    });
    expect(ticket.earningCents).toBe(12000 - 3000 - ticket.feeOnGoodsCents);
  });

  it("未满门槛时优惠不生效，票面仍按原价开票", () => {
    const ticket = quoteCouponTicket({
      spec: { kind: "threshold", percentZhe: 0, thresholdCents: 20000, amountCents: 2000 },
      listCents: 15000,
      costCents: 3000,
      feeRule,
    });
    expect(ticket.applied).toBe(false);
    expect(ticket.discountCents).toBe(0);
    expect(ticket.goodsCents).toBe(15000);
    expect(ticket.invoicePayCents).toBe(16500);
  });
});

describe("couponBelowCost", () => {
  it("券后价扣完通道费不能低于成本", () => {
    expect(
      couponBelowCost({
        goodsCents: 14000,
        costTotalCents: 3000,
        feeRule,
      }),
    ).toBe(false);
    expect(
      couponBelowCost({
        goodsCents: 3000,
        costTotalCents: 3000,
        feeRule,
      }),
    ).toBe(true);
  });
});

describe("parseCouponDraft", () => {
  it("折扣和满减都要指定套餐", () => {
    const percent = parseCouponDraft({
      name: "新客 8 折",
      code: "new8",
      kind: "percent",
      percentZhe: 8,
      maxUses: 20,
      planKeys: ["plus", "plus"],
    });
    expect(percent).toMatchObject({
      code: "NEW8",
      kind: "percent",
      percentZhe: 8,
      planKeys: ["plus"],
      maxUses: 20,
    });
    const threshold = parseCouponDraft({
      name: "满 100 减 10",
      code: "M100",
      kind: "threshold",
      thresholdCents: 10000,
      amountCents: 1000,
      unlimited: true,
      planKeys: ["pro"],
    });
    expect(threshold.maxUses).toBe(0);
    expect(describeCoupon(threshold)).toBe("满 ¥100.00 减 ¥10.00");
    expect(() =>
      parseCouponDraft({
        name: "空套餐",
        code: "NONE1",
        kind: "percent",
        percentZhe: 9,
        maxUses: 1,
        planKeys: [],
      }),
    ).toThrow(/至少一个套餐/);
  });
});

describe("previewCouponWarnings", () => {
  it("利润不够的套餐会提醒，达不到满减也会提醒", () => {
    const below = previewCouponWarnings({
      spec: { kind: "percent", percentZhe: 1, thresholdCents: 0, amountCents: 0 },
      planKeys: ["plus"],
      maxQuantity: 5,
      channels: [{ channel: "alipay", feeRule }],
      plans: [
        {
          planKey: "plus",
          planName: "Plus",
          retailPriceCents: 15000,
          costPriceCents: 3000,
          enabled: true,
        },
      ],
    });
    expect(below.some((item) => item.reason === "below_cost")).toBe(true);

    const unmet = previewCouponWarnings({
      spec: { kind: "threshold", percentZhe: 0, thresholdCents: 1_000_00, amountCents: 1000 },
      planKeys: ["plus"],
      maxQuantity: 5,
      channels: [{ channel: "alipay", feeRule }],
      plans: [
        {
          planKey: "plus",
          planName: "Plus",
          retailPriceCents: 15000,
          costPriceCents: 3000,
          enabled: true,
        },
      ],
    });
    expect(unmet.some((item) => item.reason === "threshold_unmet")).toBe(true);
  });
});
