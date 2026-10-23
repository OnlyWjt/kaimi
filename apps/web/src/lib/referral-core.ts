/**
 * 店铺邀请返券的纯函数：邮箱归一化、码生成、立减封底、有效邀请判断。
 * 设计见 docs/agent-store-referral-coupon-design.md。
 */
import { quoteStorePayment, type InvoicePolicy } from "./invoice-core";
import type { FeeRule } from "./payments/fees";

/** 去掉 0 O 1 I L，买家口头念、手抄都不容易错。 */
export const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REFERRAL_INVITE_CODE_LENGTH = 6;
/** 券码要猜不出来：31^10 ≈ 8×10^14。 */
export const REFERRAL_COUPON_CODE_LENGTH = 10;

export const REFERRAL_DEFAULTS = {
  couponValidDays: 30,
  coolingDays: 7,
  minOrderCents: 0,
  monthlyCap: 10,
} as const;

export const REFERRAL_LIMITS = {
  couponValidDays: [1, 365],
  coolingDays: [0, 60],
  minOrderCents: [0, 10_000_000],
  monthlyCap: [1, 1000],
} as const;

export type ReferralSettingsInput = {
  couponValidDays: number;
  coolingDays: number;
  minOrderCents: number;
  monthlyCap: number;
};

export type ReferralRewards = Record<string, number>;

/**
 * 判断「是不是同一个人」用的邮箱：小写、去空格；Gmail 去掉 @ 前的点和 + 之后的部分。
 * 只用于比较和 hash，发邮件仍用原文。
 */
export function normalizeReferralEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

export function newReferralCode(length: number, random: (n: number) => Uint8Array = randomBytes) {
  const bytes = random(length);
  let code = "";
  for (const byte of bytes) code += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
  return code;
}

function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function normalizeReferralCode(raw: string | null | undefined) {
  const code = String(raw || "").trim().toUpperCase();
  if (!code) return "";
  if (code.length > 16 || !/^[A-Z0-9]+$/.test(code)) return "";
  return code;
}

/**
 * 这一单最多能减多少，减完代理收益刚好不为负（售价 − 成本 − 通道费）。
 * 通道费跟着实付变，用二分找边界。
 */
export function maxReferralDiscount(input: {
  listGoodsCents: number;
  costTotalCents: number;
  feeRule: FeeRule;
  /**
   * 结账时传这单开不开票、代理的开票规则。开票单取「不开票上限」和「开票上限」里小的那个：
   * 自定义税点 6% 时代理出整单手续费又没有分成，能减的少几分；税点高时也不让开票分成去补更大的券，
   * 同一张券开不开票减的一样多。不传按不开票算（设置页估上限用）。
   */
  invoiceRequested?: boolean;
  invoicePolicy?: InvoicePolicy;
}): number {
  const plain = discountCap(input, false);
  if (!input.invoiceRequested) return plain;
  return Math.min(plain, discountCap(input, true));
}

function discountCap(
  input: { listGoodsCents: number; costTotalCents: number; feeRule: FeeRule; invoicePolicy?: InvoicePolicy },
  invoiceRequested: boolean,
) {
  const earning = (discount: number) =>
    quoteStorePayment({
      goodsCents: input.listGoodsCents - discount,
      costTotalCents: input.costTotalCents,
      invoiceRequested,
      feeRule: input.feeRule,
      invoicePolicy: input.invoicePolicy,
    }).earningCents;
  if (input.listGoodsCents <= 0 || earning(0) < 0) return 0;
  let lo = 0;
  let hi = input.listGoodsCents;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (earning(mid) >= 0) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 设置页用：多个支付通道时取最紧的那个（能减的最少的）。 */
export function maxReferralDiscountForPlan(input: {
  retailPriceCents: number;
  costCents: number;
  feeRules: FeeRule[];
}) {
  const rules = input.feeRules.length ? input.feeRules : [{ ratePpm: 0, fixedFeeCents: 0 }];
  return Math.min(
    ...rules.map((feeRule) =>
      maxReferralDiscount({
        listGoodsCents: input.retailPriceCents,
        costTotalCents: input.costCents,
        feeRule,
      }),
    ),
  );
}

export function parseReferralRewards(raw: string | null | undefined): ReferralRewards {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ReferralRewards = {};
    for (const [key, value] of Object.entries(parsed)) {
      const cents = Math.trunc(Number(value));
      if (key && Number.isSafeInteger(cents) && cents > 0) out[key] = cents;
    }
    return out;
  } catch {
    return {};
  }
}

export type ReferralDiscountResult =
  | { ok: true; discountCents: number; goodsCents: number; cappedByCost: boolean }
  | { ok: false; error: string };

/**
 * 结账时一张邀请券在这一单能减多少：按快照金额，一单只减一次，不能让代理亏本。
 */
export function referralCouponDiscount(input: {
  rewards: ReferralRewards;
  planKey: string;
  listGoodsCents: number;
  costTotalCents: number;
  feeRule: FeeRule;
  invoiceRequested?: boolean;
  invoicePolicy?: InvoicePolicy;
}): ReferralDiscountResult {
  const amount = input.rewards[input.planKey];
  if (!amount) return { ok: false, error: "这张邀请券不能用在这个商品上" };
  const cap = maxReferralDiscount(input);
  const discountCents = Math.min(amount, cap, input.listGoodsCents);
  if (discountCents <= 0) return { ok: false, error: "这张券暂时不能用在这个商品上" };
  return {
    ok: true,
    discountCents,
    goodsCents: input.listGoodsCents - discountCents,
    cappedByCost: discountCents < amount,
  };
}

export type CouponState = {
  status: string;
  expiresAt: string;
  ownerEmailHash: string;
};

/** 结账前对券本身的检查，返回给买家看的原因；能用返回 null。 */
export function referralCouponUseError(
  coupon: CouponState,
  input: { emailHash: string; now: Date },
): string | null {
  if (coupon.status === "used") return "这张券已经用过了";
  if (coupon.status === "revoked") return "这张券已停用";
  if (coupon.status === "reserved") return "这张券正在另一笔未付款订单里使用，关掉那单后再试";
  if (coupon.status === "expired" || Date.parse(coupon.expiresAt) <= input.now.getTime()) {
    return "这张券已过期";
  }
  if (coupon.status !== "unused") return "这张券不能使用";
  if (coupon.ownerEmailHash !== input.emailHash) return "这张券只能用发券的邮箱下单";
  return null;
}

export type InviteJudgement =
  | { record: false; reason: string }
  | { record: true; status: "cooling" | "capped" };

/** §4：被邀请人的订单发货后，要不要记一条邀请、记成什么状态。 */
export function judgeInvite(input: {
  enabled: boolean;
  codeBelongsToAgent: boolean;
  inviterEmail: string;
  inviteeEmail: string;
  inviteePaidBefore: boolean;
  inviteeAlreadyInvited: boolean;
  orderAmountCents: number;
  minOrderCents: number;
  inviterRewardsThisMonth: number;
  monthlyCap: number;
}): InviteJudgement {
  if (!input.enabled) return { record: false, reason: "disabled" };
  if (!input.codeBelongsToAgent) return { record: false, reason: "foreign_code" };
  if (normalizeReferralEmail(input.inviterEmail) === normalizeReferralEmail(input.inviteeEmail)) {
    return { record: false, reason: "self" };
  }
  if (input.inviteePaidBefore) return { record: false, reason: "not_first_order" };
  if (input.inviteeAlreadyInvited) return { record: false, reason: "already_invited" };
  if (input.orderAmountCents < input.minOrderCents) return { record: false, reason: "below_min" };
  if (input.inviterRewardsThisMonth >= input.monthlyCap) return { record: true, status: "capped" };
  return { record: true, status: "cooling" };
}

export function addDaysIso(iso: string, days: number) {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** 北京时间当月 1 号 0 点（UTC ISO），每月上限按这个切。 */
export function beijingMonthStartIso(now: Date) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - BEIJING_OFFSET_MS,
  ).toISOString();
}

export function referralSettingsError(input: ReferralSettingsInput): string | null {
  const labels: Record<keyof ReferralSettingsInput, string> = {
    couponValidDays: "邀请券有效期",
    coolingDays: "冷静期",
    minOrderCents: "好友订单最低实付",
    monthlyCap: "每人每月最多得券",
  };
  for (const key of Object.keys(REFERRAL_LIMITS) as Array<keyof ReferralSettingsInput>) {
    const [min, max] = REFERRAL_LIMITS[key];
    const value = input[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      return key === "minOrderCents"
        ? `${labels[key]}填 0 到 ${max / 100} 元`
        : `${labels[key]}填 ${min} 到 ${max}`;
    }
  }
  return null;
}

/** 逐商品立减额的校验：每个都要 > 0 且不超过「最多能减」。返回第一个有问题的。 */
export function referralRewardsError(
  rewards: Array<{ planKey: string; planName: string; amountCents: number; maxCents: number }>,
): string | null {
  for (const row of rewards) {
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) {
      return `${row.planName}：立减金额要大于 0`;
    }
    if (row.amountCents > row.maxCents) {
      return `${row.planName}：最多只能减 ¥${(row.maxCents / 100).toFixed(2)}，再多这一单就亏本了`;
    }
  }
  return null;
}

/** 买家看到的一句规则，例如「Plus 立减 ¥10.00、Pro 立减 ¥50.00」。 */
export function describeReferralRewards(
  rewards: Array<{ planName: string; amountCents: number }>,
) {
  return rewards.map((row) => `${row.planName} 立减 ¥${(row.amountCents / 100).toFixed(2)}`).join("、");
}

/** 给代理/买家看的邮箱打码：j***@qq.com */
export function maskReferralEmail(email: string) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
