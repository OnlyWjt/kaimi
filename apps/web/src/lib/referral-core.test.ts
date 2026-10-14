import { describe, expect, it } from "vitest";
import {
  REFERRAL_CODE_ALPHABET,
  beijingMonthStartIso,
  judgeInvite,
  maxReferralDiscount,
  maxReferralDiscountForPlan,
  newReferralCode,
  normalizeReferralCode,
  normalizeReferralEmail,
  parseReferralRewards,
  referralCouponDiscount,
  referralCouponUseError,
  referralRewardsError,
  referralSettingsError,
} from "./referral-core";

const mail = (local: string, domain: string) => `${local}@${domain}`;
const fee = { ratePpm: 6000, fixedFeeCents: 0 };

describe("normalizeReferralEmail", () => {
  it("Gmail 去点、去 + 别名，googlemail 视同 gmail", () => {
    const base = normalizeReferralEmail(mail("johnsmith", "gmail.com"));
    expect(normalizeReferralEmail(mail("John.Smith", "Gmail.com"))).toBe(base);
    expect(normalizeReferralEmail(mail("john.smith+shop", "gmail.com"))).toBe(base);
    expect(normalizeReferralEmail(mail("johnsmith", "googlemail.com"))).toBe(base);
  });

  it("其他邮箱只转小写，不动点号和 +", () => {
    expect(normalizeReferralEmail(` ${mail("A.B+c", "QQ.com")} `)).toBe(mail("a.b+c", "qq.com"));
  });
});

describe("码", () => {
  it("只用去掉易混字符的字母表", () => {
    const code = newReferralCode(200);
    expect(code).toHaveLength(200);
    expect([...code].every((ch) => REFERRAL_CODE_ALPHABET.includes(ch))).toBe(true);
    expect(code).not.toMatch(/[01OIL]/);
  });

  it("手填的码转大写，非法的当没填", () => {
    expect(normalizeReferralCode(" k7m2qx ")).toBe("K7M2QX");
    expect(normalizeReferralCode("ab-12")).toBe("");
    expect(normalizeReferralCode(null)).toBe("");
  });
});

describe("最多能减", () => {
  it("减完代理收益刚好不为负", () => {
    // 售价 150、成本 118，通道费 0.6%
    const max = maxReferralDiscount({ listGoodsCents: 15000, costTotalCents: 11800, feeRule: fee });
    const after = (discount: number) => 15000 - discount - 11800 - Math.round((15000 - discount) * 0.006);
    expect(after(max)).toBeGreaterThanOrEqual(0);
    expect(after(max + 1)).toBeLessThan(0);
  });

  it("本来就亏本时为 0", () => {
    expect(maxReferralDiscount({ listGoodsCents: 10000, costTotalCents: 10000, feeRule: fee })).toBe(0);
  });

  it("多个通道取最紧的", () => {
    const loose = maxReferralDiscountForPlan({ retailPriceCents: 15000, costCents: 11800, feeRules: [fee] });
    const both = maxReferralDiscountForPlan({
      retailPriceCents: 15000,
      costCents: 11800,
      feeRules: [fee, { ratePpm: 30000, fixedFeeCents: 0 }],
    });
    expect(both).toBeLessThan(loose);
  });
});

describe("referralCouponDiscount", () => {
  const rewards = { plus: 1000, pro: 5000 };

  it("按快照金额立减，一单只减一次", () => {
    const result = referralCouponDiscount({
      rewards,
      planKey: "pro",
      listGoodsCents: 115500 * 3,
      costTotalCents: 98000 * 3,
      feeRule: fee,
    });
    expect(result).toEqual({ ok: true, discountCents: 5000, goodsCents: 115500 * 3 - 5000, cappedByCost: false });
  });

  it("商品不在券上就拒绝", () => {
    const result = referralCouponDiscount({ rewards, planKey: "team", listGoodsCents: 9000, costTotalCents: 1, feeRule: fee });
    expect(result.ok).toBe(false);
  });

  it("降价后会亏本时自动封底", () => {
    // 售价降到 125，成本 118：最多只能减几块钱
    const result = referralCouponDiscount({ rewards, planKey: "plus", listGoodsCents: 12500, costTotalCents: 11800, feeRule: fee });
    expect(result.ok && result.cappedByCost).toBe(true);
    expect(result.ok && result.discountCents).toBeLessThan(1000);
  });

  it("封底后为 0 就拒绝", () => {
    const result = referralCouponDiscount({ rewards, planKey: "plus", listGoodsCents: 11800, costTotalCents: 11800, feeRule: fee });
    expect(result.ok).toBe(false);
  });
});

describe("referralCouponUseError", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const ok = { status: "unused", expiresAt: "2026-11-01T00:00:00Z", ownerEmailHash: "h1" };

  it("本人、未用、未过期才行", () => {
    expect(referralCouponUseError(ok, { emailHash: "h1", now })).toBeNull();
    expect(referralCouponUseError(ok, { emailHash: "h2", now })).toContain("发券的邮箱");
    expect(referralCouponUseError({ ...ok, status: "used" }, { emailHash: "h1", now })).toContain("用过");
    expect(referralCouponUseError({ ...ok, status: "revoked" }, { emailHash: "h1", now })).toContain("停用");
    expect(referralCouponUseError({ ...ok, expiresAt: "2026-10-12T00:00:00Z" }, { emailHash: "h1", now })).toContain("过期");
    expect(referralCouponUseError({ ...ok, status: "reserved" }, { emailHash: "h1", now })).toContain("未付款订单");
  });
});

describe("judgeInvite", () => {
  const base = {
    enabled: true,
    codeBelongsToAgent: true,
    inviterEmail: mail("wang", "qq.com"),
    inviteeEmail: mail("li", "qq.com"),
    inviteePaidBefore: false,
    inviteeAlreadyInvited: false,
    orderAmountCents: 15000,
    minOrderCents: 5000,
    inviterRewardsThisMonth: 0,
    monthlyCap: 10,
  };

  it("正常首单进冷静期", () => {
    expect(judgeInvite(base)).toEqual({ record: true, status: "cooling" });
  });

  it("各种不算的情况", () => {
    expect(judgeInvite({ ...base, enabled: false })).toMatchObject({ record: false, reason: "disabled" });
    expect(judgeInvite({ ...base, codeBelongsToAgent: false })).toMatchObject({ reason: "foreign_code" });
    expect(
      judgeInvite({ ...base, inviterEmail: mail("wang.x", "gmail.com"), inviteeEmail: mail("wangx+1", "gmail.com") }),
    ).toMatchObject({ reason: "self" });
    expect(judgeInvite({ ...base, inviteePaidBefore: true })).toMatchObject({ reason: "not_first_order" });
    expect(judgeInvite({ ...base, inviteeAlreadyInvited: true })).toMatchObject({ reason: "already_invited" });
    expect(judgeInvite({ ...base, orderAmountCents: 4999 })).toMatchObject({ reason: "below_min" });
  });

  it("到上限照样记，但不发券", () => {
    expect(judgeInvite({ ...base, inviterRewardsThisMonth: 10 })).toEqual({ record: true, status: "capped" });
  });
});

describe("其他", () => {
  it("北京时间月初", () => {
    expect(beijingMonthStartIso(new Date("2026-10-31T17:00:00Z"))).toBe("2026-10-31T16:00:00.000Z");
    expect(beijingMonthStartIso(new Date("2026-10-31T15:59:00Z"))).toBe("2026-09-30T16:00:00.000Z");
  });

  it("快照解析丢掉非法值", () => {
    expect(parseReferralRewards('{"plus":1000,"bad":-1,"x":"abc"}')).toEqual({ plus: 1000 });
    expect(parseReferralRewards("not json")).toEqual({});
  });

  it("设置和立减额校验", () => {
    expect(referralSettingsError({ couponValidDays: 30, coolingDays: 7, minOrderCents: 0, monthlyCap: 10 })).toBeNull();
    expect(referralSettingsError({ couponValidDays: 0, coolingDays: 7, minOrderCents: 0, monthlyCap: 10 })).toContain("有效期");
    expect(referralRewardsError([{ planKey: "plus", planName: "Plus", amountCents: 4000, maxCents: 3110 }])).toContain(
      "最多只能减 ¥31.10",
    );
    expect(referralRewardsError([{ planKey: "plus", planName: "Plus", amountCents: 1000, maxCents: 3110 }])).toBeNull();
  });
});
