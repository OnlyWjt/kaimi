import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  issuedCdks,
  storeOrders,
} from "@/db/schema";
import {
  agentRangeYmd,
  type AgentOverviewSnapshot,
} from "@/lib/agent-console-core";
import { bootDb } from "@/lib/config";
import { listAgentCoupons } from "@/lib/coupons";
import { periodBoundary } from "@/lib/period";

export const loadAgentOverview = cache(async (
  agentId: number,
): Promise<AgentOverviewSnapshot> => {
  await bootDb();
  const { start, end } = agentRangeYmd("7d");
  const startIso = periodBoundary(start, false);
  const endIso = periodBoundary(end, true);
  const weekWhere = and(
    eq(agentEarnings.agentId, agentId),
    gte(agentEarnings.confirmedAt, startIso),
    lte(agentEarnings.confirmedAt, endIso),
  );

  const [weekSummary, pendingSummary, pendingAdjust, unusedRow, deals, coupons] =
    await Promise.all([
      db
        .select({
          orderCount: sql<number>`count(*)`,
          grossCents: sql<number>`coalesce(sum(${agentEarnings.grossCents}), 0)`,
        })
        .from(agentEarnings)
        .where(weekWhere)
        .then((rows) => rows[0]),
      db
        .select({
          pendingCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} in ('pending', 'settling') then ${agentEarnings.earningCents} else 0 end), 0)`,
        })
        .from(agentEarnings)
        .where(eq(agentEarnings.agentId, agentId))
        .then((rows) => rows[0]),
      db
        .select({
          pendingCents: sql<number>`coalesce(sum(case when ${agentEarningAdjustments.status} in ('pending', 'settling') then ${agentEarningAdjustments.amountCents} else 0 end), 0)`,
        })
        .from(agentEarningAdjustments)
        .where(eq(agentEarningAdjustments.agentId, agentId))
        .then((rows) => rows[0]),
      db
        .select({
          total: sql<number>`count(*)`,
        })
        .from(issuedCdks)
        .where(and(eq(issuedCdks.agentId, agentId), eq(issuedCdks.status, "unused")))
        .then((rows) => rows[0]),
      db
        .select({
          id: agentEarnings.id,
          orderNo: storeOrders.orderNo,
          productName: storeOrders.productNameSnapshot,
          quantity: storeOrders.quantity,
          couponCode: storeOrders.couponCodeSnapshot,
          grossCents: agentEarnings.grossCents,
        })
        .from(agentEarnings)
        .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
        .where(weekWhere)
        .orderBy(desc(agentEarnings.confirmedAt))
        .limit(5),
      listAgentCoupons(agentId),
    ]);

  const active = coupons.filter((item) => item.enabled);
  const risky = active.find((item) => item.warnings.length);

  return {
    weekGrossCents: Number(weekSummary?.grossCents || 0),
    weekOrderCount: Number(weekSummary?.orderCount || 0),
    pendingCents:
      Number(pendingSummary?.pendingCents || 0) +
      Number(pendingAdjust?.pendingCents || 0),
    unusedBacklog: Number(unusedRow?.total || 0),
    activeCouponCount: active.length,
    riskyCoupon: risky
      ? {
          name: risky.name,
          message: risky.warnings[0]?.message || "用在部分套餐上要复核",
        }
      : null,
    deals: deals.map((row) => ({
      ...row,
      couponCode: row.couponCode || undefined,
    })),
  };
});
