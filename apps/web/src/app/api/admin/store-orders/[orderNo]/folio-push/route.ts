import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { enqueueFolioPush } from "@/lib/folio/push";
import { readFolioConfig } from "@/lib/folio/sign";

/** 补推到 Folio：没推过、被拒绝或重试用尽的已付款开票单。重新排一条推单任务，一分钟内执行。 */
export async function POST(
  _req: Request,
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
  const { orderNo } = await context.params;
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (!order.invoiceRequested) {
    return NextResponse.json({ error: "这单没有申请开票" }, { status: 400 });
  }
  if (order.payStatus !== "paid") {
    return NextResponse.json({ error: "只有已付款的订单可以推到 Folio" }, { status: 400 });
  }
  if (!(await readFolioConfig()).enabled) {
    return NextResponse.json({ error: "Folio 对接没开，先到「通知」页打开" }, { status: 400 });
  }
  if (!(await enqueueFolioPush(order.id))) {
    return NextResponse.json(
      { error: order.folioPushStatus === "pushed" ? "这单已经在 Folio 了" : "这单正在推送，稍后刷新看结果" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: "admin.store_order.folio_push",
    targetType: "store_order",
    targetId: order.id,
    metadata: { orderNo, previousStatus: order.folioPushStatus, previousError: order.folioPushError },
  });
  return NextResponse.json({ ok: true });
}
