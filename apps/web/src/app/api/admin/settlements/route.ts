import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agents,
  agentSettlements,
  users,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { requireAdmin } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { bootDb } from "@/lib/config";
import { newOrderNo } from "@/lib/ids";
import { verifyLedger } from "@/lib/order-ledger-core";
import { periodBoundary } from "@/lib/period";

const createSchema = z.object({
  agentId: z.number().int().positive(),
  periodStart: z.string().trim().min(10).max(40),
  periodEnd: z.string().trim().min(10).max(40),
  notes: z.string().trim().max(500).optional().default(""),
});

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db
    .select({
      id: agentSettlements.id,
      settlementNo: agentSettlements.settlementNo,
      agentId: agentSettlements.agentId,
      agentName: agents.displayName,
      realName: agents.realName,
      shopName: agents.shopName,
      settlementName: agents.settlementName,
      settlementMethod: agents.settlementMethod,
      settlementAccountEncrypted: agents.settlementAccountEncrypted,
      username: users.username,
      periodStart: agentSettlements.periodStart,
      periodEnd: agentSettlements.periodEnd,
      amountCents: agentSettlements.amountCents,
      status: agentSettlements.status,
      paymentMethod: agentSettlements.paymentMethod,
      paymentReference: agentSettlements.paymentReference,
      createdAt: agentSettlements.createdAt,
      paidAt: agentSettlements.paidAt,
    })
    .from(agentSettlements)
    .innerJoin(agents, eq(agents.id, agentSettlements.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .orderBy(desc(agentSettlements.id))
    .limit(200);
  return NextResponse.json({
    list: list.map((row) => {
      let settlementAccount = "";
      if (row.settlementAccountEncrypted) {
        try {
          settlementAccount = decryptSecret(row.settlementAccountEncrypted);
        } catch {
          settlementAccount = "";
        }
      }
      return {
        id: row.id,
        settlementNo: row.settlementNo,
        agentId: row.agentId,
        agentName: agentIdentityLabel({
          agentId: row.agentId,
          displayName: row.agentName,
          realName: row.realName,
          shopName: row.shopName,
          settlementName: row.settlementName,
          username: row.username,
        }),
        settlementPayee: row.settlementName,
        settlementMethod: row.settlementMethod,
        settlementAccount,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        amountCents: row.amountCents,
        status: row.status,
        paymentMethod: row.paymentMethod,
        paymentReference: row.paymentReference,
        createdAt: row.createdAt,
        paidAt: row.paidAt,
      };
    }),
  });
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  let periodStart: string;
  let periodEnd: string;
  try {
    periodStart = periodBoundary(data.periodStart, false);
    periodEnd = periodBoundary(data.periodEnd, true);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算周期格式无效" },
      { status: 400 },
    );
  }
  if (periodStart > periodEnd) {
    return NextResponse.json({ error: "结算开始时间不能晚于结束时间" }, { status: 400 });
  }

  try {
  const result = await db.transaction(async (tx) => {
    const earningRows = await tx
      .select({
        id: agentEarnings.id,
        earningCents: agentEarnings.earningCents,
        rowGrossCents: agentEarnings.grossCents,
        rowCostCents: agentEarnings.costCents,
        rowAgentFeeCents: agentEarnings.agentFeeCents,
        orderNo: storeOrders.orderNo,
        grossCents: storeOrders.grossCents,
        invoiceSurchargeCents: storeOrders.invoiceSurchargeCents,
        agentCostTotalCents: storeOrders.agentCostTotalCents,
        upstreamCostTotalCents: storeOrders.upstreamCostTotalCents,
        feeRatePpm: storeOrders.feeRatePpm,
        fixedFeeCents: storeOrders.fixedFeeCents,
        finalPaymentFeeCents: storeOrders.finalPaymentFeeCents,
        agentFeeCents: storeOrders.agentFeeCents,
        platformFeeCents: storeOrders.platformFeeCents,
        orderEarningCents: storeOrders.agentEarningCents,
        platformProfitCents: storeOrders.platformProfitCents,
        feeReconcileStatus: storeOrders.feeReconcileStatus,
      })
      .from(agentEarnings)
      .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
      .where(
        and(
          eq(agentEarnings.agentId, data.agentId),
          eq(agentEarnings.status, "pending"),
          isNull(agentEarnings.settlementId),
          gte(agentEarnings.confirmedAt, periodStart),
          lte(agentEarnings.confirmedAt, periodEnd),
          eq(storeOrders.payStatus, "paid"),
          eq(storeOrders.fulfillStatus, "delivered"),
        ),
      );
    const adjustmentRows = await tx
      .select({
        id: agentEarningAdjustments.id,
        amountCents: agentEarningAdjustments.amountCents,
      })
      .from(agentEarningAdjustments)
      .where(
        and(
          eq(agentEarningAdjustments.agentId, data.agentId),
          eq(agentEarningAdjustments.status, "pending"),
          isNull(agentEarningAdjustments.settlementId),
          lte(agentEarningAdjustments.createdAt, periodEnd),
        ),
      );
    const skippedManualReview = earningRows
      .filter((row) => row.feeReconcileStatus === "manual_review")
      .map((row) => row.orderNo);
    const settlingRows = earningRows.filter(
      (row) => row.feeReconcileStatus !== "manual_review",
    );
    const mismatches: string[] = [];
    for (const row of settlingRows) {
      const issues = verifyLedger(
        {
          grossCents: row.grossCents,
          invoiceSurchargeCents: row.invoiceSurchargeCents,
          agentCostTotalCents: row.agentCostTotalCents,
          upstreamCostTotalCents: row.upstreamCostTotalCents,
          feeRatePpm: row.feeRatePpm,
          fixedFeeCents: row.fixedFeeCents,
          finalPaymentFeeCents: row.finalPaymentFeeCents,
          agentFeeCents: row.agentFeeCents,
          platformFeeCents: row.platformFeeCents,
          agentEarningCents: row.orderEarningCents,
          platformProfitCents: row.platformProfitCents,
        },
        {
          grossCents: row.rowGrossCents,
          costCents: row.rowCostCents,
          agentFeeCents: row.rowAgentFeeCents,
          earningCents: row.earningCents,
        },
      );
      if (issues.length) {
        mismatches.push(
          `${row.orderNo}（${issues.map((item) => item.code).join("、")}）`,
        );
      }
    }
    if (mismatches.length) {
      throw new Error(
        `收益和订单快照对不上，已拒绝生成：${mismatches.join("；")}`,
      );
    }
    if (!settlingRows.length && !adjustmentRows.length) {
      if (skippedManualReview.length) {
        throw new Error(
          `有 ${skippedManualReview.length} 笔手续费待人工核对，不能生成结算单：${skippedManualReview.join("、")}`,
        );
      }
      const deliveredOrders = await tx
        .select({ id: storeOrders.id })
        .from(storeOrders)
        .where(
          and(
            eq(storeOrders.agentId, data.agentId),
            eq(storeOrders.payStatus, "paid"),
            eq(storeOrders.fulfillStatus, "delivered"),
          ),
        );
      if (deliveredOrders.length) {
        throw new Error(
          `该代理已有 ${deliveredOrders.length} 笔已发卡订单，但不在所选周期的待结算收益里。请把结算日期覆盖到付款当天，或确认收益还没被别的结算单占用。`,
        );
      }
      throw new Error(
        "该时间范围没有待结算收益。只有已支付且已发卡的订单才会进入结算单。",
      );
    }
    const amountCents =
      settlingRows.reduce((sum, row) => sum + row.earningCents, 0) +
      adjustmentRows.reduce((sum, row) => sum + row.amountCents, 0);
    if (amountCents <= 0) {
      throw new Error(
        `待结算净收益为 ${(amountCents / 100).toFixed(2)} 元。退款倒扣已结转到后续周期，请等有正收益后再生成结算单`,
      );
    }
    const now = new Date().toISOString();
    const [settlement] = await tx
      .insert(agentSettlements)
      .values({
        settlementNo: newOrderNo("ST"),
        agentId: data.agentId,
        periodStart,
        periodEnd,
        amountCents,
        itemCount: settlingRows.length,
        status: "pending_payment",
        notes: data.notes,
        createdBy: session.id,
        createdAt: now,
      })
      .returning();
    if (!settlement) throw new Error("结算单创建失败");
    if (settlingRows.length) {
      const claimedEarnings = await tx
        .update(agentEarnings)
        .set({
          settlementId: settlement.id,
          status: "settling",
          updatedAt: now,
        })
        .where(
          and(
            inArray(agentEarnings.id, settlingRows.map((row) => row.id)),
            eq(agentEarnings.status, "pending"),
            isNull(agentEarnings.settlementId),
          ),
        )
        .returning({ id: agentEarnings.id });
      if (claimedEarnings.length !== settlingRows.length) {
        throw new Error("部分收益状态已变化，请刷新后重试");
      }
    }
    if (adjustmentRows.length) {
      const claimedAdjustments = await tx
        .update(agentEarningAdjustments)
        .set({
          settlementId: settlement.id,
          status: "settling",
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              agentEarningAdjustments.id,
              adjustmentRows.map((row) => row.id),
            ),
            eq(agentEarningAdjustments.status, "pending"),
            isNull(agentEarningAdjustments.settlementId),
          ),
        )
        .returning({ id: agentEarningAdjustments.id });
      if (claimedAdjustments.length !== adjustmentRows.length) {
        throw new Error("部分账务调整状态已变化，请刷新后重试");
      }
    }
    return { settlement, skippedManualReview };
  });
  await writeAuditLog({
    actor: session,
    action: "admin.settlement.create",
    targetType: "agent_settlement",
    targetId: result.settlement.id,
    metadata: {
      agentId: data.agentId,
      periodStart,
      periodEnd,
      amountCents: result.settlement.amountCents,
    },
  });
  return NextResponse.json({
    settlement: result.settlement,
    skippedManualReview: result.skippedManualReview,
  });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算单创建失败" },
      { status: 409 },
    );
  }
}
