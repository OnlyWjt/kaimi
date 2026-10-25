import { NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  agentDrawItems,
  agentDrawOrders,
  agentEarningAdjustments,
  agentEarnings,
  agents,
  agentSettlements,
  storeOrders,
  users,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { buildEarningsWorkbook } from "@/lib/earnings-export";
import { buildEarningsTotals, issuedCdkSummaryLabel } from "@/lib/earnings-rows";
import { issuedCdkCountsFor } from "@/lib/earnings-sql";
import { periodBoundary } from "@/lib/period";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { beijingDateRangeIso, buildDrawStats, buildEarningsStats } from "@/lib/earnings-stats-core";

export async function GET(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  let start: string;
  let end: string;
  const startYmd = query.get("start")?.trim() || "1970-01-01";
  const endYmd = query.get("end")?.trim() || new Date().toISOString().slice(0, 10);
  try {
    // 页面传的是北京日期：按北京时间切天，和收益统计页的数对得上。传完整时间点的老调用照旧。
    if (/^\d{4}-\d{2}-\d{2}$/.test(startYmd) && /^\d{4}-\d{2}-\d{2}$/.test(endYmd)) {
      ({ start, end } = beijingDateRangeIso(startYmd, endYmd));
    } else {
      start = periodBoundary(startYmd, false);
      end = periodBoundary(endYmd, true);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "时间范围格式无效" },
      { status: 400 },
    );
  }
  const agentId = Number(query.get("agentId") || 0);
  const earningConditions = [
    gte(agentEarnings.confirmedAt, start),
    lte(agentEarnings.confirmedAt, end),
  ];
  if (Number.isSafeInteger(agentId) && agentId > 0) {
    earningConditions.push(eq(agentEarnings.agentId, agentId));
  }

  const rows = await db
    .select({
      confirmedAt: agentEarnings.confirmedAt,
      orderNo: storeOrders.orderNo,
      agentId: agents.id,
      agentName: agents.displayName,
      username: users.username,
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      settlementMethod: agents.settlementMethod,
      settlementAccountEncrypted: agents.settlementAccountEncrypted,
      planName: storeOrders.productNameSnapshot,
      paymentChannel: storeOrders.paymentChannel,
      grossCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      invoiceShareCents: agentEarnings.invoiceShareCents,
      upstreamCostCents: storeOrders.upstreamCostTotalCents,
      platformFeeCents: storeOrders.platformFeeCents,
      platformProfitCents: storeOrders.platformProfitCents,
      estimatedFeeCents: storeOrders.estimatedPaymentFeeCents,
      actualFeeCents: storeOrders.actualPaymentFeeCents,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      finalFeeCents: agentEarnings.totalFeeCents,
      earningCents: agentEarnings.earningCents,
      earningStatus: agentEarnings.status,
      payStatus: storeOrders.payStatus,
      upstreamCostSource: storeOrders.upstreamCostSource,
      ...issuedCdkCountsFor(storeOrders.id),
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .innerJoin(agents, eq(agents.id, agentEarnings.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .where(and(...earningConditions))
    .orderBy(asc(agentEarnings.confirmedAt))
    .limit(50_001);
  if (rows.length > 50_000) {
    return NextResponse.json(
      { error: "导出记录超过 50,000 条，请缩小时间范围" },
      { status: 400 },
    );
  }

  const settlementConditions = [
    gte(agentSettlements.createdAt, start),
    lte(agentSettlements.createdAt, end),
  ];
  if (Number.isSafeInteger(agentId) && agentId > 0) {
    settlementConditions.push(eq(agentSettlements.agentId, agentId));
  }
  const settlements = await db
    .select({
      settlementNo: agentSettlements.settlementNo,
      agentName: agents.displayName,
      periodStart: agentSettlements.periodStart,
      periodEnd: agentSettlements.periodEnd,
      amountCents: agentSettlements.amountCents,
      paymentMethod: agentSettlements.paymentMethod,
      paymentReference: agentSettlements.paymentReference,
      status: agentSettlements.status,
      paidAt: agentSettlements.paidAt,
    })
    .from(agentSettlements)
    .innerJoin(agents, eq(agents.id, agentSettlements.agentId))
    .where(and(...settlementConditions))
    .orderBy(asc(agentSettlements.createdAt));

  const adjustmentConditions = [
    gte(agentEarningAdjustments.createdAt, start),
    lte(agentEarningAdjustments.createdAt, end),
  ];
  if (Number.isSafeInteger(agentId) && agentId > 0) {
    adjustmentConditions.push(eq(agentEarningAdjustments.agentId, agentId));
  }
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
    .where(and(...adjustmentConditions))
    .orderBy(asc(agentEarningAdjustments.createdAt));

  // 平台收益：店铺毛利和收益统计页同一套算法；提卡按出卡时间算
  const drawConditions = [gte(agentDrawItems.createdAt, start), lte(agentDrawItems.createdAt, end)];
  if (Number.isSafeInteger(agentId) && agentId > 0) drawConditions.push(eq(agentDrawItems.agentId, agentId));
  const drawRows = await db
    .select({
      createdAt: agentDrawItems.createdAt,
      drawNo: agentDrawOrders.drawNo,
      planName: agentDrawOrders.planNameSnapshot,
      agentId: agents.id,
      displayName: agents.displayName,
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      username: users.username,
      amountCents: agentDrawItems.amountCents,
      upstreamCostCents: agentDrawItems.upstreamCostCents,
      status: agentDrawItems.status,
      voidReason: agentDrawItems.voidReason,
    })
    .from(agentDrawItems)
    .innerJoin(agentDrawOrders, eq(agentDrawOrders.id, agentDrawItems.drawOrderId))
    .innerJoin(agents, eq(agents.id, agentDrawItems.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .where(and(...drawConditions))
    .orderBy(asc(agentDrawItems.createdAt))
    .limit(50_001);
  if (drawRows.length > 50_000) {
    return NextResponse.json({ error: "提卡明细超过 50,000 条，请缩小时间范围" }, { status: 400 });
  }
  const storeStats = buildEarningsStats({
    grain: "day",
    earnings: rows.map((row) => ({
      ...row,
      agentName: row.agentName,
      paymentFeeCents: row.finalFeeCents,
      upstreamCents: row.upstreamCostCents,
      status: row.earningStatus,
    })),
    adjustments: [],
  }).totals;
  const drawStats = buildDrawStats({
    grain: "day",
    draws: drawRows.map((row) => ({ ...row, agentName: row.displayName })),
  }).totals;

  const scopeName =
    Number.isSafeInteger(agentId) && agentId > 0
      ? rows[0]?.agentName || `代理 ${agentId}`
      : "全部代理";
  const buffer = await buildEarningsWorkbook({
    summary: {
      periodStart: startYmd,
      periodEnd: endYmd,
      agentName: scopeName,
      ...buildEarningsTotals(rows, adjustments),
    },
    details: rows.map((row) => {
      let settlementAccount = "";
      if (row.settlementAccountEncrypted) {
        try {
          settlementAccount = decryptSecret(row.settlementAccountEncrypted);
        } catch {
          settlementAccount = "";
        }
      }
      return {
        ...row,
        username: row.username || "",
        settlementAccount,
        settlementNo: "",
        cdkStatus: issuedCdkSummaryLabel(row.cdkTotal, row.cdkUsed),
      };
    }),
    includeAdminIdentity: true,
    platform: {
      storeProfitCents: storeStats.profitCents,
      storeProfitUnknownCount: storeStats.profitUnknownCount,
      drawItemCount: drawStats.itemCount,
      drawAmountCents: drawStats.amountCents,
      drawUpstreamCents: drawStats.upstreamCents,
      drawProfitCents: drawStats.profitCents,
      drawProfitUnknownCount: drawStats.profitUnknownCount,
      drawUnsettledCents: drawStats.unsettledCents,
      drawSettledCents: drawStats.settledCents,
      drawVoidCount: drawStats.voidCount,
    },
    drawItems: drawRows.map((row) => ({
      createdAt: row.createdAt,
      drawNo: row.drawNo,
      agentName: agentIdentityLabel(row),
      planName: row.planName,
      amountCents: row.amountCents,
      upstreamCostCents: row.upstreamCostCents,
      status: row.status,
      voidReason: row.voidReason,
    })),
    settlements: settlements.map((row) => ({
      ...row,
      settledAt: row.paidAt || "",
    })),
    adjustments: adjustments.map((row) => ({
      ...row,
      settlementNo: row.settlementNo || "",
    })),
  });
  await writeAuditLog({
    actor: session,
    action: "admin.earnings.export",
    targetType: agentId > 0 ? "agent" : "all_agents",
    targetId: agentId > 0 ? agentId : "",
    metadata: { start, end, rows: rows.length, drawItems: drawRows.length },
  });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="kaimi-earnings-admin-${date}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
