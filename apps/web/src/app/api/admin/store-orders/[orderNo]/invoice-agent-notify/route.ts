import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { resendLatestAgentInvoiceNotice } from "@/lib/folio/agent-notice";

/** 把最近一条开票通知重发给代理，之前发过或跳过的也重发。代理没绑定或关了通知仍然不发。 */
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
    columns: { id: true },
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  const result = await resendLatestAgentInvoiceNotice(order.id);
  return NextResponse.json({ ok: result.status === "sent", ...result });
}
