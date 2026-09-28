import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentEarnings, storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  computeOrderLedger,
  earningSnapshotFromOrder,
  ledgerInputFromOrder,
} from "@/lib/order-ledger-core";

const schema = z.object({
  decision: z.enum(["accept_gateway", "keep_estimate"]),
  note: z.string().trim().max(200).optional().default(""),
});

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
  if (earning && (earning.status !== "pending" || earning.settlementId != null)) {
    return NextResponse.json(
      { error: "收益已经进入结算单，先撤销结算单再确认手续费" },
      { status: 409 },
    );
  }
  const now = new Date().toISOString();
  const status =
    parsed.data.decision === "accept_gateway" ? "confirmed" : "unsupported";
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
