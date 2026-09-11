import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  agentStoreCouponPlans,
  agentStoreCoupons,
  agents,
  issuedCdks,
  storeOrders,
} from "@/db/schema";
import { couponRemaining, describeCoupon } from "@/lib/coupon-core";
import { isLocalAccountPlan } from "@/lib/finished-account-core";

export type UsageOrderCounts = {
  placed: number;
  paid: number;
  unpaid: number;
  refunded: number;
  delivered: number;
  partial: number;
  paidUndelivered: number;
};

export type UsageCdkCounts = {
  issued: number;
  unused: number;
  used: number;
  redeeming: number;
  disabled: number;
  unusedBacklog: number;
};

export type UsageCouponRow = {
  id: number;
  agentId: number;
  name: string;
  code: string;
  kind: string;
  label: string;
  maxUses: number;
  usedCount: number;
  remaining: number | null;
  enabled: boolean;
  planKeys: string[];
  discountPaidCents: number;
};

export type UsagePlanRow = {
  planKey: string;
  planName: string;
  placed: number;
  paid: number;
  delivered: number;
  localAccountSold: number;
  cdkIssued: number;
  cdkUnused: number;
};

export type UsageAgentRow = {
  agentId: number;
  agentName: string;
  placed: number;
  paid: number;
  unusedBacklog: number;
};

export type UsageStats = {
  orders: UsageOrderCounts;
  cdks: UsageCdkCounts;
  localAccountSold: number;
  coupons: UsageCouponRow[];
  byPlan: UsagePlanRow[];
  byAgent: UsageAgentRow[];
};

function emptyOrders(): UsageOrderCounts {
  return {
    placed: 0,
    paid: 0,
    unpaid: 0,
    refunded: 0,
    delivered: 0,
    partial: 0,
    paidUndelivered: 0,
  };
}

function emptyCdks(): UsageCdkCounts {
  return {
    issued: 0,
    unused: 0,
    used: 0,
    redeeming: 0,
    disabled: 0,
    unusedBacklog: 0,
  };
}

function bumpCdk(target: UsageCdkCounts, status: string, inRange: boolean) {
  if (status === "unused") target.unusedBacklog += 1;
  if (!inRange) return;
  target.issued += 1;
  if (status === "unused") target.unused += 1;
  else if (status === "used") target.used += 1;
  else if (status === "disabled") target.disabled += 1;
  else if (status === "locked" || status === "redeeming") target.redeeming += 1;
}

function planBucket(
  map: Map<string, UsagePlanRow>,
  planKey: string,
  planName: string,
) {
  const current = map.get(planKey);
  if (current) return current;
  const next: UsagePlanRow = {
    planKey,
    planName,
    placed: 0,
    paid: 0,
    delivered: 0,
    localAccountSold: 0,
    cdkIssued: 0,
    cdkUnused: 0,
  };
  map.set(planKey, next);
  return next;
}

export async function loadUsageStats(input: {
  startIso: string;
  endIso: string;
  agentId?: number;
}): Promise<UsageStats> {
  const orderWhere = [
    gte(storeOrders.createdAt, input.startIso),
    lte(storeOrders.createdAt, input.endIso),
  ];
  if (input.agentId && input.agentId > 0) {
    orderWhere.push(eq(storeOrders.agentId, input.agentId));
  }

  const orders = await db
    .select({
      id: storeOrders.id,
      agentId: storeOrders.agentId,
      planKey: storeOrders.planKeySnapshot,
      planName: storeOrders.productNameSnapshot,
      quantity: storeOrders.quantity,
      payStatus: storeOrders.payStatus,
      fulfillStatus: storeOrders.fulfillStatus,
      couponId: storeOrders.couponId,
      couponDiscountCents: storeOrders.couponDiscountCents,
    })
    .from(storeOrders)
    .where(and(...orderWhere));

  const agentIds = [...new Set(orders.map((row) => row.agentId))];
  if (input.agentId && input.agentId > 0) agentIds.push(input.agentId);

  const scopedAgent = input.agentId && input.agentId > 0 ? input.agentId : 0;
  const cdks = scopedAgent
    ? await db
        .select({
          agentId: issuedCdks.agentId,
          planKey: issuedCdks.planKey,
          status: issuedCdks.status,
          issuedAt: issuedCdks.issuedAt,
        })
        .from(issuedCdks)
        .where(eq(issuedCdks.agentId, scopedAgent))
    : await db
        .select({
          agentId: issuedCdks.agentId,
          planKey: issuedCdks.planKey,
          status: issuedCdks.status,
          issuedAt: issuedCdks.issuedAt,
        })
        .from(issuedCdks);

  const couponRows = scopedAgent
    ? await db
        .select()
        .from(agentStoreCoupons)
        .where(eq(agentStoreCoupons.agentId, scopedAgent))
        .orderBy(asc(agentStoreCoupons.id))
    : await db
        .select()
        .from(agentStoreCoupons)
        .orderBy(asc(agentStoreCoupons.agentId), asc(agentStoreCoupons.id));
  const couponIds = couponRows.map((row) => row.id);
  const couponLinks = couponIds.length
    ? await db
        .select()
        .from(agentStoreCouponPlans)
        .where(inArray(agentStoreCouponPlans.couponId, couponIds))
    : [];
  const plansByCoupon = new Map<number, string[]>();
  for (const link of couponLinks) {
    const list = plansByCoupon.get(link.couponId) || [];
    list.push(link.planKey);
    plansByCoupon.set(link.couponId, list);
  }

  const namedAgents = agentIds.length
    ? await db
        .select({ id: agents.id, displayName: agents.displayName })
        .from(agents)
        .where(inArray(agents.id, [...new Set(agentIds)]))
    : [];
  const agentName = new Map(namedAgents.map((row) => [row.id, row.displayName]));

  const orderCounts = emptyOrders();
  const cdkCounts = emptyCdks();
  const byPlan = new Map<string, UsagePlanRow>();
  const byAgent = new Map<number, UsageAgentRow>();
  const couponDiscount = new Map<number, number>();
  let localAccountSold = 0;

  function agentBucket(agentId: number) {
    const current = byAgent.get(agentId);
    if (current) return current;
    const next: UsageAgentRow = {
      agentId,
      agentName: agentName.get(agentId) || `代理 ${agentId}`,
      placed: 0,
      paid: 0,
      unusedBacklog: 0,
    };
    byAgent.set(agentId, next);
    return next;
  }

  for (const order of orders) {
    orderCounts.placed += 1;
    const plan = planBucket(byPlan, order.planKey, order.planName);
    const agent = agentBucket(order.agentId);
    plan.placed += 1;
    agent.placed += 1;
    const refunded = order.payStatus === "refunded" || order.payStatus === "chargeback";
    const paid = order.payStatus === "paid";
    if (refunded) orderCounts.refunded += 1;
    else if (paid) {
      orderCounts.paid += 1;
      plan.paid += 1;
      agent.paid += 1;
      if (order.couponId && order.couponDiscountCents > 0) {
        couponDiscount.set(
          order.couponId,
          (couponDiscount.get(order.couponId) || 0) + order.couponDiscountCents,
        );
      }
      if (isLocalAccountPlan({ planKey: order.planKey })) {
        localAccountSold += order.quantity;
        plan.localAccountSold += order.quantity;
      }
      if (order.fulfillStatus === "delivered") {
        orderCounts.delivered += 1;
        plan.delivered += 1;
      } else if (order.fulfillStatus === "partially_delivered") {
        orderCounts.partial += 1;
        orderCounts.paidUndelivered += 1;
      } else {
        orderCounts.paidUndelivered += 1;
      }
    } else {
      orderCounts.unpaid += 1;
    }
  }

  for (const cdk of cdks) {
    const inRange = cdk.issuedAt >= input.startIso && cdk.issuedAt <= input.endIso;
    bumpCdk(cdkCounts, cdk.status, inRange);
    const plan = planBucket(byPlan, cdk.planKey, cdk.planKey);
    if (inRange) plan.cdkIssued += 1;
    if (cdk.status === "unused") {
      plan.cdkUnused += 1;
      agentBucket(cdk.agentId).unusedBacklog += 1;
    }
  }

  const coupons: UsageCouponRow[] = couponRows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    code: row.code,
    kind: row.kind,
    label: describeCoupon({
      kind: row.kind === "threshold" ? "threshold" : "percent",
      percentZhe: row.percentZhe,
      thresholdCents: row.thresholdCents,
      amountCents: row.amountCents,
    }),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    remaining: couponRemaining(row.maxUses, row.usedCount),
    enabled: row.enabled,
    planKeys: plansByCoupon.get(row.id) || [],
    discountPaidCents: couponDiscount.get(row.id) || 0,
  }));

  return {
    orders: orderCounts,
    cdks: cdkCounts,
    localAccountSold,
    coupons,
    byPlan: [...byPlan.values()].sort((a, b) => b.placed - a.placed || a.planKey.localeCompare(b.planKey)),
    byAgent: [...byAgent.values()].sort(
      (a, b) => b.unusedBacklog - a.unusedBacklog || b.paid - a.paid,
    ),
  };
}
