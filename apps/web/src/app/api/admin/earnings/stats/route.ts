import { NextResponse } from "next/server";
import { and, eq, gte, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  agentDrawItems,
  agentEarningAdjustments,
  agentEarnings,
  agents,
  storeOrders,
  users,
} from "@/db/schema";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  beijingDateRangeIso,
  buildDrawStats,
  buildEarningsStats,
  buildOrderPipeline,
  buildPeriodRows,
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
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      username: users.username,
      confirmedAt: agentEarnings.confirmedAt,
      grossCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      paymentFeeCents: agentEarnings.paymentFeeCents,
      totalFeeCents: agentEarnings.totalFeeCents,
      upstreamCents: storeOrders.upstreamCostTotalCents,
      platformFeeCents: storeOrders.platformFeeCents,
      platformProfitCents: storeOrders.platformProfitCents,
      invoiceSurchargeCents: storeOrders.invoiceSurchargeCents,
      invoiceShareCents: agentEarnings.invoiceShareCents,
      payStatus: storeOrders.payStatus,
      upstreamCostSource: storeOrders.upstreamCostSource,
      earningCents: agentEarnings.earningCents,
      status: agentEarnings.status,
      paymentChannel: storeOrders.paymentChannel,
      planName: storeOrders.productNameSnapshot,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
    })
    .from(agentEarnings)
    .innerJoin(agents, eq(agents.id, agentEarnings.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .where(and(...earningWhere));

  const adjustments = await db
    .select({
      agentId: agentEarningAdjustments.agentId,
      agentName: agents.displayName,
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      username: users.username,
      createdAt: agentEarningAdjustments.createdAt,
      amountCents: agentEarningAdjustments.amountCents,
      status: agentEarningAdjustments.status,
    })
    .from(agentEarningAdjustments)
    .innerJoin(agents, eq(agents.id, agentEarningAdjustments.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .where(and(...adjustmentWhere));

  const identity = (row: {
    agentId: number;
    agentName: string;
    realName: string;
    shopName: string;
    settlementName: string;
    username: string | null;
  }) =>
    agentIdentityLabel({
      agentId: row.agentId,
      displayName: row.agentName,
      realName: row.realName,
      shopName: row.shopName,
      settlementName: row.settlementName,
      username: row.username,
    });

  const stats = buildEarningsStats({
    grain,
    earnings: earnings.map((row) => ({
      ...row,
      agentName: identity(row),
    })),
    adjustments: adjustments.map((row) => ({
      ...row,
      agentName: identity(row),
    })),
  });

  // 代理自助提卡：按出卡时间算，作废的在汇总里剔掉。
  const drawWhere = [
    gte(agentDrawItems.createdAt, range.start),
    lte(agentDrawItems.createdAt, range.end),
  ];
  if (agentId > 0) drawWhere.push(eq(agentDrawItems.agentId, agentId));
  const drawRows = await db
    .select({
      agentId: agentDrawItems.agentId,
      agentName: agents.displayName,
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      username: users.username,
      createdAt: agentDrawItems.createdAt,
      amountCents: agentDrawItems.amountCents,
      upstreamCostCents: agentDrawItems.upstreamCostCents,
      status: agentDrawItems.status,
    })
    .from(agentDrawItems)
    .innerJoin(agents, eq(agents.id, agentDrawItems.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .where(and(...drawWhere));
  const draw = buildDrawStats({
    grain,
    draws: drawRows.map((row) => ({ ...row, agentName: identity(row) })),
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
    draw,
    periods: buildPeriodRows({
      grain,
      startYmd,
      endYmd,
      store: stats.series,
      draw: draw.series,
    }),
    pipeline: buildOrderPipeline(orders),
  });
}
