import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agentSettlements,
  storeOrders,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "结算单无效" }, { status: 400 });
  }
  const settlement = await db.query.agentSettlements.findFirst({
    where: eq(agentSettlements.id, id),
  });
  if (!settlement) {
    return NextResponse.json({ error: "结算单不存在" }, { status: 404 });
  }
  const earnings = await db
    .select({
      orderNo: storeOrders.orderNo,
      productName: storeOrders.productNameSnapshot,
      quantity: storeOrders.quantity,
      listGoodsCents: storeOrders.listGoodsCents,
      couponCode: storeOrders.couponCodeSnapshot,
      couponDiscountCents: storeOrders.couponDiscountCents,
      goodsCents: agentEarnings.grossCents,
      costCents: agentEarnings.costCents,
      agentFeeCents: agentEarnings.agentFeeCents,
      earningCents: agentEarnings.earningCents,
    })
    .from(agentEarnings)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
    .where(eq(agentEarnings.settlementId, id));
  const adjustments = await db
    .select({
      type: agentEarningAdjustments.type,
      amountCents: agentEarningAdjustments.amountCents,
      reason: agentEarningAdjustments.reason,
      orderNo: storeOrders.orderNo,
    })
    .from(agentEarningAdjustments)
    .innerJoin(storeOrders, eq(storeOrders.id, agentEarningAdjustments.orderId))
    .where(eq(agentEarningAdjustments.settlementId, id));
  return NextResponse.json({
    settlementNo: settlement.settlementNo,
    amountCents: settlement.amountCents,
    earnings,
    adjustments,
  });
}
