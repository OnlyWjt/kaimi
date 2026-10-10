import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentEarnings, storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin, type AuthSession } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  computeOrderLedger,
  earningSnapshotFromOrder,
  ledgerInputFromOrder,
  type LedgerResult,
} from "@/lib/order-ledger-core";
import {
  applySettledFeeReview,
  type CorrectionResult,
} from "@/lib/payments/fee-correction-db";
import {
  FEE_REVIEW_SETTLING_MESSAGE,
  earningLockState,
  isEarningOpen,
} from "@/lib/payments/fee-lock-core";
import { ReconciliationError } from "@/lib/reconciliation";

const schema = z.object({
  decision: z.enum(["accept_gateway", "keep_estimate"]),
  note: z.string().trim().max(200).optional().default(""),
});

type StoreOrder = typeof storeOrders.$inferSelect;
type AgentEarning = typeof agentEarnings.$inferSelect;

/**
 * 收益已结算：收益行不改（设计文档 3.2：已返佣后发现错账另加 fee_correction）。
 * accept_gateway 在同一事务里把订单金额改成网关口径并写 fee_correction，使订单（audit 的目标收益 L）
 * 等于「收益行 + 全部有效 fee_correction」；keep_estimate 不改金额、不写调整。事务体见 fee-correction-db.ts。
 */
async function settledFeeReview(input: {
  session: AuthSession;
  order: StoreOrder;
  earning: AgentEarning;
  decision: "accept_gateway" | "keep_estimate";
  note: string;
  status: "confirmed" | "unsupported";
  ledger: LedgerResult;
  gatewayFee: number;
  now: string;
}) {
  const { order, earning } = input;
  let result: CorrectionResult;
  try {
    result = await db.transaction((tx) =>
      applySettledFeeReview(tx, {
        orderId: order.id,
        orderNo: order.orderNo,
        earningId: earning.id,
        decision: input.decision,
        status: input.status,
        note: input.note,
        now: input.now,
        estimatedFeeCents: order.estimatedPaymentFeeCents,
        gatewayFee: input.gatewayFee,
        ledger: input.ledger,
      }),
    );
  } catch (error) {
    if (error instanceof ReconciliationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status === 422 ? 422 : 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "手续费确认失败" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: input.session,
    action: "admin.order.fee_review",
    targetType: "store_order",
    targetId: order.id,
    metadata: {
      orderNo: order.orderNo,
      decision: input.decision,
      gatewayFee: input.gatewayFee,
      note: input.note,
      earningSettled: true,
      feeCorrectionCents: result.deltaCents,
      adjustmentId: result.adjustmentId,
      replayed: result.replayed,
    },
  });
  return NextResponse.json({
    ok: true,
    settled: true,
    adjustmentCents: result.deltaCents,
    replayed: result.replayed,
  });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const orderNo = (await context.params).orderNo;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.feeReconcileStatus !== "manual_review") {
    return NextResponse.json({ error: "这单手续费不在待核对" }, { status: 409 });
  }
  const gatewayFee =
    parsed.data.decision === "accept_gateway"
      ? order.actualPaymentFeeCents
      : order.estimatedPaymentFeeCents;
  if (gatewayFee == null) {
    return NextResponse.json({ error: "没有可采纳的手续费" }, { status: 409 });
  }
  const ledger = computeOrderLedger(ledgerInputFromOrder(order), {
    gatewayFeeCents: gatewayFee,
  });
  if (ledger.agentEarningCents < 0) {
    return NextResponse.json(
      { error: "按这个手续费算出的代理收益为负，不能写入" },
      { status: 409 },
    );
  }
  const earning = await db.query.agentEarnings.findFirst({
    where: eq(agentEarnings.orderId, order.id),
  });
  const lockState = earningLockState(earning);
  if (lockState === "settling") {
    return NextResponse.json({ error: FEE_REVIEW_SETTLING_MESSAGE }, { status: 409 });
  }
  const now = new Date().toISOString();
  const status =
    parsed.data.decision === "accept_gateway" ? "confirmed" : "unsupported";

  if (earning && lockState === "settled") {
    return settledFeeReview({
      session,
      order,
      earning,
      decision: parsed.data.decision,
      note: parsed.data.note,
      status,
      ledger,
      gatewayFee,
      now,
    });
  }
  if (!isEarningOpen(lockState)) {
    return NextResponse.json(
      { error: "收益已经进入结算单，先撤销结算单再确认手续费" },
      { status: 409 },
    );
  }
  try {
  await db.transaction(async (tx) => {
    const [updatedOrder] = await tx
      .update(storeOrders)
      .set({
        finalPaymentFeeCents: ledger.finalPaymentFeeCents,
        agentFeeCents: ledger.agentFeeCents,
        platformFeeCents: ledger.platformFeeCents,
        agentEarningCents: ledger.agentEarningCents,
        platformProfitCents: ledger.platformProfitCents,
        feeReconcileStatus: status,
        feeReconcileLastError: parsed.data.note,
        feeReconciledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storeOrders.id, order.id),
          eq(storeOrders.feeReconcileStatus, "manual_review"),
        ),
      )
      .returning({ id: storeOrders.id });
    if (!updatedOrder) throw new Error("订单状态已变化，手续费没有改");
    if (earning) {
      const [updatedEarning] = await tx
        .update(agentEarnings)
        .set({
          ...earningSnapshotFromOrder({
            ...order,
            agentFeeCents: ledger.agentFeeCents,
            finalPaymentFeeCents: ledger.finalPaymentFeeCents,
            agentEarningCents: ledger.agentEarningCents,
          }),
          feeSource:
            parsed.data.decision === "accept_gateway"
              ? "gateway_actual"
              : "configured_fallback",
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
      if (!updatedEarning) throw new Error("收益行没有改成功，订单也已恢复");
    }
  });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "手续费确认失败" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: "admin.order.fee_review",
    targetType: "store_order",
    targetId: order.id,
    metadata: {
      orderNo,
      decision: parsed.data.decision,
      gatewayFee,
      note: parsed.data.note,
    },
  });
  return NextResponse.json({ ok: true, agentEarningCents: ledger.agentEarningCents });
}
