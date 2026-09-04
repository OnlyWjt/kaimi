import { NextResponse } from "next/server";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  storeOrders,
} from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { issuedCdkSummaryLabel } from "@/lib/earnings-rows";
import { issuedCdkCountsFor } from "@/lib/earnings-sql";
import { periodBoundary } from "@/lib/period";

export async function GET(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const startRaw = query.get("start")?.trim();
  const endRaw = query.get("end")?.trim();
  let start: string | undefined;
  let end: string | undefined;
  try {
    start = startRaw ? periodBoundary(startRaw, false) : undefined;
    end = endRaw ? periodBoundary(endRaw, true) : undefined;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "时间范围格式无效" },
      { status: 400 },
    );
  }
  const page = Math.max(1, Number(query.get("page") || 1));
  const pageSize = Math.max(1, Math.min(100, Number(query.get("pageSize") || 20)));
  const conditions = [eq(agentEarnings.agentId, session.agentId)];
  if (start) conditions.push(gte(agentEarnings.confirmedAt, start));
  if (end) conditions.push(lte(agentEarnings.confirmedAt, end));
  const where = and(...conditions);
  const adjustmentConditions = [
    eq(agentEarningAdjustments.agentId, session.agentId),
  ];
  if (start) adjustmentConditions.push(gte(agentEarningAdjustments.createdAt, start));
  if (end) adjustmentConditions.push(lte(agentEarningAdjustments.createdAt, end));

  const [summary] = await db
    .select({
      orderCount: sql<number>`count(*)`,
      grossCents: sql<number>`coalesce(sum(${agentEarnings.grossCents}), 0)`,
      costCents: sql<number>`coalesce(sum(${agentEarnings.costCents}), 0)`,
      paymentFeeCents: sql<number>`coalesce(sum(${agentEarnings.paymentFeeCents}), 0)`,
      earningCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} != 'reversed' then ${agentEarnings.earningCents} else 0 end), 0)`,
      pendingCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} in ('pending', 'settling') then ${agentEarnings.earningCents} else 0 end), 0)`,
      settledCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} = 'settled' then ${agentEarnings.earningCents} else 0 end), 0)`,
      reversedCents: sql<number>`coalesce(sum(case when ${agentEarnings.status} = 'reversed' then ${agentEarnings.earningCents} else 0 end), 0)`,
    })
    .from(agentEarnings)
    .where(where);

  const [adjustmentSummary] = await db
    .select({
      adjustmentCents: sql<number>`coalesce(sum(${agentEarningAdjustments.amountCents}), 0)`,
      pendingCents: sql<number>`coalesce(sum(case when ${agentEarningAdjustments.status} in ('pending', 'settling') then ${agentEarningAdjustments.amountCents} else 0 end), 0)`,
      settledCents: sql<number>`coalesce(sum(case when ${agentEarningAdjustments.status} = 'settled' then ${agentEarningAdjustments.amountCents} else 0 end), 0)`,
    })
    .from(agentEarningAdjustments)
    .where(and(...adjustmentConditions));

  const list = await db
    .select({
      id: agentEarnings.id,
      confirmedAt: agentEarnings.confirmedAt,
      grossCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      paymentFeeCents: agentEarnings.paymentFeeCents,
      feeSource: agentEarnings.feeSource,
      earningCents: agentEarnings.earningCents,
      status: agentEarnings.status,
      orderNo: storeOrders.orderNo,
      productName: storeOrders.productNameSnapshot,
      paymentChannel: storeOrders.paymentChannel,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      ...issuedCdkCountsFor(storeOrders.id),
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .where(where)
    .orderBy(desc(agentEarnings.confirmedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return NextResponse.json({
    summary: {
      orderCount: Number(summary?.orderCount || 0),
      grossCents: Number(summary?.grossCents || 0),
      costCents: Number(summary?.costCents || 0),
      paymentFeeCents: Number(summary?.paymentFeeCents || 0),
      earningCents:
        Number(summary?.earningCents || 0) +
        Number(adjustmentSummary?.adjustmentCents || 0),
      adjustmentCents: Number(adjustmentSummary?.adjustmentCents || 0),
      pendingCents:
        Number(summary?.pendingCents || 0) +
        Number(adjustmentSummary?.pendingCents || 0),
      settledCents:
        Number(summary?.settledCents || 0) +
        Number(adjustmentSummary?.settledCents || 0),
      reversedCents: Number(summary?.reversedCents || 0),
    },
    list: list.map(({ cdkTotal, cdkUsed, ...row }) => ({
      ...row,
      cdkStatus: issuedCdkSummaryLabel(cdkTotal, cdkUsed),
    })),
    page,
    pageSize,
  });
}
