import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agentSettlements,
  agents,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  earningSnapshotFromOrder,
  isGatewayFeeAnomalous,
  recomputeStoredLedger,
  verifyLedger,
} from "@/lib/order-ledger-core";
import { applyAuditCorrection, type CorrectionResult } from "@/lib/payments/fee-correction-db";
import { ReconciliationError } from "@/lib/reconciliation";

const fixSchema = z.object({
  orderNo: z.string().trim().min(1),
});

async function authorize() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function GET() {
  const session = await authorize();
  if (session instanceof Response) return session;
  await bootDb();

  const rows = await db
    .select({
      order: storeOrders,
      agentName: agents.displayName,
      earningId: agentEarnings.id,
      earningGross: agentEarnings.grossCents,
      earningCost: agentEarnings.costCents,
      earningAgentFee: agentEarnings.agentFeeCents,
      earningCents: agentEarnings.earningCents,
      earningStatus: agentEarnings.status,
      settlementNo: agentSettlements.settlementNo,
    })
    .from(storeOrders)
    .innerJoin(agents, eq(agents.id, storeOrders.agentId))
    .leftJoin(agentEarnings, eq(agentEarnings.orderId, storeOrders.id))
    .leftJoin(agentSettlements, eq(agentSettlements.id, agentEarnings.settlementId))
    .where(eq(storeOrders.payStatus, "paid"));

  const corrections = await db.select().from(agentEarningAdjustments).where(and(
    eq(agentEarningAdjustments.type, "fee_correction"),
    inArray(agentEarningAdjustments.status, ["pending", "settling", "settled"]),
  ));
  const correctionByOrder = new Map<number, number>();
  for (const row of corrections) {
    correctionByOrder.set(row.orderId, (correctionByOrder.get(row.orderId) ?? 0) + row.amountCents);
  }

  const issues: Array<Record<string, unknown>> = [];
  let ok = 0;
  for (const row of rows) {
    const order = row.order;
    let expectedEarning: number | null = null;
    let expectedFee: number | null = null;
    try {
      const ledger = recomputeStoredLedger(order);
      expectedEarning = ledger.agentEarningCents;
      expectedFee = ledger.agentFeeCents;
      const earning = row.earningId
        ? {
            grossCents: row.earningGross ?? 0,
            costCents: row.earningCost ?? 0,
            agentFeeCents: row.earningAgentFee ?? 0,
            earningCents: row.earningCents ?? 0,
          }
        : null;
      const mismatches = verifyLedger(order, earning);
      const correctionCents = correctionByOrder.get(order.id) ?? 0;
      const corrected =
        expectedEarning != null &&
        correctionCents === expectedEarning - order.agentEarningCents;
      const kinds: string[] = [];
      if (!corrected && mismatches.some((item) => item.code === "agent_earning" || item.code === "agent_fee")) {
        kinds.push("formula_mismatch");
      }
      if (
        mismatches.some((item) => item.code.startsWith("earning_row_")) &&
        !(row.earningCents != null && row.earningCents + correctionCents === expectedEarning &&
          row.earningGross === order.grossCents - order.invoiceSurchargeCents &&
          row.earningCost === order.agentCostTotalCents)
      ) {
        kinds.push("order_earning_row_mismatch");
      }
      if (
        order.actualPaymentFeeCents != null &&
        isGatewayFeeAnomalous(order.estimatedPaymentFeeCents, order.actualPaymentFeeCents)
      ) {
        kinds.push("fee_anomalous");
      }
      if (order.agentEarningCents >= 0 && order.agentEarningCents < 100) {
        kinds.push("low_earning");
      }
      if (!kinds.length) {
        ok += 1;
        continue;
      }
      issues.push({
        orderNo: order.orderNo,
        agent: row.agentName,
        kinds,
        expected: { agentEarningCents: expectedEarning, agentFeeCents: expectedFee },
        stored: {
          agentEarningCents: order.agentEarningCents,
          agentFeeCents: order.agentFeeCents,
          paymentFeeCents: order.finalPaymentFeeCents,
        },
        earningStatus: row.earningStatus,
        settlementNo: row.settlementNo,
      });
    } catch (error) {
      issues.push({
        orderNo: order.orderNo,
        agent: row.agentName,
        kinds: ["formula_mismatch"],
        error: error instanceof Error ? error.message : "无法重算",
        earningStatus: row.earningStatus,
        settlementNo: row.settlementNo,
      });
    }
  }

  return NextResponse.json({
    scanned: rows.length,
    ok,
    issues,
  });
}

export async function POST(req: Request) {
  const session = await authorize();
  if (session instanceof Response) return session;
  await bootDb();
  const parsed = fixSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, parsed.data.orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  const earning = await db.query.agentEarnings.findFirst({
    where: eq(agentEarnings.orderId, order.id),
  });
  const ledger = recomputeStoredLedger(order);
  const now = new Date().toISOString();

  if (earning?.status === "settling") {
    return NextResponse.json(
      { error: "这单还在待返佣结算单里，先撤销结算单再修正" },
      { status: 409 },
    );
  }

  if (earning?.status === "settled") {
    let outcome: CorrectionResult;
    try {
      outcome = await db.transaction((tx) =>
        applyAuditCorrection(tx, {
          orderId: order.id,
          orderNo: order.orderNo,
          earningId: earning.id,
          expectedUpdatedAt: order.updatedAt,
          now,
        }),
      );
    } catch (error) {
      if (error instanceof ReconciliationError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.status === 422 ? 422 : 409 },
        );
      }
      return NextResponse.json({ error: error instanceof Error ? error.message : "修正失败" }, { status: 409 });
    }
    const delta = outcome.deltaCents;
    if (delta === 0) return NextResponse.json({ ok: true, unchanged: true });
    if (outcome.replayed) {
      return NextResponse.json({ ok: true, replayed: true, adjustmentCents: delta });
    }
    await writeAuditLog({
      actor: session,
      action: "admin.earning.fee_correction",
      targetType: "store_order",
      targetId: order.id,
      metadata: { orderNo: order.orderNo, delta, adjustmentId: outcome.adjustmentId },
    });
    return NextResponse.json({ ok: true, adjustmentCents: delta });
  }

  try {
  await db.transaction(async (tx) => {
    await tx
      .update(storeOrders)
      .set({
        agentFeeCents: ledger.agentFeeCents,
        platformFeeCents: ledger.platformFeeCents,
        agentEarningCents: ledger.agentEarningCents,
        platformProfitCents: ledger.platformProfitCents,
        updatedAt: now,
      })
      .where(eq(storeOrders.id, order.id));
    if (earning) {
      const [updatedEarning] = await tx
        .update(agentEarnings)
        .set({
          ...earningSnapshotFromOrder({
            ...order,
            agentFeeCents: ledger.agentFeeCents,
            agentEarningCents: ledger.agentEarningCents,
          }),
          updatedAt: now,
        })
        .where(
          and(
            eq(agentEarnings.id, earning.id),
            eq(agentEarnings.status, "pending"),
            isNull(agentEarnings.settlementId),
          ),
        )
        .returning({ id: agentEarnings.id });
      if (!updatedEarning) throw new Error("收益行没有改成功");
    }
  });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "修正失败" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: "admin.earning.apply_snapshot",
    targetType: "store_order",
    targetId: order.id,
    metadata: {
      orderNo: order.orderNo,
      agentEarningCents: ledger.agentEarningCents,
    },
  });
  return NextResponse.json({
    ok: true,
    agentEarningCents: ledger.agentEarningCents,
  });
}
