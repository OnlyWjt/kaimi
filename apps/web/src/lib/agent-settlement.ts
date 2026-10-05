import { and, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agentSettlements,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import type { AuthSession } from "@/lib/auth";
import { newOrderNo } from "@/lib/ids";
import { verifyLedger } from "@/lib/order-ledger-core";

export type CreateSettlementInput = {
  agentId: number;
  periodStart: string;
  periodEnd: string;
  notes?: string;
  createdBy: number;
  /** 自动周结时，对不上或待核对的订单留在待结算，不挡其余订单。 */
  lenient?: boolean;
  actor?: Pick<AuthSession, "id" | "role"> | null;
};

export type CreateSettlementResult = {
  settlement: typeof agentSettlements.$inferSelect | null;
  skippedManualReview: string[];
  skippedMismatch: string[];
  reason?: string;
};

export async function createAgentSettlement(input: CreateSettlementInput): Promise<CreateSettlementResult> {
  const notes = input.notes?.trim() || "";
  const existing = await db.query.agentSettlements.findFirst({
    where: and(
      eq(agentSettlements.agentId, input.agentId),
      eq(agentSettlements.periodStart, input.periodStart),
      eq(agentSettlements.periodEnd, input.periodEnd),
      ne(agentSettlements.status, "cancelled"),
    ),
  });
  if (existing) {
    return {
      settlement: existing,
      skippedManualReview: [],
      skippedMismatch: [],
      reason: "already",
    };
  }

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
          eq(agentEarnings.agentId, input.agentId),
          eq(agentEarnings.status, "pending"),
          isNull(agentEarnings.settlementId),
          gte(agentEarnings.confirmedAt, input.periodStart),
          lte(agentEarnings.confirmedAt, input.periodEnd),
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
          eq(agentEarningAdjustments.agentId, input.agentId),
          eq(agentEarningAdjustments.status, "pending"),
          isNull(agentEarningAdjustments.settlementId),
          lte(agentEarningAdjustments.createdAt, input.periodEnd),
        ),
      );
    const skippedManualReview = earningRows
      .filter((row) => row.feeReconcileStatus === "manual_review")
      .map((row) => row.orderNo);
    const candidates = earningRows.filter((row) => row.feeReconcileStatus !== "manual_review");
    const skippedMismatch: string[] = [];
    const settlingRows = [];
    for (const row of candidates) {
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
        skippedMismatch.push(`${row.orderNo}（${issues.map((item) => item.code).join("、")}）`);
        if (!input.lenient) continue;
        continue;
      }
      settlingRows.push(row);
    }
    if (!input.lenient && skippedMismatch.length) {
      throw new Error(`收益和订单快照对不上，已拒绝生成：${skippedMismatch.join("；")}`);
    }
    if (!settlingRows.length && !adjustmentRows.length) {
      if (!input.lenient && skippedManualReview.length) {
        throw new Error(
          `有 ${skippedManualReview.length} 笔手续费待人工核对，不能生成结算单：${skippedManualReview.join("、")}`,
        );
      }
      if (!input.lenient) {
        const deliveredOrders = await tx
          .select({ id: storeOrders.id })
          .from(storeOrders)
          .where(
            and(
              eq(storeOrders.agentId, input.agentId),
              eq(storeOrders.payStatus, "paid"),
              eq(storeOrders.fulfillStatus, "delivered"),
            ),
          );
        if (deliveredOrders.length) {
          throw new Error(
            `该代理已有 ${deliveredOrders.length} 笔已发卡订单，但不在所选周期的待结算收益里。请把结算日期覆盖到付款当天，或确认收益还没被别的结算单占用。`,
          );
        }
        throw new Error("该时间范围没有待结算收益。只有已支付且已发卡的订单才会进入结算单。");
      }
      return {
        settlement: null,
        skippedManualReview,
        skippedMismatch,
        reason: "empty",
      };
    }
    const amountCents =
      settlingRows.reduce((sum, row) => sum + row.earningCents, 0) +
      adjustmentRows.reduce((sum, row) => sum + row.amountCents, 0);
    if (amountCents <= 0) {
      if (input.lenient) {
        return {
          settlement: null,
          skippedManualReview,
          skippedMismatch,
          reason: "non_positive",
        };
      }
      throw new Error(
        `待结算净收益为 ${(amountCents / 100).toFixed(2)} 元。退款倒扣已结转到后续周期，请等有正收益后再生成结算单`,
      );
    }
    const now = new Date().toISOString();
    const [settlement] = await tx
      .insert(agentSettlements)
      .values({
        settlementNo: newOrderNo("ST"),
        agentId: input.agentId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amountCents,
        itemCount: settlingRows.length,
        status: "pending_payment",
        notes,
        createdBy: input.createdBy,
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
            inArray(
              agentEarnings.id,
              settlingRows.map((row) => row.id),
            ),
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
    return { settlement, skippedManualReview, skippedMismatch, reason: undefined };
  });

  if (result.settlement && result.reason !== "already") {
    await writeAuditLog({
      actor: input.actor,
      action: input.lenient ? "admin.settlement.week" : "admin.settlement.create",
      targetType: "agent_settlement",
      targetId: result.settlement.id,
      metadata: {
        agentId: input.agentId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amountCents: result.settlement.amountCents,
      },
    });
  }
  return result;
}
