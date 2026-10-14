/**
 * 店铺邀请返券：设置、下单接入、发货后记邀请、定时发券、退款作废、统计。
 * 设计见 docs/agent-store-referral-coupon-design.md。
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  agentReferralCodes,
  agentReferralCoupons,
  agentReferralPlanRewards,
  agentReferralSettings,
  agentReferrals,
  agentStorefronts,
  agents,
  paymentChannelConfigs,
  platformPlans,
  storeOrders,
} from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { resolveProductName, rowToSettings } from "@/lib/agent-storefront-config";
import type { AuthSession } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";
import { planNameWithRegion } from "@/lib/cardplatform/regions";
import { decryptSecret, encryptSecret, hashLookupValue } from "@/lib/crypto";
import { formatBeijingDateTime } from "@/lib/datetime";
import { yuanTextFromCents } from "@/lib/money";
import { getPublicBaseUrl } from "@/lib/public-url";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import type { FeeRule } from "@/lib/payments/fees";
import {
  REFERRAL_COUPON_CODE_LENGTH,
  REFERRAL_DEFAULTS,
  REFERRAL_INVITE_CODE_LENGTH,
  type ReferralRewards,
  type ReferralSettingsInput,
  addDaysIso,
  beijingMonthStartIso,
  describeReferralRewards,
  judgeInvite,
  maskReferralEmail,
  maxReferralDiscountForPlan,
  newReferralCode,
  normalizeReferralCode,
  normalizeReferralEmail,
  parseReferralRewards,
  referralCouponDiscount,
  referralCouponUseError,
  referralRewardsError,
  referralSettingsError,
} from "@/lib/referral-core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Conn = typeof db | Tx;
type Actor = Pick<AuthSession, "id" | "role">;

export class ReferralError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 付过款的状态。refunding 还在等平台退，先当付过。 */
const PAID_STATUSES = ["paid", "manual", "refunding", "refunded"];

export function referralEmailHash(email: string) {
  return hashLookupValue(normalizeReferralEmail(email));
}

function nowIso() {
  return new Date().toISOString();
}

function safeDecrypt(value: string) {
  try {
    return decryptSecret(value);
  } catch {
    return "";
  }
}

/* —————————————————— 设置 —————————————————— */

async function settingsRow(agentId: number, conn: Conn = db) {
  const [row] = await conn
    .select()
    .from(agentReferralSettings)
    .where(eq(agentReferralSettings.agentId, agentId))
    .limit(1);
  return row ?? null;
}

function effectiveSettings(row: typeof agentReferralSettings.$inferSelect | null) {
  return {
    enabled: Boolean(row?.enabled),
    firstEnabledAt: row?.firstEnabledAt ?? null,
    couponValidDays: row?.couponValidDays ?? REFERRAL_DEFAULTS.couponValidDays,
    coolingDays: row?.coolingDays ?? REFERRAL_DEFAULTS.coolingDays,
    minOrderCents: row?.minOrderCents ?? REFERRAL_DEFAULTS.minOrderCents,
    monthlyCap: row?.monthlyCap ?? REFERRAL_DEFAULTS.monthlyCap,
    disabledByAdminAt: row?.disabledByAdminAt ?? null,
  };
}

async function feeRules(): Promise<FeeRule[]> {
  const rows = await db.select().from(paymentChannelConfigs);
  const enabled = rows.filter((row) => row.enabled);
  return (enabled.length ? enabled : rows).map((row) => ({
    ratePpm: row.feeRatePpm,
    fixedFeeCents: row.fixedFeeCents,
  }));
}

/** 这家店现在在卖的商品，带买家看到的名字、售价、代理成本。 */
async function sellablePlans(agentId: number) {
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      basePlanKey: platformPlans.basePlanKey,
      name: platformPlans.name,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
      cardplatformSellable: platformPlans.cardplatformSellable,
      fulfillmentKind: platformPlans.fulfillmentKind,
      sortOrder: platformPlans.sortOrder,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      retailPriceCents: agentPlanPrices.retailPriceCents,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, agentId),
        eq(agentPlanPrices.enabled, true),
        eq(platformPlans.enabled, true),
      ),
    )
    .orderBy(platformPlans.sortOrder, platformPlans.id);
  const storefront = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agentId),
  });
  const names = rowToSettings(storefront).productNames;
  return rows
    .filter((row) => row.cardplatformSellable || isLocalAccountPlan(row))
    .map((row) => ({
      planKey: row.planKey,
      planName: planNameWithRegion(
        resolveProductName(row.basePlanKey || row.planKey, row.name, names).zh,
        row.regionCapable,
        row.paymentCountry,
        row.regionLabel,
        "paren",
      ),
      retailPriceCents: row.retailPriceCents,
      costCents: row.costOverrideCents ?? row.globalCostPriceCents,
    }));
}

/** 只给买家看的商品名，按 plan_key 查；下架了的也要能显示（券上的快照）。 */
async function planDisplayNames(agentId: number, planKeys: string[]) {
  const keys = [...new Set(planKeys)];
  if (!keys.length) return new Map<string, string>();
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      basePlanKey: platformPlans.basePlanKey,
      name: platformPlans.name,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
    })
    .from(platformPlans)
    .where(inArray(platformPlans.planKey, keys));
  const storefront = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agentId),
  });
  const names = rowToSettings(storefront).productNames;
  return new Map(
    rows.map((row) => [
      row.planKey,
      planNameWithRegion(
        resolveProductName(row.basePlanKey || row.planKey, row.name, names).zh,
        row.regionCapable,
        row.paymentCountry,
        row.regionLabel,
        "paren",
      ),
    ]),
  );
}

export async function getReferralSettings(agentId: number) {
  const [row, plans, rules, rewards] = await Promise.all([
    settingsRow(agentId),
    sellablePlans(agentId),
    feeRules(),
    db.select().from(agentReferralPlanRewards).where(eq(agentReferralPlanRewards.agentId, agentId)),
  ]);
  const amountByPlan = new Map(rewards.map((reward) => [reward.planKey, reward.amountCents]));
  const settings = effectiveSettings(row);
  const planRows = plans.map((plan) => {
    const maxCents = maxReferralDiscountForPlan({
      retailPriceCents: plan.retailPriceCents,
      costCents: plan.costCents,
      feeRules: rules,
    });
    return {
      ...plan,
      maxCents,
      amountCents: amountByPlan.get(plan.planKey) ?? null,
      /** 售价、成本变了以后，原来填的金额可能已经超了；结账时会自动封底，这里提醒代理。 */
      overMax: (amountByPlan.get(plan.planKey) ?? 0) > maxCents,
    };
  });
  const filled = planRows.filter((plan) => plan.amountCents != null);
  // 触发一张券的好友订单代理至少赚多少（按最便宜的在卖商品、最低订单门槛估）
  const minEarning = planRows.length
    ? Math.min(...planRows.map((plan) => plan.maxCents))
    : 0;
  return {
    ...settings,
    plans: planRows,
    hint: {
      minInviteEarningCents: minEarning,
      maxCouponCents: filled.length ? Math.max(...filled.map((plan) => plan.amountCents ?? 0)) : 0,
    },
  };
}

export async function saveReferralSettings(
  agentId: number,
  input: ReferralSettingsInput & {
    enabled: boolean;
    rewards: Array<{ planKey: string; amountCents: number | null }>;
  },
  actor: Actor,
) {
  const settingsError = referralSettingsError(input);
  if (settingsError) throw new ReferralError(settingsError);
  const current = await settingsRow(agentId);
  if (input.enabled && current?.disabledByAdminAt && !current.enabled) {
    throw new ReferralError("平台关闭了你的邀请有礼，请联系平台", 403);
  }
  const [plans, rules] = await Promise.all([sellablePlans(agentId), feeRules()]);
  const planByKey = new Map(plans.map((plan) => [plan.planKey, plan]));
  const filled = input.rewards.filter((row) => row.amountCents != null && row.amountCents !== 0);
  for (const row of filled) {
    if (!planByKey.has(row.planKey)) throw new ReferralError("有商品已经不在店里卖了，请刷新后重填");
  }
  const rewardsError = referralRewardsError(
    filled.map((row) => {
      const plan = planByKey.get(row.planKey)!;
      return {
        planKey: row.planKey,
        planName: plan.planName,
        amountCents: Math.trunc(Number(row.amountCents)),
        maxCents: maxReferralDiscountForPlan({
          retailPriceCents: plan.retailPriceCents,
          costCents: plan.costCents,
          feeRules: rules,
        }),
      };
    }),
  );
  if (rewardsError) throw new ReferralError(rewardsError);
  if (input.enabled && filled.length === 0) {
    throw new ReferralError("至少给一个商品填上邀请券立减金额，才能开启");
  }
  const now = nowIso();
  await db.transaction(async (tx) => {
    const values = {
      enabled: input.enabled,
      couponValidDays: input.couponValidDays,
      coolingDays: input.coolingDays,
      minOrderCents: input.minOrderCents,
      monthlyCap: input.monthlyCap,
      updatedAt: now,
    };
    await tx
      .insert(agentReferralSettings)
      .values({
        agentId,
        ...values,
        firstEnabledAt: input.enabled ? now : null,
      })
      .onConflictDoUpdate({
        target: agentReferralSettings.agentId,
        set: {
          ...values,
          firstEnabledAt: sql`coalesce(${agentReferralSettings.firstEnabledAt}, ${input.enabled ? now : null})`,
          ...(input.enabled ? { disabledByAdminAt: null } : {}),
        },
      });
    // 只改这次在卖的商品；下架商品原来填的金额留着，重新上架就恢复。
    const sellableKeys = plans.map((plan) => plan.planKey);
    if (sellableKeys.length) {
      await tx
        .delete(agentReferralPlanRewards)
        .where(
          and(
            eq(agentReferralPlanRewards.agentId, agentId),
            inArray(agentReferralPlanRewards.planKey, sellableKeys),
          ),
        );
    }
    if (filled.length) {
      await tx.insert(agentReferralPlanRewards).values(
        filled.map((row) => ({
          agentId,
          planKey: row.planKey,
          amountCents: Math.trunc(Number(row.amountCents)),
          updatedAt: now,
        })),
      );
    }
  });
  await writeAuditLog({
    actor,
    action: "agent.referral.settings",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      enabled: input.enabled,
      couponValidDays: input.couponValidDays,
      coolingDays: input.coolingDays,
      minOrderCents: input.minOrderCents,
      monthlyCap: input.monthlyCap,
      rewards: Object.fromEntries(filled.map((row) => [row.planKey, row.amountCents])),
    },
  });
  return getReferralSettings(agentId);
}

/** 当前生效的逐商品立减额，发券时存进券里。只取还在卖的商品。 */
async function currentRewards(agentId: number, conn: Conn): Promise<ReferralRewards> {
  const rows = await conn
    .select({ planKey: agentReferralPlanRewards.planKey, amountCents: agentReferralPlanRewards.amountCents })
    .from(agentReferralPlanRewards)
    .innerJoin(platformPlans, eq(platformPlans.planKey, agentReferralPlanRewards.planKey))
    .innerJoin(
      agentPlanPrices,
      and(eq(agentPlanPrices.planId, platformPlans.id), eq(agentPlanPrices.agentId, agentId)),
    )
    .where(
      and(
        eq(agentReferralPlanRewards.agentId, agentId),
        eq(agentPlanPrices.enabled, true),
        eq(platformPlans.enabled, true),
      ),
    );
  return Object.fromEntries(rows.filter((row) => row.amountCents > 0).map((row) => [row.planKey, row.amountCents]));
}

/* —————————————————— 下单 —————————————————— */

/** 结账带进来的邀请码 → 码的 id。不是这家店的、不存在的都当没带。 */
export async function resolveCheckoutReferralCode(agentId: number, raw: string | null | undefined) {
  const code = normalizeReferralCode(raw);
  if (!code) return null;
  const [row] = await db
    .select({ id: agentReferralCodes.id })
    .from(agentReferralCodes)
    .where(and(eq(agentReferralCodes.agentId, agentId), eq(agentReferralCodes.code, code)))
    .limit(1);
  return row?.id ?? null;
}

/** 结账页手填邀请码时只告诉对不对，不透露是谁的。 */
export async function referralCodeValid(slugAgentId: number, raw: string) {
  const settings = effectiveSettings(await settingsRow(slugAgentId));
  if (!settings.enabled) return false;
  return (await resolveCheckoutReferralCode(slugAgentId, raw)) != null;
}

export async function findReferralCoupon(agentId: number, rawCode: string) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (code.length !== REFERRAL_COUPON_CODE_LENGTH) return null;
  const [row] = await db
    .select()
    .from(agentReferralCoupons)
    .where(and(eq(agentReferralCoupons.agentId, agentId), eq(agentReferralCoupons.code, code)))
    .limit(1);
  return row ?? null;
}

/** 结账时校验邀请券并算减免。下单前和询价都走这里。 */
export function applyReferralCoupon(input: {
  coupon: typeof agentReferralCoupons.$inferSelect;
  customerEmail: string | null | undefined;
  planKey: string;
  listGoodsCents: number;
  costTotalCents: number;
  feeRule: FeeRule;
}) {
  if (!input.customerEmail?.trim()) {
    throw new Error("先填下单邮箱，再使用邀请券");
  }
  const useError = referralCouponUseError(input.coupon, {
    emailHash: referralEmailHash(input.customerEmail),
    now: new Date(),
  });
  if (useError) throw new Error(useError);
  const result = referralCouponDiscount({
    rewards: parseReferralRewards(input.coupon.rewardsJson),
    planKey: input.planKey,
    listGoodsCents: input.listGoodsCents,
    costTotalCents: input.costTotalCents,
    feeRule: input.feeRule,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** 下单事务里锁券。并发两单用同一张券，只有一单拿到。 */
export async function reserveReferralCoupon(tx: Tx, couponId: number, orderId: number) {
  const [row] = await tx
    .update(agentReferralCoupons)
    .set({ status: "reserved", reservedOrderId: orderId, updatedAt: nowIso() })
    .where(
      and(
        eq(agentReferralCoupons.id, couponId),
        eq(agentReferralCoupons.status, "unused"),
        sql`${agentReferralCoupons.expiresAt} > ${nowIso()}`,
      ),
    )
    .returning({ id: agentReferralCoupons.id });
  if (!row) throw new Error("这张券刚被用掉或已失效，请刷新后重试");
}

/** 付款成功：锁定 → 已使用。 */
export async function markReferralCouponUsed(
  tx: Tx,
  order: { id: number; referralCouponId: number | null; couponDiscountCents: number },
) {
  if (!order.referralCouponId) return;
  await tx
    .update(agentReferralCoupons)
    .set({
      status: "used",
      usedOrderId: order.id,
      usedDiscountCents: order.couponDiscountCents,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(agentReferralCoupons.id, order.referralCouponId),
        eq(agentReferralCoupons.reservedOrderId, order.id),
        eq(agentReferralCoupons.status, "reserved"),
      ),
    );
}

/** 未付款关单：锁定 → 未使用（已过期就记过期）。 */
export async function releaseReferralCouponForClosedOrder(
  tx: Tx,
  order: { id: number; referralCouponId: number | null },
) {
  if (!order.referralCouponId) return;
  const now = nowIso();
  await tx
    .update(agentReferralCoupons)
    .set({
      status: sql`case when ${agentReferralCoupons.expiresAt} > ${now} then 'unused' else 'expired' end`,
      reservedOrderId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentReferralCoupons.id, order.referralCouponId),
        eq(agentReferralCoupons.reservedOrderId, order.id),
        eq(agentReferralCoupons.status, "reserved"),
      ),
    );
}

/* —————————————————— 退款 —————————————————— */

/**
 * 订单退款（和改 refunded 在同一个事务里调用）：
 * - 这单用了邀请券：券退回（没过期回到未使用，过期了记过期）。
 * - 这单是被邀请人的首单：邀请作废；已经发的券还没用就停用，用了不追回。
 */
export async function handleReferralRefund(
  tx: Tx,
  order: { id: number; referralCouponId: number | null },
) {
  const now = nowIso();
  if (order.referralCouponId) {
    await tx
      .update(agentReferralCoupons)
      .set({
        status: sql`case when ${agentReferralCoupons.expiresAt} > ${now} then 'unused' else 'expired' end`,
        reservedOrderId: null,
        usedOrderId: null,
        usedDiscountCents: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentReferralCoupons.id, order.referralCouponId),
          or(eq(agentReferralCoupons.usedOrderId, order.id), eq(agentReferralCoupons.reservedOrderId, order.id)),
          inArray(agentReferralCoupons.status, ["used", "reserved"]),
        ),
      );
  }
  const [referral] = await tx
    .select()
    .from(agentReferrals)
    .where(eq(agentReferrals.storeOrderId, order.id))
    .limit(1);
  if (!referral || referral.status === "void") return;
  const rewarded = referral.status === "rewarded";
  await tx
    .update(agentReferrals)
    .set({
      status: "void",
      voidReason: rewarded ? "refunded_after_reward" : "refunded",
      updatedAt: now,
    })
    .where(eq(agentReferrals.id, referral.id));
  if (referral.couponId) {
    await tx
      .update(agentReferralCoupons)
      .set({ status: "revoked", revokedReason: "好友订单已退款", updatedAt: now })
      .where(and(eq(agentReferralCoupons.id, referral.couponId), eq(agentReferralCoupons.status, "unused")));
  }
}

/* —————————————————— 发货后 —————————————————— */

/**
 * 订单发货成功后：给买家生成邀请码；这单带了邀请码就判断是不是有效邀请。
 * 用 referral_processed_at 认领，重复调用、定时补跑都只处理一次。
 */
export async function processDeliveredOrderReferral(orderId: number) {
  const now = nowIso();
  // 事务提交后再通知代理，免得事务回滚了消息却发出去了
  // 在事务回调里赋值，TS 看不到，用断言保住类型
  let recorded = null as {
    agentId: number;
    inviter: string;
    invitee: string;
    orderNo: string;
    amountCents: number;
    coolingDays: number;
    qualifyAt: string;
  } | null;
  await db.transaction(async (tx) => {
    const [order] = await tx
      .update(storeOrders)
      .set({ referralProcessedAt: now })
      .where(
        and(
          eq(storeOrders.id, orderId),
          isNull(storeOrders.referralProcessedAt),
          eq(storeOrders.fulfillStatus, "delivered"),
          inArray(storeOrders.payStatus, ["paid", "manual"]),
        ),
      )
      .returning();
    if (!order) return;
    const settings = effectiveSettings(await settingsRow(order.agentId, tx));
    const deliveredAt = order.deliveredAt || now;
    const email = order.customerEmail.trim().toLowerCase();
    if (!email) return;

    if (settings.enabled && settings.firstEnabledAt && deliveredAt >= settings.firstEnabledAt) {
      await ensureReferralCode(tx, { agentId: order.agentId, email, orderId: order.id });
    }

    if (!order.referralCodeId) return;
    const [code] = await tx
      .select()
      .from(agentReferralCodes)
      .where(eq(agentReferralCodes.id, order.referralCodeId))
      .limit(1);
    if (!code) return;
    const inviteeHash = referralEmailHash(email);
    const [alreadyInvited] = await tx
      .select({ id: agentReferrals.id })
      .from(agentReferrals)
      .where(and(eq(agentReferrals.agentId, order.agentId), eq(agentReferrals.inviteeEmailHash, inviteeHash)))
      .limit(1);
    const monthCount = await tx
      .select({ n: sql<number>`count(*)` })
      .from(agentReferrals)
      .where(
        and(
          eq(agentReferrals.codeId, code.id),
          inArray(agentReferrals.status, ["cooling", "rewarded"]),
          gte(agentReferrals.createdAt, beijingMonthStartIso(new Date(now))),
        ),
      );
    const judged = judgeInvite({
      enabled: settings.enabled,
      codeBelongsToAgent: code.agentId === order.agentId,
      inviterEmail: safeDecrypt(code.ownerEmailEncrypted),
      inviteeEmail: email,
      inviteePaidBefore: await paidBefore(tx, order.agentId, email, order.id),
      inviteeAlreadyInvited: Boolean(alreadyInvited),
      orderAmountCents: order.grossCents,
      minOrderCents: settings.minOrderCents,
      inviterRewardsThisMonth: Number(monthCount[0]?.n) || 0,
      monthlyCap: settings.monthlyCap,
    });
    if (!judged.record) return;
    const qualifyAt = addDaysIso(deliveredAt, settings.coolingDays);
    const inserted = await tx
      .insert(agentReferrals)
      .values({
        agentId: order.agentId,
        codeId: code.id,
        inviteeEmailHash: inviteeHash,
        inviteeEmailEncrypted: encryptSecret(email),
        storeOrderId: order.id,
        orderAmountCents: order.grossCents,
        status: judged.status,
        voidReason: judged.status === "capped" ? "monthly_cap" : "",
        qualifyAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: agentReferrals.id });
    if (inserted.length && judged.status === "cooling") {
      recorded = {
        agentId: order.agentId,
        inviter: safeDecrypt(code.ownerEmailEncrypted),
        invitee: email,
        orderNo: order.orderNo,
        amountCents: order.grossCents,
        coolingDays: settings.coolingDays,
        qualifyAt,
      };
    }
  });
  if (recorded) {
    const r = recorded;
    await notifyAgentReferral(
      r.agentId,
      (shop) =>
        [
          `[邀请有礼] ${shop}`,
          `买家 ${maskReferralEmail(r.inviter)} 邀请的好友 ${maskReferralEmail(r.invitee)} 首单成交 ¥${yuanTextFromCents(r.amountCents)}`,
          `订单 ${r.orderNo}`,
          `${r.coolingDays} 天冷静期后给邀请人发券（${formatBeijingDateTime(r.qualifyAt)}，北京时间）`,
        ].join("\n"),
    );
  }
}

/** 这个邮箱（归一化后）在这家店除这一单外有没有付过款。 */
async function paidBefore(tx: Tx, agentId: number, email: string, excludeOrderId: number) {
  const normalized = normalizeReferralEmail(email);
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  const domains = domain === "gmail.com" ? ["gmail.com", "googlemail.com"] : [domain];
  const rows = await tx
    .select({ email: storeOrders.customerEmail })
    .from(storeOrders)
    .where(
      and(
        eq(storeOrders.agentId, agentId),
        ne(storeOrders.id, excludeOrderId),
        inArray(storeOrders.payStatus, PAID_STATUSES),
        or(...domains.map((item) => like(storeOrders.customerEmail, `%@${item}`))),
      ),
    );
  return rows.some((row) => normalizeReferralEmail(row.email) === normalized);
}

async function ensureReferralCode(tx: Tx, input: { agentId: number; email: string; orderId: number }) {
  const ownerHash = referralEmailHash(input.email);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inserted = await tx
      .insert(agentReferralCodes)
      .values({
        agentId: input.agentId,
        code: newReferralCode(REFERRAL_INVITE_CODE_LENGTH),
        ownerEmailHash: ownerHash,
        ownerEmailEncrypted: encryptSecret(input.email),
        firstOrderId: input.orderId,
      })
      .onConflictDoNothing()
      .returning({ id: agentReferralCodes.id });
    if (inserted.length) return;
    const [existing] = await tx
      .select({ id: agentReferralCodes.id })
      .from(agentReferralCodes)
      .where(and(eq(agentReferralCodes.agentId, input.agentId), eq(agentReferralCodes.ownerEmailHash, ownerHash)))
      .limit(1);
    if (existing) return;
    // 没插进去也没找到 = 码撞了，换一个再试
  }
  throw new Error("邀请码生成失败");
}

/** 定时补跑：发货了但邀请还没处理的单（announceDelivered 是异步的，进程重启会漏）。 */
export async function processPendingReferralOrders(limit = 20) {
  const rows = await db
    .select({ id: storeOrders.id })
    .from(storeOrders)
    .where(
      and(
        isNull(storeOrders.referralProcessedAt),
        eq(storeOrders.fulfillStatus, "delivered"),
        inArray(storeOrders.payStatus, ["paid", "manual"]),
      ),
    )
    .limit(limit);
  for (const row of rows) await processDeliveredOrderReferral(row.id);
  return rows.length;
}

/* —————————————————— 定时发券 —————————————————— */

/** 冷静期到了的邀请：订单还好好的就发券；退款中先等等；已退款作废。 */
export async function issueDueReferralCoupons(limit = 50, now = new Date()) {
  const due = await db
    .select({ id: agentReferrals.id })
    .from(agentReferrals)
    .where(and(eq(agentReferrals.status, "cooling"), lte(agentReferrals.qualifyAt, now.toISOString())))
    .limit(limit);
  let issued = 0;
  for (const row of due) {
    if (await issueOne(row.id, now)) issued += 1;
  }
  return { checked: due.length, issued };
}

async function issueOne(referralId: number, now: Date) {
  const at = now.toISOString();
  const issuedCoupon = await db.transaction(async (tx) => {
    const [referral] = await tx
      .select()
      .from(agentReferrals)
      .where(and(eq(agentReferrals.id, referralId), eq(agentReferrals.status, "cooling")))
      .limit(1);
    if (!referral) return null;
    const [order] = await tx
      .select({ payStatus: storeOrders.payStatus })
      .from(storeOrders)
      .where(eq(storeOrders.id, referral.storeOrderId))
      .limit(1);
    if (order?.payStatus === "refunding") return null;
    const voidWith = async (reason: string) => {
      await tx
        .update(agentReferrals)
        .set({ status: "void", voidReason: reason, updatedAt: at })
        .where(and(eq(agentReferrals.id, referral.id), eq(agentReferrals.status, "cooling")));
      return null;
    };
    if (!order || (order.payStatus !== "paid" && order.payStatus !== "manual")) {
      return voidWith("refunded");
    }
    const rewards = await currentRewards(referral.agentId, tx);
    if (!Object.keys(rewards).length) return voidWith("no_rewards");
    const [code] = await tx
      .select()
      .from(agentReferralCodes)
      .where(eq(agentReferralCodes.id, referral.codeId))
      .limit(1);
    if (!code) return voidWith("code_missing");
    const settings = effectiveSettings(await settingsRow(referral.agentId, tx));
    let couponId = 0;
    let couponCode = "";
    for (let attempt = 0; attempt < 5 && !couponId; attempt += 1) {
      couponCode = newReferralCode(REFERRAL_COUPON_CODE_LENGTH);
      const [created] = await tx
        .insert(agentReferralCoupons)
        .values({
          agentId: referral.agentId,
          referralId: referral.id,
          codeId: code.id,
          code: couponCode,
          ownerEmailHash: code.ownerEmailHash,
          rewardsJson: JSON.stringify(rewards),
          status: "unused",
          expiresAt: addDaysIso(at, settings.couponValidDays),
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: agentReferralCoupons.id });
      if (created) couponId = created.id;
      else {
        // 可能是同一条邀请已经发过（referral_id 唯一），那就不重复发
        const [existing] = await tx
          .select({ id: agentReferralCoupons.id })
          .from(agentReferralCoupons)
          .where(eq(agentReferralCoupons.referralId, referral.id))
          .limit(1);
        if (existing) return null;
      }
    }
    if (!couponId) throw new Error("邀请券码生成失败");
    const [updated] = await tx
      .update(agentReferrals)
      .set({ status: "rewarded", couponId, updatedAt: at })
      .where(and(eq(agentReferrals.id, referral.id), eq(agentReferrals.status, "cooling")))
      .returning({ id: agentReferrals.id });
    if (!updated) throw new Error("邀请状态已变化");
    return {
      couponId,
      agentId: referral.agentId,
      couponCode,
      inviter: safeDecrypt(code.ownerEmailEncrypted),
      validDays: settings.couponValidDays,
      rewards,
    };
  });
  if (!issuedCoupon) return false;
  // 发券已经提交；邮件、Telegram 失败都不影响券，邮件由定时任务重试
  await sendReferralCouponNotice(issuedCoupon.couponId).catch((error) => {
    console.warn(`[referral] 得券邮件失败，稍后重试：${error instanceof Error ? error.message : error}`);
  });
  const names = await planDisplayNames(issuedCoupon.agentId, Object.keys(issuedCoupon.rewards));
  await notifyAgentReferral(issuedCoupon.agentId, (shop) =>
    [
      `[邀请有礼] ${shop}`,
      `已给 ${maskReferralEmail(issuedCoupon.inviter)} 发邀请券 ${issuedCoupon.couponCode}`,
      describeRewards(issuedCoupon.rewards, names),
      `${issuedCoupon.validDays} 天内有效`,
    ].join("\n"),
  );
  return true;
}

function describeRewards(rewards: ReferralRewards, names: Map<string, string>) {
  return describeReferralRewards(
    Object.entries(rewards).map(([planKey, amountCents]) => ({
      planName: names.get(planKey) || planKey,
      amountCents,
    })),
  );
}

/* —————————————————— 通知 —————————————————— */

/** 给代理发 Telegram。没绑定、关了通知就不发；失败只记日志，不影响业务。 */
async function notifyAgentReferral(agentId: number, text: (shop: string) => string) {
  try {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: { displayName: true, shopName: true, telegramChatId: true, telegramNotifyEnabled: true },
    });
    if (!agent?.telegramChatId || agent.telegramNotifyEnabled === false) return;
    const { dispatchNotifyText } = await import("@/lib/notify");
    await dispatchNotifyText(
      text(publicShopName(agent)),
      { audience: "agent" },
      "referral.agent",
      { telegramChatId: agent.telegramChatId, webhookUrl: "" },
    );
  } catch (error) {
    console.warn(`[referral] 代理 Telegram 通知失败：${error instanceof Error ? error.message : error}`);
  }
}

/** 发货邮件末尾的「邀请好友」一段。没开活动、没邀请码、没配公网地址就返回空。 */
export async function referralInviteMailLines(order: {
  id: number;
  agentId: number;
  customerEmail: string;
  fulfillStatus: string;
  referralProcessedAt: string | null;
}) {
  const origin = await getPublicBaseUrl();
  if (!origin) return [];
  // 发货邮件和邀请处理是同时触发的，先把邀请码补上（幂等）
  if (order.fulfillStatus === "delivered" && !order.referralProcessedAt) {
    await processDeliveredOrderReferral(order.id);
  }
  const view = await buyerReferralView(order, origin);
  if (!view?.invite) return [];
  return [
    "",
    "————————",
    "邀请好友，得邀请券",
    view.invite.rule,
    view.invite.link,
    `好友没点链接的话，下单时填邀请码 ${view.invite.code} 也行。`,
  ];
}

const MAIL_ATTEMPTS = 5;
const MAIL_SENDING_STALE_MS = 2 * 60_000;
const REMIND_BEFORE_MS = 3 * 86_400_000;
/** 有效期太短的券不发到期提醒，免得刚到账就提醒要过期。 */
const REMIND_MIN_VALID_MS = 4 * 86_400_000;

async function couponMailContext(couponId: number) {
  const coupon = await db.query.agentReferralCoupons.findFirst({
    where: eq(agentReferralCoupons.id, couponId),
  });
  if (!coupon) return null;
  const [code, agent] = await Promise.all([
    db.query.agentReferralCodes.findFirst({ where: eq(agentReferralCodes.id, coupon.codeId) }),
    db.query.agents.findFirst({ where: eq(agents.id, coupon.agentId), columns: { currentSlug: true } }),
  ]);
  const rewards = parseReferralRewards(coupon.rewardsJson);
  const names = await planDisplayNames(coupon.agentId, Object.keys(rewards));
  const origin = await getPublicBaseUrl();
  const email = code ? safeDecrypt(code.ownerEmailEncrypted) : "";
  return {
    coupon,
    email,
    description: describeRewards(rewards, names),
    shopUrl: origin && agent?.currentSlug ? `${origin}/s/${agent.currentSlug}` : "",
  };
}

function couponUseLines(ctx: NonNullable<Awaited<ReturnType<typeof couponMailContext>>>) {
  return [
    `券码 ${ctx.coupon.code}`,
    `可用于：${ctx.description}`,
    `有效期至 ${formatBeijingDateTime(ctx.coupon.expiresAt)}（北京时间）`,
    "",
    `下次在本店下单时，在「优惠券」里填券码。下单邮箱要用这个邮箱（${maskReferralEmail(ctx.email)}），别的邮箱用不了。`,
    ...(ctx.shopUrl ? [ctx.shopUrl] : []),
  ];
}

/** 得券通知邮件。认领 notice_status，并发和重试都只发一次。 */
export async function sendReferralCouponNotice(couponId: number) {
  const now = nowIso();
  const stale = new Date(Date.now() - MAIL_SENDING_STALE_MS).toISOString();
  const [claimed] = await db
    .update(agentReferralCoupons)
    .set({ noticeStatus: "sending", updatedAt: now })
    .where(
      and(
        eq(agentReferralCoupons.id, couponId),
        lt(agentReferralCoupons.noticeAttempts, MAIL_ATTEMPTS),
        or(
          inArray(agentReferralCoupons.noticeStatus, ["pending", "failed"]),
          and(eq(agentReferralCoupons.noticeStatus, "sending"), lt(agentReferralCoupons.updatedAt, stale)),
        ),
      ),
    )
    .returning({ id: agentReferralCoupons.id });
  if (!claimed) return;
  const finish = (status: string, error = "", countAttempt = false) =>
    db
      .update(agentReferralCoupons)
      .set({
        noticeStatus: status,
        noticeError: error.slice(0, 300),
        ...(countAttempt ? { noticeAttempts: sql`${agentReferralCoupons.noticeAttempts} + 1` } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(agentReferralCoupons.id, couponId));
  try {
    const ctx = await couponMailContext(couponId);
    if (!ctx || ctx.coupon.status !== "unused") {
      await finish("skipped", "券已不可用");
      return;
    }
    const { sendShopMail } = await import("@/lib/mail");
    const result = await sendShopMail({
      agentId: ctx.coupon.agentId,
      to: ctx.email,
      subject: (shop) => `${shop} 邀请券到账`,
      lines: () => ["你邀请的好友在本店下单成功，送你一张邀请券：", "", ...couponUseLines(ctx)],
    });
    await finish(result.sent ? "sent" : "skipped", result.sent ? "" : result.reason);
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : "发信失败", true);
    throw error;
  }
}

/** 定时补发失败的得券邮件。只补发券后 3 天内的，过久就不打扰了。 */
export async function retryReferralCouponNotices(limit = 10) {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const rows = await db
    .select({ id: agentReferralCoupons.id })
    .from(agentReferralCoupons)
    .where(
      and(
        inArray(agentReferralCoupons.noticeStatus, ["pending", "failed", "sending"]),
        lt(agentReferralCoupons.noticeAttempts, MAIL_ATTEMPTS),
        gte(agentReferralCoupons.createdAt, since),
      ),
    )
    .limit(limit);
  let sent = 0;
  for (const row of rows) {
    try {
      await sendReferralCouponNotice(row.id);
      sent += 1;
    } catch {
      /* 已记 failed，下一轮再试 */
    }
  }
  return sent;
}

/** 到期前 3 天提醒还没用的券，每张只提醒一次。 */
export async function sendReferralCouponReminders(now = new Date(), limit = 20) {
  const nowIsoValue = now.toISOString();
  const soon = new Date(now.getTime() + REMIND_BEFORE_MS).toISOString();
  const stale = new Date(now.getTime() - MAIL_SENDING_STALE_MS).toISOString();
  const candidates = await db
    .select({
      id: agentReferralCoupons.id,
      createdAt: agentReferralCoupons.createdAt,
      expiresAt: agentReferralCoupons.expiresAt,
    })
    .from(agentReferralCoupons)
    .where(
      and(
        eq(agentReferralCoupons.status, "unused"),
        gt(agentReferralCoupons.expiresAt, nowIsoValue),
        lte(agentReferralCoupons.expiresAt, soon),
        inArray(agentReferralCoupons.remindStatus, ["", "failed", "sending"]),
        lt(agentReferralCoupons.remindAttempts, 3),
      ),
    )
    .limit(limit);
  let sent = 0;
  for (const row of candidates) {
    if (Date.parse(row.expiresAt) - Date.parse(row.createdAt) < REMIND_MIN_VALID_MS) {
      await db
        .update(agentReferralCoupons)
        .set({ remindStatus: "skipped" })
        .where(and(eq(agentReferralCoupons.id, row.id), eq(agentReferralCoupons.remindStatus, "")));
      continue;
    }
    const [claimed] = await db
      .update(agentReferralCoupons)
      .set({ remindStatus: "sending", updatedAt: nowIso() })
      .where(
        and(
          eq(agentReferralCoupons.id, row.id),
          eq(agentReferralCoupons.status, "unused"),
          or(
            inArray(agentReferralCoupons.remindStatus, ["", "failed"]),
            and(eq(agentReferralCoupons.remindStatus, "sending"), lt(agentReferralCoupons.updatedAt, stale)),
          ),
        ),
      )
      .returning({ id: agentReferralCoupons.id });
    if (!claimed) continue;
    try {
      const ctx = await couponMailContext(row.id);
      if (!ctx) continue;
      const { sendShopMail } = await import("@/lib/mail");
      const result = await sendShopMail({
        agentId: ctx.coupon.agentId,
        to: ctx.email,
        subject: (shop) => `${shop} 邀请券快到期了`,
        lines: () => ["你在本店的邀请券还没用，3 天内就要到期了：", "", ...couponUseLines(ctx)],
      });
      await db
        .update(agentReferralCoupons)
        .set({ remindStatus: result.sent ? "sent" : "skipped" })
        .where(eq(agentReferralCoupons.id, row.id));
      if (result.sent) sent += 1;
    } catch (error) {
      console.warn(`[referral] 到期提醒失败：${error instanceof Error ? error.message : error}`);
      await db
        .update(agentReferralCoupons)
        .set({ remindStatus: "failed", remindAttempts: sql`${agentReferralCoupons.remindAttempts} + 1` })
        .where(eq(agentReferralCoupons.id, row.id));
    }
  }
  return sent;
}

export async function expireReferralCoupons(now = new Date()) {
  const rows = await db
    .update(agentReferralCoupons)
    .set({ status: "expired", updatedAt: now.toISOString() })
    .where(and(eq(agentReferralCoupons.status, "unused"), lte(agentReferralCoupons.expiresAt, now.toISOString())))
    .returning({ id: agentReferralCoupons.id });
  return rows.length;
}

/** sync-scheduler 每分钟调一次。 */
export async function runReferralJobs() {
  const processed = await processPendingReferralOrders();
  const { issued } = await issueDueReferralCoupons();
  const expired = await expireReferralCoupons();
  const noticed = await retryReferralCouponNotices();
  const reminded = await sendReferralCouponReminders();
  return { processed, issued, expired, noticed, reminded };
}

/* —————————————————— 买家查单页 —————————————————— */

/**
 * 查单页（凭完整订单号 / 查询凭证才进得来）上的邀请卡片和「我的优惠券」。
 * 没开活动也照样列出已经发的券；没码就不显示邀请卡片。
 */
export async function buyerReferralView(order: { agentId: number; customerEmail: string }, origin: string) {
  const email = order.customerEmail.trim().toLowerCase();
  if (!email) return null;
  const ownerHash = referralEmailHash(email);
  const [settingsRowValue, code, coupons, agent] = await Promise.all([
    settingsRow(order.agentId),
    db
      .select()
      .from(agentReferralCodes)
      .where(and(eq(agentReferralCodes.agentId, order.agentId), eq(agentReferralCodes.ownerEmailHash, ownerHash)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(agentReferralCoupons)
      .where(and(eq(agentReferralCoupons.agentId, order.agentId), eq(agentReferralCoupons.ownerEmailHash, ownerHash)))
      .orderBy(desc(agentReferralCoupons.id))
      .limit(50),
    db.query.agents.findFirst({ where: eq(agents.id, order.agentId), columns: { currentSlug: true } }),
  ]);
  const settings = effectiveSettings(settingsRowValue);
  if (!code && !coupons.length) return null;
  const allPlanKeys = coupons.flatMap((coupon) => Object.keys(parseReferralRewards(coupon.rewardsJson)));
  const rewardsNow = settings.enabled ? await currentRewards(order.agentId, db) : {};
  const names = await planDisplayNames(order.agentId, [...allPlanKeys, ...Object.keys(rewardsNow)]);
  const describe = (rewards: ReferralRewards) =>
    describeReferralRewards(
      Object.entries(rewards).map(([planKey, amountCents]) => ({
        planName: names.get(planKey) || planKey,
        amountCents,
      })),
    );
  let invite = null;
  if (code && settings.enabled && agent?.currentSlug) {
    const counts = await db
      .select({ status: agentReferrals.status, n: sql<number>`count(*)` })
      .from(agentReferrals)
      .where(eq(agentReferrals.codeId, code.id))
      .groupBy(agentReferrals.status);
    const count = (status: string) => Number(counts.find((row) => row.status === status)?.n) || 0;
    invite = {
      code: code.code,
      link: `${origin}/s/${agent.currentSlug}?ref=${code.code}`,
      rule: `好友第一次在本店下单并满 ${settings.coolingDays} 天，你得一张邀请券：${describe(rewardsNow)}（${settings.couponValidDays} 天有效）`,
      rewardedCount: count("rewarded"),
      coolingCount: count("cooling"),
    };
  }
  const now = Date.now();
  return {
    invite,
    coupons: coupons.map((coupon) => ({
      code: coupon.code,
      description: describe(parseReferralRewards(coupon.rewardsJson)),
      expiresAt: coupon.expiresAt,
      status:
        coupon.status === "unused" && Date.parse(coupon.expiresAt) <= now ? "expired" : coupon.status,
      usedDiscountCents: coupon.usedDiscountCents,
    })),
  };
}

/* —————————————————— 代理 / 管理员查看 —————————————————— */

export async function referralSummary(agentId: number | null, range: "month" | "all") {
  const since = range === "month" ? beijingMonthStartIso(new Date()) : "";
  const agentFilter = (column: typeof agentReferrals.agentId | typeof agentReferralCoupons.agentId) =>
    agentId ? eq(column, agentId) : undefined;
  const [referralRows, couponRows] = await Promise.all([
    db
      .select({
        status: agentReferrals.status,
        n: sql<number>`count(*)`,
        amount: sql<number>`coalesce(sum(${agentReferrals.orderAmountCents}), 0)`,
      })
      .from(agentReferrals)
      .where(and(agentFilter(agentReferrals.agentId), since ? gte(agentReferrals.createdAt, since) : undefined))
      .groupBy(agentReferrals.status),
    db
      .select({
        status: agentReferralCoupons.status,
        n: sql<number>`count(*)`,
        discount: sql<number>`coalesce(sum(${agentReferralCoupons.usedDiscountCents}), 0)`,
      })
      .from(agentReferralCoupons)
      .where(
        and(agentFilter(agentReferralCoupons.agentId), since ? gte(agentReferralCoupons.createdAt, since) : undefined),
      )
      .groupBy(agentReferralCoupons.status),
  ]);
  const ref = (status: string) => referralRows.find((row) => row.status === status);
  const cou = (status: string) => couponRows.find((row) => row.status === status);
  const invitedRows = referralRows.filter((row) => row.status !== "void");
  return {
    invitedCount: invitedRows.reduce((sum, row) => sum + Number(row.n), 0),
    invitedAmountCents: invitedRows.reduce((sum, row) => sum + Number(row.amount), 0),
    coolingCount: Number(ref("cooling")?.n) || 0,
    cappedCount: Number(ref("capped")?.n) || 0,
    voidCount: Number(ref("void")?.n) || 0,
    issuedCount: couponRows.reduce((sum, row) => sum + Number(row.n), 0),
    usedCount: Number(cou("used")?.n) || 0,
    expiredCount: Number(cou("expired")?.n) || 0,
    revokedCount: Number(cou("revoked")?.n) || 0,
    discountCents: Number(cou("used")?.discount) || 0,
  };
}

export async function listReferralInviters(
  agentId: number,
  input: { q?: string; page?: number; pageSize?: number },
) {
  const page = Math.max(1, Math.trunc(input.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize || 20)));
  const q = (input.q || "").trim();
  let filterIds: number[] | null = null;
  if (q) {
    // 邮箱是加密存的，按 hash 精确查；也可以直接搜邀请码或券码
    const upper = q.toUpperCase();
    const byCode = await db
      .select({ id: agentReferralCodes.id })
      .from(agentReferralCodes)
      .where(
        and(
          eq(agentReferralCodes.agentId, agentId),
          or(eq(agentReferralCodes.code, upper), eq(agentReferralCodes.ownerEmailHash, referralEmailHash(q))),
        ),
      );
    const byCoupon = await db
      .select({ id: agentReferralCoupons.codeId })
      .from(agentReferralCoupons)
      .where(and(eq(agentReferralCoupons.agentId, agentId), eq(agentReferralCoupons.code, upper)));
    filterIds = [...new Set([...byCode, ...byCoupon].map((row) => row.id))];
    if (!filterIds.length) return { list: [], total: 0, page, pageSize };
  }
  // 只列有过邀请的邀请人；没邀请过人的买家太多，列出来没意义
  const where = and(
    eq(agentReferralCodes.agentId, agentId),
    filterIds ? inArray(agentReferralCodes.id, filterIds) : undefined,
    filterIds ? undefined : sql`exists (select 1 from agent_referrals r where r.code_id = ${agentReferralCodes.id})`,
  );
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(agentReferralCodes).where(where);
  const codes = await db
    .select()
    .from(agentReferralCodes)
    .where(where)
    .orderBy(desc(agentReferralCodes.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const ids = codes.map((code) => code.id);
  const [refStats, couponStats] = ids.length
    ? await Promise.all([
        db
          .select({ codeId: agentReferrals.codeId, status: agentReferrals.status, n: sql<number>`count(*)` })
          .from(agentReferrals)
          .where(inArray(agentReferrals.codeId, ids))
          .groupBy(agentReferrals.codeId, agentReferrals.status),
        db
          .select({
            codeId: agentReferralCoupons.codeId,
            status: agentReferralCoupons.status,
            n: sql<number>`count(*)`,
            discount: sql<number>`coalesce(sum(${agentReferralCoupons.usedDiscountCents}), 0)`,
          })
          .from(agentReferralCoupons)
          .where(inArray(agentReferralCoupons.codeId, ids))
          .groupBy(agentReferralCoupons.codeId, agentReferralCoupons.status),
      ])
    : [[], []];
  return {
    list: codes.map((code) => {
      const refs = refStats.filter((row) => row.codeId === code.id);
      const cps = couponStats.filter((row) => row.codeId === code.id);
      const refCount = (status: string) => Number(refs.find((row) => row.status === status)?.n) || 0;
      return {
        codeId: code.id,
        code: code.code,
        email: safeDecrypt(code.ownerEmailEncrypted),
        createdAt: code.createdAt,
        rewardedCount: refCount("rewarded"),
        coolingCount: refCount("cooling"),
        cappedCount: refCount("capped"),
        voidCount: refCount("void"),
        couponCount: cps.reduce((sum, row) => sum + Number(row.n), 0),
        usedCount: Number(cps.find((row) => row.status === "used")?.n) || 0,
        discountCents: Number(cps.find((row) => row.status === "used")?.discount) || 0,
      };
    }),
    total: Number(total) || 0,
    page,
    pageSize,
  };
}

export async function getReferralInviter(agentId: number, codeId: number) {
  const [code] = await db
    .select()
    .from(agentReferralCodes)
    .where(and(eq(agentReferralCodes.id, codeId), eq(agentReferralCodes.agentId, agentId)))
    .limit(1);
  if (!code) throw new ReferralError("邀请人不存在", 404);
  const [referrals, coupons] = await Promise.all([
    db
      .select({
        id: agentReferrals.id,
        status: agentReferrals.status,
        voidReason: agentReferrals.voidReason,
        qualifyAt: agentReferrals.qualifyAt,
        orderAmountCents: agentReferrals.orderAmountCents,
        inviteeEmailEncrypted: agentReferrals.inviteeEmailEncrypted,
        createdAt: agentReferrals.createdAt,
        orderNo: storeOrders.orderNo,
        couponId: agentReferrals.couponId,
      })
      .from(agentReferrals)
      .innerJoin(storeOrders, eq(storeOrders.id, agentReferrals.storeOrderId))
      .where(eq(agentReferrals.codeId, code.id))
      .orderBy(desc(agentReferrals.id)),
    db
      .select({
        id: agentReferralCoupons.id,
        code: agentReferralCoupons.code,
        status: agentReferralCoupons.status,
        rewardsJson: agentReferralCoupons.rewardsJson,
        expiresAt: agentReferralCoupons.expiresAt,
        usedDiscountCents: agentReferralCoupons.usedDiscountCents,
        revokedReason: agentReferralCoupons.revokedReason,
        createdAt: agentReferralCoupons.createdAt,
        usedOrderNo: storeOrders.orderNo,
      })
      .from(agentReferralCoupons)
      .leftJoin(storeOrders, eq(storeOrders.id, agentReferralCoupons.usedOrderId))
      .where(eq(agentReferralCoupons.codeId, code.id))
      .orderBy(desc(agentReferralCoupons.id)),
  ]);
  const names = await planDisplayNames(
    agentId,
    coupons.flatMap((coupon) => Object.keys(parseReferralRewards(coupon.rewardsJson))),
  );
  const now = Date.now();
  return {
    codeId: code.id,
    code: code.code,
    email: safeDecrypt(code.ownerEmailEncrypted),
    createdAt: code.createdAt,
    referrals: referrals.map(({ inviteeEmailEncrypted, ...row }) => ({
      ...row,
      inviteeEmail: safeDecrypt(inviteeEmailEncrypted),
    })),
    coupons: coupons.map(({ rewardsJson, ...row }) => ({
      ...row,
      status: row.status === "unused" && Date.parse(row.expiresAt) <= now ? "expired" : row.status,
      description: describeReferralRewards(
        Object.entries(parseReferralRewards(rewardsJson)).map(([planKey, amountCents]) => ({
          planName: names.get(planKey) || planKey,
          amountCents,
        })),
      ),
    })),
  };
}

/** 停用一张没用掉的券。agentId 传了就只能停自己店的。 */
export async function revokeReferralCoupon(
  input: { couponId: number; reason: string; agentId?: number },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (!reason) throw new ReferralError("请填写停用原因");
  const [row] = await db
    .update(agentReferralCoupons)
    .set({ status: "revoked", revokedReason: reason.slice(0, 200), revokedBy: actor.id, updatedAt: nowIso() })
    .where(
      and(
        eq(agentReferralCoupons.id, input.couponId),
        input.agentId ? eq(agentReferralCoupons.agentId, input.agentId) : undefined,
        eq(agentReferralCoupons.status, "unused"),
      ),
    )
    .returning({ id: agentReferralCoupons.id, agentId: agentReferralCoupons.agentId });
  if (!row) throw new ReferralError("只有未使用的券可以停用", 409);
  await writeAuditLog({
    actor,
    action: actor.role === "agent" ? "agent.referral.coupon.revoke" : "admin.referral.coupon.revoke",
    targetType: "agent_referral_coupon",
    targetId: row.id,
    metadata: { agentId: row.agentId, reason },
  });
}

export async function adminDisableReferral(agentId: number, actor: Actor) {
  const now = nowIso();
  const [row] = await db
    .update(agentReferralSettings)
    .set({ enabled: false, disabledByAdminAt: now, updatedAt: now })
    .where(and(eq(agentReferralSettings.agentId, agentId), eq(agentReferralSettings.enabled, true)))
    .returning({ agentId: agentReferralSettings.agentId });
  if (!row) throw new ReferralError("这个代理没开邀请有礼", 409);
  await writeAuditLog({ actor, action: "admin.referral.disable", targetType: "agent", targetId: agentId });
}

/** 管理端：每个开过活动的代理一行，外加需要人工看一眼的邀请人。 */
export async function adminReferralOverview() {
  const [settingsRows, total, month] = await Promise.all([
    db.select().from(agentReferralSettings).where(isNotNull(agentReferralSettings.firstEnabledAt)),
    referralSummary(null, "all"),
    referralSummary(null, "month"),
  ]);
  const agentIds = settingsRows.map((row) => row.agentId);
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, displayName: agents.displayName, shopName: agents.shopName })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const perAgent = await Promise.all(
    settingsRows.map(async (row) => {
      const agent = agentRows.find((item) => item.id === row.agentId);
      return {
        agentId: row.agentId,
        name: agent ? publicShopName(agent) : String(row.agentId),
        enabled: row.enabled,
        disabledByAdmin: Boolean(row.disabledByAdminAt),
        month: await referralSummary(row.agentId, "month"),
        total: await referralSummary(row.agentId, "all"),
      };
    }),
  );
  // 本月触顶、或被邀请订单作废多的邀请人
  const monthStart = beijingMonthStartIso(new Date());
  const flagged = await db
    .select({
      codeId: agentReferrals.codeId,
      agentId: agentReferrals.agentId,
      capped: sql<number>`sum(case when ${agentReferrals.status} = 'capped' then 1 else 0 end)`,
      voided: sql<number>`sum(case when ${agentReferrals.status} = 'void' then 1 else 0 end)`,
      n: sql<number>`count(*)`,
    })
    .from(agentReferrals)
    .where(gte(agentReferrals.createdAt, monthStart))
    .groupBy(agentReferrals.codeId, agentReferrals.agentId)
    .having(
      sql`sum(case when ${agentReferrals.status} = 'capped' then 1 else 0 end) > 0 or sum(case when ${agentReferrals.status} = 'void' then 1 else 0 end) >= 2`,
    )
    .limit(50);
  const flaggedCodes = flagged.length
    ? await db
        .select()
        .from(agentReferralCodes)
        .where(inArray(agentReferralCodes.id, flagged.map((row) => row.codeId)))
    : [];
  return {
    total,
    month,
    agents: perAgent,
    flagged: flagged.map((row) => {
      const code = flaggedCodes.find((item) => item.id === row.codeId);
      return {
        agentId: row.agentId,
        agentName: perAgent.find((item) => item.agentId === row.agentId)?.name || String(row.agentId),
        codeId: row.codeId,
        code: code?.code || "",
        email: code ? maskReferralEmail(safeDecrypt(code.ownerEmailEncrypted)) : "",
        monthCount: Number(row.n) || 0,
        cappedCount: Number(row.capped) || 0,
        voidCount: Number(row.voided) || 0,
      };
    }),
  };
}
