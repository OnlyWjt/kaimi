import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { notifyStoreInvoicePaid } from "@/lib/notify";

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
  if (!order) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  if (!order.invoiceRequested) {
    return NextResponse.json({ error: "这单没有申请开票" }, { status: 400 });
  }
  if (order.payStatus !== "paid") {
    return NextResponse.json({ error: "未支付的订单先不要开票" }, { status: 400 });
  }
  const result = await notifyStoreInvoicePaid(order, { force: true });
  const latest = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, order.id),
    columns: {
      invoiceNotifyStatus: true,
      invoiceNotifyError: true,
      invoiceNotifiedAt: true,
    },
  });
  return NextResponse.json({
    ok: result.telegram.ok || result.webhook.ok,
    invoiceNotifyStatus: latest?.invoiceNotifyStatus || "",
    invoiceNotifyError: latest?.invoiceNotifyError || "",
    invoiceNotifiedAt: latest?.invoiceNotifiedAt || "",
  });
}
