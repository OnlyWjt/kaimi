import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  agentStoreCouponPlans,
  agentStoreCoupons,
  paymentChannelConfigs,
  platformPlans,
} from "@/db/schema";
import {
  applyCoupon,
  couponBelowCost,
  couponUsesLeft,
  parseCouponDraft,
  previewCouponWarnings,
  specFromDraft,
  specFromRecord,
  type CouponDraft,
  type CouponSpec,
  type CouponWarning,
} from "@/lib/coupon-core";
import { getMaxOrderQuantity } from "@/lib/store-quantity";
import type { PaymentChannel } from "@/lib/payments/fees";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CouponRow = {
  id: number;
  agentId: number;
  name: string;
  code: string;
  kind: CouponDraft["kind"];
  percentZhe: number;
  thresholdCents: number;
  amountCents: number;
  maxUses: number;
  usedCount: number;
  enabled: boolean;
  planKeys: string[];
  warnings: CouponWarning[];
};

function specFromRow(row: {
  kind: string;
  percentZhe: number;
  thresholdCents: number;
  amountCents: number;
}): CouponSpec {
  return specFromRecord(row);
}

async function loadAgentPlans(agentId: number) {
  return db
    .select({
      planKey: platformPlans.planKey,
      planName: platformPlans.name,
      retailPriceCents: agentPlanPrices.retailPriceCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      enabled: agentPlanPrices.enabled,
      planEnabled: platformPlans.enabled,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(eq(agentPlanPrices.agentId, agentId))
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));
}

async function loadFeeChannels() {
  const rows = await db
    .select({
      channel: paymentChannelConfigs.channel,
      enabled: paymentChannelConfigs.enabled,
      feeRatePpm: paymentChannelConfigs.feeRatePpm,
      fixedFeeCents: paymentChannelConfigs.fixedFeeCents,
    })
    .from(paymentChannelConfigs)
    .where(eq(paymentChannelConfigs.enabled, true));
  return rows
    .filter((row) => row.channel === "alipay" || row.channel === "wxpay")
    .map((row) => ({
      channel: row.channel as PaymentChannel,
      feeRule: { ratePpm: row.feeRatePpm, fixedFeeCents: row.fixedFeeCents },
    }));
}

export async function assertCouponPlanKeys(agentId: number, planKeys: string[]) {
  const plans = await loadAgentPlans(agentId);
  const allowed = new Set(
    plans
      .filter((plan) => plan.enabled && plan.planEnabled)
      .map((plan) => plan.planKey),
  );
  const missing = planKeys.filter((key) => !allowed.has(key));
  if (missing.length) {
    throw new Error("只能勾选已向你开放且可售的套餐");
  }
}

async function warningsForDraft(agentId: number, draft: CouponDraft) {
  const [plans, channels, maxQuantity] = await Promise.all([
    loadAgentPlans(agentId),
    loadFeeChannels(),
    getMaxOrderQuantity(),
  ]);
  return previewCouponWarnings({
    spec: specFromDraft(draft),
    planKeys: draft.planKeys,
    maxQuantity,
    channels,
    plans: plans.map((plan) => ({
      planKey: plan.planKey,
      planName: plan.planName,
      retailPriceCents: plan.retailPriceCents,
      costPriceCents: plan.costOverrideCents ?? plan.globalCostPriceCents,
      enabled: plan.enabled && plan.planEnabled,
    })),
  });
}

async function replaceCouponPlans(tx: Tx, couponId: number, planKeys: string[]) {
  await tx
    .delete(agentStoreCouponPlans)
    .where(eq(agentStoreCouponPlans.couponId, couponId));
  if (!planKeys.length) return;
  await tx.insert(agentStoreCouponPlans).values(
    planKeys.map((planKey) => ({ couponId, planKey })),
  );
}

export async function listAgentCoupons(agentId: number): Promise<CouponRow[]> {
  const rows = await db
    .select()
    .from(agentStoreCoupons)
    .where(eq(agentStoreCoupons.agentId, agentId))
    .orderBy(asc(agentStoreCoupons.id));
  if (!rows.length) return [];
  const links = await db
    .select()
    .from(agentStoreCouponPlans)
    .where(
      inArray(
        agentStoreCouponPlans.couponId,
        rows.map((row) => row.id),
      ),
    );
  const byCoupon = new Map<number, string[]>();
  for (const link of links) {
    const list = byCoupon.get(link.couponId) || [];
    list.push(link.planKey);
    byCoupon.set(link.couponId, list);
  }
  const [plans, channels, maxQuantity] = await Promise.all([
    loadAgentPlans(agentId),
    loadFeeChannels(),
    getMaxOrderQuantity(),
  ]);
  const previewPlans = plans.map((plan) => ({
    planKey: plan.planKey,
    planName: plan.planName,
    retailPriceCents: plan.retailPriceCents,
    costPriceCents: plan.costOverrideCents ?? plan.globalCostPriceCents,
    enabled: plan.enabled && plan.planEnabled,
  }));
  return rows.map((row) => {
    const planKeys = byCoupon.get(row.id) || [];
    const spec = specFromRow(row);
    return {
      id: row.id,
      agentId: row.agentId,
      name: row.name,
      code: row.code,
      kind: spec.kind,
      percentZhe: row.percentZhe,
      thresholdCents: row.thresholdCents,
      amountCents: row.amountCents,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      enabled: row.enabled,
      planKeys,
      warnings: previewCouponWarnings({
        spec,
        planKeys,
        maxQuantity,
        channels,
        plans: previewPlans,
      }),
    };
  });
}

export async function previewAgentCoupon(
  agentId: number,
  body: Record<string, unknown>,
) {
  const draft = parseCouponDraft(body);
  await assertCouponPlanKeys(agentId, draft.planKeys);
  return { draft, warnings: await warningsForDraft(agentId, draft) };
}

export async function createAgentCoupon(
  agentId: number,
  body: Record<string, unknown>,
) {
  const draft = parseCouponDraft(body);
  await assertCouponPlanKeys(agentId, draft.planKeys);
  const now = new Date().toISOString();
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentStoreCoupons)
        .values({
          agentId,
          name: draft.name,
          code: draft.code,
          kind: draft.kind,
          percentZhe: draft.percentZhe,
          thresholdCents: draft.thresholdCents,
          amountCents: draft.amountCents,
          maxUses: draft.maxUses,
          usedCount: 0,
          enabled: draft.enabled,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("优惠券创建失败");
      await replaceCouponPlans(tx, row.id, draft.planKeys);
      return row;
    });
    const [item] = (await listAgentCoupons(agentId)).filter(
      (row) => row.id === created.id,
    );
    return item ?? created;
  } catch (error) {
    if (/UNIQUE|unique/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error("这个券码在本店已经用过了");
    }
    throw error;
  }
}

export async function updateAgentCoupon(
  agentId: number,
  couponId: number,
  body: Record<string, unknown>,
) {
  const existing = await db.query.agentStoreCoupons.findFirst({
    where: and(
      eq(agentStoreCoupons.id, couponId),
      eq(agentStoreCoupons.agentId, agentId),
    ),
  });
  if (!existing) throw new Error("优惠券不存在");
  const links = await db
    .select({ planKey: agentStoreCouponPlans.planKey })
    .from(agentStoreCouponPlans)
    .where(eq(agentStoreCouponPlans.couponId, couponId));
  const draft = parseCouponDraft({
    name: body.name ?? existing.name,
    code: body.code ?? existing.code,
    kind: body.kind ?? existing.kind,
    percentZhe: body.percentZhe ?? existing.percentZhe,
    thresholdCents: body.thresholdCents ?? existing.thresholdCents,
    amountCents: body.amountCents ?? existing.amountCents,
    maxUses: body.maxUses ?? existing.maxUses,
    unlimited:
      body.unlimited === true ||
      (body.maxUses === undefined && existing.maxUses === 0),
    planKeys: body.planKeys ?? links.map((row) => row.planKey),
    enabled: body.enabled ?? existing.enabled,
  });
  if (draft.maxUses > 0 && draft.maxUses < existing.usedCount) {
    throw new Error("可用次数不能小于已经用掉的次数");
  }
  await assertCouponPlanKeys(agentId, draft.planKeys);
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(agentStoreCoupons)
        .set({
          name: draft.name,
          code: draft.code,
          kind: draft.kind,
          percentZhe: draft.percentZhe,
          thresholdCents: draft.thresholdCents,
          amountCents: draft.amountCents,
          maxUses: draft.maxUses,
          enabled: draft.enabled,
          updatedAt: now,
        })
        .where(eq(agentStoreCoupons.id, couponId));
      await replaceCouponPlans(tx, couponId, draft.planKeys);
    });
  } catch (error) {
    if (/UNIQUE|unique/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error("这个券码在本店已经用过了");
    }
    throw error;
  }
  const [item] = (await listAgentCoupons(agentId)).filter((row) => row.id === couponId);
  return item;
}

export async function setCouponEnabled(
  couponId: number,
  enabled: boolean,
  agentId?: number,
) {
  const where = agentId
    ? and(eq(agentStoreCoupons.id, couponId), eq(agentStoreCoupons.agentId, agentId))
    : eq(agentStoreCoupons.id, couponId);
  const [row] = await db
    .update(agentStoreCoupons)
    .set({ enabled, updatedAt: new Date().toISOString() })
    .where(where)
    .returning({ id: agentStoreCoupons.id });
  if (!row) throw new Error("优惠券不存在");
}

export async function loadCheckoutCoupon(input: {
  agentId: number;
  code: string;
  planKey: string;
}) {
  const code = input.code.trim().toUpperCase();
  if (!code) throw new Error("优惠券不存在或已停用");
  const coupon = await db.query.agentStoreCoupons.findFirst({
    where: and(
      eq(agentStoreCoupons.agentId, input.agentId),
      eq(agentStoreCoupons.code, code),
      eq(agentStoreCoupons.enabled, true),
    ),
  });
  if (!coupon) throw new Error("优惠券不存在或已停用");
  if (!couponUsesLeft(coupon.maxUses, coupon.usedCount)) {
    throw new Error("优惠券已用完");
  }
  const allowed = await db.query.agentStoreCouponPlans.findFirst({
    where: and(
      eq(agentStoreCouponPlans.couponId, coupon.id),
      eq(agentStoreCouponPlans.planKey, input.planKey),
    ),
  });
  if (!allowed) throw new Error("这张券不适用于当前套餐");
  return coupon;
}

export function applyCheckoutCoupon(input: {
  listGoodsCents: number;
  costTotalCents: number;
  feeRule: { ratePpm: number; fixedFeeCents: number };
  spec: CouponSpec;
}) {
  const applied = applyCoupon(input.listGoodsCents, input.spec);
  if (!applied.ok) throw new Error(applied.error);
  if (
    couponBelowCost({
      goodsCents: applied.goodsCents,
      costTotalCents: input.costTotalCents,
      feeRule: input.feeRule,
    })
  ) {
    throw new Error("这张券用在当前商品上后，扣完通道费会低于成本");
  }
  return applied;
}

export async function reserveCoupon(
  tx: Tx,
  input: { couponId: number; agentId: number },
) {
  const [row] = await tx
    .update(agentStoreCoupons)
    .set({
      usedCount: sql`${agentStoreCoupons.usedCount} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(agentStoreCoupons.id, input.couponId),
        eq(agentStoreCoupons.agentId, input.agentId),
        eq(agentStoreCoupons.enabled, true),
        or(
          eq(agentStoreCoupons.maxUses, 0),
          sql`${agentStoreCoupons.usedCount} < ${agentStoreCoupons.maxUses}`,
        ),
      ),
    )
    .returning({ id: agentStoreCoupons.id });
  if (!row) throw new Error("优惠券已用完或已停用");
}

export async function releaseCouponReservation(
  tx: Tx,
  couponId: number | null | undefined,
) {
  if (!couponId) return;
  await tx
    .update(agentStoreCoupons)
    .set({
      usedCount: sql`max(0, ${agentStoreCoupons.usedCount} - 1)`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentStoreCoupons.id, couponId));
}
