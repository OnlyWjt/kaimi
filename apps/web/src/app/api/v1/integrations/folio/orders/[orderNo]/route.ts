import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { folioOrderData } from "@/lib/folio/core";
import { verifyFolioRequest } from "@/lib/folio/sign";

/** B 查单：Folio 推单校验、开票前终检时调用。HTTP 一律 200，结果看信封里的 status_code。 */
export async function GET(req: Request, context: { params: Promise<{ orderNo: string }> }) {
  await bootDb();
  const verified = await verifyFolioRequest(req, "");
  if (!verified.ok) {
    return NextResponse.json(
      { status_code: verified.status, msg: verified.error },
      { status: verified.status },
    );
  }
  const { orderNo } = await context.params;
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo.trim()),
  });
  if (!order) return NextResponse.json({ status_code: 404, msg: "订单不存在" });
  return NextResponse.json({ status_code: 0, msg: "success", data: folioOrderData(order) });
}
