import { quoteStorePayment } from "./invoice-core";
import { yuanTextFromCents } from "./money";
import type { FeeRule, PaymentChannel } from "./payments/fees";

export const COUPON_KINDS = ["percent", "threshold"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export const COUPON_NAME_MAX = 40;
export const COUPON_CODE_MIN = 4;
export const COUPON_CODE_MAX = 20;
export const COUPON_MAX_USES_CAP = 1_000_000;

export type CouponSpec = {
  kind: CouponKind;
  percentZhe: number;
  thresholdCents: number;
  amountCents: number;
};

export type CouponDraft = CouponSpec & {
  name: string;
  code: string;
  maxUses: number;
  planKeys: string[];
  enabled: boolean;
};

export type ApplyCouponResult =
  | { ok: true; discountCents: number; goodsCents: number }
  | { ok: false; error: string };

export type CouponWarning = {
  planKey: string;
  planName: string;
  channel: PaymentChannel;
  quantity: number;
  reason: "below_cost" | "threshold_unmet";
  message: string;
};

const CHANNEL_LABEL: Record<PaymentChannel, string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
};

export function isCouponKind(value: string): value is CouponKind {
  return value === "percent" || value === "threshold";
}

export function normalizeCouponCode(raw: string) {
  const code = raw.trim().toUpperCase();
  if (
    code.length < COUPON_CODE_MIN ||
    code.length > COUPON_CODE_MAX ||
    !/^[A-Z0-9]+$/.test(code)
  ) {
    throw new Error("券码需为 4–20 位字母或数字");
  }
  return code;
}

export function applyCoupon(
  listGoodsCents: number,
  spec: CouponSpec,
): ApplyCouponResult {
  if (!Number.isSafeInteger(listGoodsCents) || listGoodsCents < 0) {
    return { ok: false, error: "商品金额无效" };
  }
  if (spec.kind === "percent") {
    if (
      !Number.isSafeInteger(spec.percentZhe) ||
      spec.percentZhe < 1 ||
      spec.percentZhe > 99
    ) {
      return { ok: false, error: "折扣须为 1–99 折" };
    }
    const goodsCents = Math.round((listGoodsCents * spec.percentZhe) / 10);
    return {
      ok: true,
      goodsCents,
      discountCents: listGoodsCents - goodsCents,
    };
  }
  if (
    !Number.isSafeInteger(spec.thresholdCents) ||
    spec.thresholdCents < 1 ||
    !Number.isSafeInteger(spec.amountCents) ||
    spec.amountCents < 1
  ) {
    return { ok: false, error: "请填写满减门槛和减免金额" };
  }
  if (listGoodsCents < spec.thresholdCents) {
    return {
      ok: false,
      error: `未满 ¥${yuanTextFromCents(spec.thresholdCents)}，不能使用这张券`,
    };
  }
  const discountCents = Math.min(spec.amountCents, listGoodsCents);
  return {
    ok: true,
    discountCents,
    goodsCents: listGoodsCents - discountCents,
  };
}

export function couponBelowCost(input: {
  goodsCents: number;
  costTotalCents: number;
  feeRule: FeeRule;
}) {
  const quote = quoteStorePayment({
    goodsCents: input.goodsCents,
    costTotalCents: input.costTotalCents,
    invoiceRequested: false,
    feeRule: input.feeRule,
  });
  return quote.earningCents < 0;
}

export function couponEarningQuote(input: {
  goodsCents: number;
  costTotalCents: number;
  feeRule: FeeRule;
}) {
  return quoteStorePayment({
    goodsCents: input.goodsCents,
    costTotalCents: input.costTotalCents,
    invoiceRequested: false,
    feeRule: input.feeRule,
  });
}

export type CouponTicketQuote = {
  applied: boolean;
  missReason?: string;
  listCents: number;
  discountCents: number;
  goodsCents: number;
  invoicePayCents: number;
  feeOnGoodsCents: number;
  earningCents: number;
};

export type CouponPreviewTicket = CouponTicketQuote & {
  planKey: string;
  planName: string;
};

/** 做券页右侧票面：按买 1 张、开票加价、通道费估算。 */
export function quoteCouponTicket(input: {
  spec: CouponSpec;
  listCents: number;
  costCents: number;
  feeRule: FeeRule;
}): CouponTicketQuote {
  const applied = applyCoupon(input.listCents, input.spec);
  const goodsCents = applied.ok ? applied.goodsCents : input.listCents;
  const quote = quoteStorePayment({
    goodsCents,
    costTotalCents: input.costCents,
    invoiceRequested: true,
    feeRule: input.feeRule,
  });
  return {
    applied: applied.ok,
    missReason: applied.ok ? undefined : applied.error,
    listCents: input.listCents,
    discountCents: applied.ok ? applied.discountCents : 0,
    goodsCents,
    invoicePayCents: quote.payCents,
    feeOnGoodsCents: quote.feeOnGoodsCents,
    earningCents: quote.earningCents,
  };
}

function asTrimmedString(value: unknown, field: string, max: number) {
  if (typeof value !== "string") throw new Error(`请填写${field}`);
  const text = value.trim();
  if (!text) throw new Error(`请填写${field}`);
  if (text.length > max) throw new Error(`${field}过长`);
  return text;
}

function asInt(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field}无效`);
  }
  return value;
}

function uniquePlanKeys(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("每张券必须指定至少一个套餐");
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("套餐选择无效");
    }
    const key = item.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  if (!keys.length) throw new Error("每张券必须指定至少一个套餐");
  return keys;
}

export function parseCouponDraft(input: Record<string, unknown>): CouponDraft {
  const name = asTrimmedString(input.name, "名称", COUPON_NAME_MAX);
  const code = normalizeCouponCode(String(input.code ?? ""));
  const kindRaw = typeof input.kind === "string" ? input.kind : "";
  if (!isCouponKind(kindRaw)) throw new Error("请选择折扣或满减");
  const planKeys = uniquePlanKeys(input.planKeys);
  const enabled = input.enabled !== false;
  const unlimited = input.unlimited === true || input.maxUses === 0;
  const maxUses = unlimited ? 0 : asInt(input.maxUses, "可用次数");
  if (maxUses < 0 || maxUses > COUPON_MAX_USES_CAP) {
    throw new Error("可用次数超出范围");
  }
  if (kindRaw === "percent") {
    const percentZhe = asInt(input.percentZhe, "折扣");
    if (percentZhe < 1 || percentZhe > 99) throw new Error("折扣须为 1–99 折");
    return {
      name,
      code,
      kind: "percent",
      percentZhe,
      thresholdCents: 0,
      amountCents: 0,
      maxUses,
      planKeys,
      enabled,
    };
  }
  const thresholdCents = asInt(input.thresholdCents, "满减门槛");
  const amountCents = asInt(input.amountCents, "减免金额");
  if (thresholdCents < 1) throw new Error("满减门槛必须大于 0");
  if (amountCents < 1) throw new Error("减免金额必须大于 0");
  return {
    name,
    code,
    kind: "threshold",
    percentZhe: 0,
    thresholdCents,
    amountCents,
    maxUses,
    planKeys,
    enabled,
  };
}

export function specFromDraft(draft: CouponSpec): CouponSpec {
  return specFromRecord(draft);
}

export function specFromRecord(row: {
  kind: string;
  percentZhe: number;
  thresholdCents: number;
  amountCents: number;
}): CouponSpec {
  return {
    kind: row.kind === "threshold" ? "threshold" : "percent",
    percentZhe: row.percentZhe,
    thresholdCents: row.thresholdCents,
    amountCents: row.amountCents,
  };
}

export function couponRemaining(maxUses: number, usedCount: number) {
  if (maxUses <= 0) return null;
  return Math.max(0, maxUses - usedCount);
}

export function couponUsesLeft(maxUses: number, usedCount: number) {
  if (maxUses <= 0) return true;
  return usedCount < maxUses;
}

export function describeCoupon(spec: CouponSpec) {
  if (spec.kind === "percent") return `${spec.percentZhe} 折`;
  return `满 ¥${yuanTextFromCents(spec.thresholdCents)} 减 ¥${yuanTextFromCents(spec.amountCents)}`;
}

export function previewCouponWarnings(input: {
  spec: CouponSpec;
  plans: Array<{
    planKey: string;
    planName: string;
    retailPriceCents: number;
    costPriceCents: number;
    enabled: boolean;
  }>;
  channels: Array<{ channel: PaymentChannel; feeRule: FeeRule }>;
  planKeys: string[];
  maxQuantity: number;
}): CouponWarning[] {
  const warnings: CouponWarning[] = [];
  const selected = new Set(input.planKeys);
  const channels = input.channels;
  if (!channels.length) return warnings;

  for (const plan of input.plans) {
    if (!selected.has(plan.planKey) || !plan.enabled) continue;
    if (plan.retailPriceCents <= 0 || plan.costPriceCents <= 0) continue;

    const quantities =
      input.spec.kind === "threshold"
        ? thresholdQuantities(plan.retailPriceCents, input.spec.thresholdCents, input.maxQuantity)
        : [1];

    if (input.spec.kind === "threshold" && quantities.length === 0) {
      warnings.push({
        planKey: plan.planKey,
        planName: plan.planName,
        channel: channels[0].channel,
        quantity: input.maxQuantity,
        reason: "threshold_unmet",
        message: `${plan.planName}：买 ${input.maxQuantity} 张仍未满 ¥${yuanTextFromCents(input.spec.thresholdCents)}，这张券用不上`,
      });
      continue;
    }

    for (const quantity of quantities) {
      const listGoodsCents = plan.retailPriceCents * quantity;
      const applied = applyCoupon(listGoodsCents, input.spec);
      if (!applied.ok) continue;
      for (const channel of channels) {
        const quote = couponEarningQuote({
          goodsCents: applied.goodsCents,
          costTotalCents: plan.costPriceCents * quantity,
          feeRule: channel.feeRule,
        });
        if (quote.earningCents >= 0) continue;
        warnings.push({
          planKey: plan.planKey,
          planName: plan.planName,
          channel: channel.channel,
          quantity,
          reason: "below_cost",
          message: `${plan.planName} · ${CHANNEL_LABEL[channel.channel]}：买 ${quantity} 张后，券后价扣完通道费会低于成本（券后 ¥${yuanTextFromCents(applied.goodsCents)}，成本 ¥${yuanTextFromCents(plan.costPriceCents * quantity)}，手续费 ¥${yuanTextFromCents(quote.feeOnGoodsCents)}）`,
        });
      }
    }
  }
  return warnings;
}

function thresholdQuantities(
  retailPriceCents: number,
  thresholdCents: number,
  maxQuantity: number,
) {
  if (retailPriceCents <= 0) return [];
  const need = Math.ceil(thresholdCents / retailPriceCents);
  if (need < 1 || need > maxQuantity) return [];
  return [need];
}
