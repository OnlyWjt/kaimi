import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, storeOrders } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const page = Math.max(1, Number(query.get("page") || 1));
  const pageSize = Math.max(1, Math.min(100, Number(query.get("pageSize") || 20)));
  const list = await db
    .select({
      id: storeOrders.id,
      orderNo: storeOrders.orderNo,
      agentId: storeOrders.agentId,
      agentName: agents.displayName,
      productName: storeOrders.productNameSnapshot,
      retailPriceCents: storeOrders.retailPriceCents,
      agentCostCents: storeOrders.agentCostCents,
      paymentChannel: storeOrders.paymentChannel,
      finalPaymentFeeCents: storeOrders.finalPaymentFeeCents,
      agentEarningCents: storeOrders.agentEarningCents,
      payStatus: storeOrders.payStatus,
      fulfillStatus: storeOrders.fulfillStatus,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      lastErrorCode: storeOrders.lastErrorCode,
      lastErrorMessage: storeOrders.lastErrorMessage,
      createdAt: storeOrders.createdAt,
      paidAt: storeOrders.paidAt,
      deliveredAt: storeOrders.deliveredAt,
    })
    .from(storeOrders)
    .innerJoin(agents, eq(agents.id, storeOrders.agentId))
    .orderBy(desc(storeOrders.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return NextResponse.json({ list, page, pageSize });
}
