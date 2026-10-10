import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEarnings, storeOrders } from "@/db/schema";
import { beijingPeriodBounds } from "@/lib/agent-console-core";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { newRequestId, reconciliationData, reconciliationFail } from "@/lib/reconciliation-http";
import { ReconciliationError } from "@/lib/reconciliation";

/** 期间统计和累计未结分开。这里的日期不影响对账净额。 */
export async function GET(req: Request) {
  const requestId = newRequestId();
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    return reconciliationFail(error, requestId);
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  let start: string;
  let end: string;
  try {
    // 左闭右开 [start, end)；纯日期按北京时间切日，end 日整天都算（取次日 0 点，不含）。
    ({ start, end } = beijingPeriodBounds(query.get("start") || "", query.get("end") || ""));
  } catch (error) {
    return reconciliationFail(
      new ReconciliationError("INVALID_STATE", error instanceof Error ? error.message : "时间范围无效", 422),
      requestId,
    );
  }
  const cursor = Math.max(0, Number(query.get("cursor") || 0));
  const limit = Math.max(1, Math.min(100, Number(query.get("limit") || 20)));
  const where = and(
    eq(agentEarnings.agentId, session.agentId),
    gte(agentEarnings.confirmedAt, start),
    lt(agentEarnings.confirmedAt, end),
  );
  const [summary] = await db
    .select({
      orderCount: sql<number>`count(*)`,
      grossCents: sql<number>`coalesce(sum(${agentEarnings.grossCents}), 0)`,
      totalFeeCents: sql<number>`coalesce(sum(case when ${agentEarnings.feeFieldsVersion} = 0 then ${agentEarnings.paymentFeeCents} else ${agentEarnings.totalFeeCents} end), 0)`,
      agentFeeCents: sql<number>`coalesce(sum(case when ${agentEarnings.feeFieldsVersion} = 0 then ${agentEarnings.paymentFeeCents} else ${agentEarnings.agentFeeCents} end), 0)`,
      // 已退款冲回（reversed）的收益不算进收益合计，单独列 reversedCents。
      earningCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} != 'reversed' then ${agentEarnings.earningCents} else 0 end), 0)`,
      reversedCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} = 'reversed' then ${agentEarnings.earningCents} else 0 end), 0)`,
      reversedCount: sql<number>`coalesce(sum(case when ${agentEarnings.status} = 'reversed' then 1 else 0 end), 0)`,
      pendingCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} in ('pending', 'settling') then ${agentEarnings.earningCents} else 0 end), 0)`,
    })
    .from(agentEarnings)
    .where(where);
  const list = await db
    .select({
      id: agentEarnings.id,
      confirmedAt: agentEarnings.confirmedAt,
      orderNo: storeOrders.orderNo,
      productName: storeOrders.productNameSnapshot,
      grossCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      agentCostCents: agentEarnings.costCents,
      totalFeeCents: sql<number>`case when ${agentEarnings.feeFieldsVersion} = 0 then ${agentEarnings.paymentFeeCents} else ${agentEarnings.totalFeeCents} end`,
      agentFeeCents: sql<number>`case when ${agentEarnings.feeFieldsVersion} = 0 then ${agentEarnings.paymentFeeCents} else ${agentEarnings.agentFeeCents} end`,
      // Detail preserves the stored legacy column; it is not a totalFeeCents alias.
      paymentFeeCents: agentEarnings.paymentFeeCents,
      earningCents: agentEarnings.earningCents,
      earningStatus: agentEarnings.status,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      listGoodsCents: storeOrders.listGoodsCents,
      couponDiscountCents: storeOrders.couponDiscountCents,
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .where(where)
    .orderBy(desc(agentEarnings.confirmedAt))
    .offset(cursor)
    .limit(limit + 1);
  return reconciliationData(
    {
      start,
      end,
      summary: {
        orderCount: Number(summary?.orderCount || 0),
        grossCents: Number(summary?.grossCents || 0),
        totalFeeCents: Number(summary?.totalFeeCents || 0),
        agentFeeCents: Number(summary?.agentFeeCents || 0),
        // Compatibility alias: historically this endpoint exposed the agent fee here.
        paymentFeeCents: Number(summary?.agentFeeCents || 0),
        earningCents: Number(summary?.earningCents || 0),
        reversedCents: Number(summary?.reversedCents || 0),
        reversedCount: Number(summary?.reversedCount || 0),
        pendingCents: Number(summary?.pendingCents || 0),
      },
      list: list.slice(0, limit),
      nextCursor: list.length > limit ? cursor + limit : null,
    },
    requestId,
  );
}
