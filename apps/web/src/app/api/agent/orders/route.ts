import { NextResponse } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";

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
  const start = query.get("start")?.trim();
  const end = query.get("end")?.trim();
  const page = Math.max(1, Number(query.get("page") || 1));
  const pageSize = Math.max(1, Math.min(100, Number(query.get("pageSize") || 20)));
  const conditions = [eq(storeOrders.agentId, session.agentId)];
  if (start) conditions.push(gte(storeOrders.createdAt, start));
  if (end) conditions.push(lte(storeOrders.createdAt, end));

  const list = await db.query.storeOrders.findMany({
    where: and(...conditions),
    orderBy: [desc(storeOrders.id)],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return NextResponse.json({
    list: list.map((order) => ({
      orderNo: order.orderNo,
      productName: order.productNameSnapshot,
      amountCents: order.retailPriceCents,
      paymentChannel: order.paymentChannel,
      paymentFeeCents: order.finalPaymentFeeCents,
      earningCents: order.agentEarningCents,
      payStatus: order.payStatus,
      fulfillStatus: order.fulfillStatus,
      feeReconcileStatus: order.feeReconcileStatus,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      deliveredAt: order.deliveredAt,
    })),
    page,
    pageSize,
  });
}
