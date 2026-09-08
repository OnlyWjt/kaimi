import { NextResponse } from "next/server";
import { and, eq, gte, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agents,
  storeOrders,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  beijingDateRangeIso,
  buildEarningsStats,
  buildOrderPipeline,
  parseStatsGrain,
} from "@/lib/earnings-stats-core";

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();

  const query = new URL(req.url).searchParams;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const startYmd = query.get("start")?.trim() || today;
  const endYmd = query.get("end")?.trim() || today;
  const grain = parseStatsGrain(query.get("grain"));
  const agentId = Number(query.get("agentId") || 0);

  let range;
  try {
    range = beijingDateRangeIso(startYmd, endYmd);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "时间范围格式无效" },
      { status: 400 },
    );
  }

  const earningWhere = [
    gte(agentEarnings.confirmedAt, range.start),
    lte(agentEarnings.confirmedAt, range.end),
  ];
  const adjustmentWhere = [
    gte(agentEarningAdjustments.createdAt, range.start),
    lte(agentEarningAdjustments.createdAt, range.end),
  ];
  if (agentId > 0) {
    earningWhere.push(eq(agentEarnings.agentId, agentId));
    adjustmentWhere.push(eq(agentEarningAdjustments.agentId, agentId));
  }

  const earnings = await db
    .select({
      agentId: agentEarnings.agentId,
      agentName: agents.displayName,
      confirmedAt: agentEarnings.confirmedAt,
      grossCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      paymentFeeCents: agentEarnings.paymentFeeCents,
      earningCents: agentEarnings.earningCents,
      status: agentEarnings.status,
      paymentChannel: storeOrders.paymentChannel,
      planName: storeOrders.productNameSnapshot,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
    })
    .from(agentEarnings)
    .innerJoin(agents, eq(agents.id, agentEarnings.agentId))
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .where(and(...earningWhere));

  const adjustments = await db
    .select({
      agentId: agentEarningAdjustments.agentId,
      agentName: agents.displayName,
      createdAt: agentEarningAdjustments.createdAt,
      amountCents: agentEarningAdjustments.amountCents,
      status: agentEarningAdjustments.status,
    })
    .from(agentEarningAdjustments)
    .innerJoin(agents, eq(agents.id, agentEarningAdjustments.agentId))
    .where(and(...adjustmentWhere));

  const stats = buildEarningsStats({
    grain,
    earnings: earnings.map((row) => ({
      ...row,
      agentName: row.agentName || `代理 ${row.agentId}`,
    })),
    adjustments: adjustments.map((row) => ({
      ...row,
      agentName: row.agentName || `代理 ${row.agentId}`,
    })),
  });

  const orderWhere = [
    or(
      and(gte(storeOrders.createdAt, range.start), lte(storeOrders.createdAt, range.end)),
      and(gte(storeOrders.paidAt, range.start), lte(storeOrders.paidAt, range.end)),
    ),
  ];
  if (agentId > 0) orderWhere.push(eq(storeOrders.agentId, agentId));

  const orders = await db
    .select({
      payStatus: storeOrders.payStatus,
      fulfillStatus: storeOrders.fulfillStatus,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      grossCents: storeOrders.grossCents,
    })
    .from(storeOrders)
    .where(and(...orderWhere));

  return NextResponse.json({
    range: { start: startYmd, end: endYmd, grain },
    ...stats,
    pipeline: buildOrderPipeline(orders),
  });
}
