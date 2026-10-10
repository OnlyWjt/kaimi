import { NextResponse } from "next/server";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agents,
  agentSettlements,
  storeOrders,
} from "@/db/schema";
import { beijingPeriodBounds } from "@/lib/agent-console-core";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { buildEarningsWorkbook } from "@/lib/earnings-export";
import { buildEarningsTotals, issuedCdkSummaryLabel } from "@/lib/earnings-rows";
import { issuedCdkCountsFor } from "@/lib/earnings-sql";

/** 北京时间今天的 YYYY-MM-DD，作为未传 end 时的默认结束日（整天都算）。 */
function beijingToday() {
  return beijingDate(new Date().toISOString());
}

/** ISO 时间点 → 北京日期 YYYY-MM-DD（汇总页按日期展示；纯日期串导出时原样落格）。 */
function beijingDate(iso: string) {
  return new Date(Date.parse(iso) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

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
  let start: string;
  let end: string;
  try {
    // 与 /api/agent/ledger/period 同一口径：北京时间左闭右开 [start, end)。
    ({ start, end } = beijingPeriodBounds(
      query.get("start")?.trim() || "1970-01-01",
      query.get("end")?.trim() || beijingToday(),
    ));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "时间范围格式无效" },
      { status: 400 },
    );
  }
  const conditions = [
    eq(agentEarnings.agentId, session.agentId),
    gte(agentEarnings.confirmedAt, start),
    lt(agentEarnings.confirmedAt, end),
  ];

  const rows = await db
    .select({
      confirmedAt: agentEarnings.confirmedAt,
      orderNo: storeOrders.orderNo,
      agentName: agents.displayName,
      planName: storeOrders.productNameSnapshot,
      paymentChannel: storeOrders.paymentChannel,
      grossCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      estimatedFeeCents: storeOrders.estimatedPaymentFeeCents,
      actualFeeCents: storeOrders.actualPaymentFeeCents,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      finalFeeCents: agentEarnings.paymentFeeCents,
      earningCents: agentEarnings.earningCents,
      earningStatus: agentEarnings.status,
      ...issuedCdkCountsFor(storeOrders.id),
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .innerJoin(agents, eq(agents.id, agentEarnings.agentId))
    .where(and(...conditions))
    .orderBy(asc(agentEarnings.confirmedAt))
    .limit(50_001);
  if (rows.length > 50_000) {
    return NextResponse.json(
      { error: "导出记录超过 50,000 条，请缩小时间范围" },
      { status: 400 },
    );
  }
  const settlements = await db.query.agentSettlements.findMany({
    where: and(
      eq(agentSettlements.agentId, session.agentId),
      gte(agentSettlements.createdAt, start),
      lt(agentSettlements.createdAt, end),
    ),
    orderBy: [asc(agentSettlements.createdAt)],
  });
  const adjustments = await db
    .select({
      createdAt: agentEarningAdjustments.createdAt,
      orderNo: storeOrders.orderNo,
      agentName: agents.displayName,
      type: agentEarningAdjustments.type,
      amountCents: agentEarningAdjustments.amountCents,
      reason: agentEarningAdjustments.reason,
      reference: agentEarningAdjustments.reference,
      status: agentEarningAdjustments.status,
      settlementNo: agentSettlements.settlementNo,
    })
    .from(agentEarningAdjustments)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarningAdjustments.orderId))
    .innerJoin(agents, eq(agents.id, agentEarningAdjustments.agentId))
    .leftJoin(
      agentSettlements,
      eq(agentSettlements.id, agentEarningAdjustments.settlementId),
    )
    .where(
      and(
        eq(agentEarningAdjustments.agentId, session.agentId),
        gte(agentEarningAdjustments.createdAt, start),
        lt(agentEarningAdjustments.createdAt, end),
      ),
    )
    .orderBy(asc(agentEarningAdjustments.createdAt));
  const profile = await db.query.agents.findFirst({
    where: eq(agents.id, session.agentId),
  });
  const buffer = await buildEarningsWorkbook({
    summary: {
      periodStart: beijingDate(start),
      // end 是开区间（次日 0 点），展示最后一个被包含的北京日期。
      periodEnd: beijingDate(new Date(Date.parse(end) - 1).toISOString()),
      agentName: profile?.displayName || session.username,
      ...buildEarningsTotals(rows, adjustments),
    },
    details: rows.map((row) => ({
      ...row,
      actualFeeCents: row.actualFeeCents,
      settlementNo: "",
      cdkStatus: issuedCdkSummaryLabel(row.cdkTotal, row.cdkUsed),
    })),
    settlements: settlements.map((row) => ({
      settlementNo: row.settlementNo,
      agentName: profile?.displayName || session.username,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      amountCents: row.amountCents,
      paymentMethod: row.paymentMethod,
      paymentReference: row.paymentReference,
      status: row.status,
      settledAt: row.paidAt || "",
    })),
    adjustments: adjustments.map((row) => ({
      ...row,
      settlementNo: row.settlementNo || "",
    })),
  });
  await writeAuditLog({
    actor: session,
    action: "agent.earnings.export",
    targetType: "agent",
    targetId: session.agentId,
    metadata: { start, end, rows: rows.length },
  });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="kaimi-earnings-${session.agentId}-${date}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
