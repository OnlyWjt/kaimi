import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { fulfillStoreOrder } from "@/lib/fulfillment/fulfill-store-order";

export async function POST(
  _req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const { orderNo } = await context.params;
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.payStatus !== "paid") {
    return NextResponse.json(
      { error: "订单不是已付款状态，禁止重试发卡" },
      { status: 409 },
    );
  }
  if (order.fulfillStatus === "unknown") {
    return NextResponse.json(
      { error: "上游结果不确定，核对卡台前禁止重试" },
      { status: 409 },
    );
  }
  const result = await fulfillStoreOrder(order.id);
  return NextResponse.json({
    ok: result?.fulfillStatus === "delivered",
    fulfillStatus: result?.fulfillStatus,
    error: result?.lastErrorMessage || "",
  });
}
