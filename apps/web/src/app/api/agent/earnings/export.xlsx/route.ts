import { NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agents,
  agentSettlements,
  issuedCdks,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { buildEarningsWorkbook } from "@/lib/earnings-export";
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
  let start: string;
  let end: string;
  try {
    start = periodBoundary(
      query.get("start")?.trim() || "1970-01-01",
      false,
    );
    end = periodBoundary(
      query.get("end")?.trim() || new Date().toISOString().slice(0, 10),
      true,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "时间范围格式无效" },
      { status: 400 },
    );
  }
  const conditions = [
    eq(agentEarnings.agentId, session.agentId),
    gte(agentEarnings.confirmedAt, start),
    lte(agentEarnings.confirmedAt, end),
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
      cdkStatus: issuedCdks.status,
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .innerJoin(agents, eq(agents.id, agentEarnings.agentId))
    .leftJoin(issuedCdks, eq(issuedCdks.orderId, storeOrders.id))
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
      lte(agentSettlements.createdAt, end),
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
        lte(agentEarningAdjustments.createdAt, end),
      ),
    )
    .orderBy(asc(agentEarningAdjustments.createdAt));
  const profile = await db.query.agents.findFirst({
    where: eq(agents.id, session.agentId),
  });
  const sum = (pick: (row: (typeof rows)[number]) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const estimatedFeeCents = sum((row) => row.estimatedFeeCents);
  const actualFeeCents = sum((row) => row.actualFeeCents ?? 0);
  const adjustmentCents = adjustments.reduce(
    (total, row) => total + row.amountCents,
    0,
  );
  const buffer = await buildEarningsWorkbook({
    summary: {
      periodStart: start,
      periodEnd: end,
      agentName: profile?.displayName || session.username,
      orderCount: rows.length,
      grossCents: sum((row) => row.grossCents),
      costCents: sum((row) => row.costCents),
      estimatedFeeCents,
      actualFeeCents,
      feeDifferenceCents: sum((row) =>
        row.actualFeeCents === null
          ? 0
          : row.actualFeeCents - row.estimatedFeeCents,
      ),
      earningCents:
        sum((row) =>
          row.earningStatus === "reversed" ? 0 : row.earningCents,
        ) + adjustmentCents,
      pendingCents: sum((row) =>
        ["pending", "settling"].includes(row.earningStatus)
          ? row.earningCents
          : 0,
      ) +
        adjustments
          .filter((row) => ["pending", "settling"].includes(row.status))
          .reduce((total, row) => total + row.amountCents, 0),
      settledCents: sum((row) =>
        row.earningStatus === "settled" ? row.earningCents : 0,
      ) +
        adjustments
          .filter((row) => row.status === "settled")
          .reduce((total, row) => total + row.amountCents, 0),
      reversedCents: sum((row) =>
        row.earningStatus === "reversed" ? row.earningCents : 0,
      ),
      adjustmentCents,
    },
    details: rows.map((row) => ({
      ...row,
      actualFeeCents: row.actualFeeCents,
      settlementNo: "",
      cdkStatus: row.cdkStatus || "",
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
