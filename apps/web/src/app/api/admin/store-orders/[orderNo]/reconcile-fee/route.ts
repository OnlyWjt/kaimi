import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { reconcilePaymentFee } from "@/lib/payments/reconcile";

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
  const result = await reconcilePaymentFee(order.id, {
    allowManualReview: true,
  });
  return NextResponse.json({
    ok:
      result?.feeReconcileStatus === "confirmed" ||
      result?.feeReconcileStatus === "unsupported",
    feeReconcileStatus: result?.feeReconcileStatus,
    actualPaymentFeeCents: result?.actualPaymentFeeCents,
    finalPaymentFeeCents: result?.finalPaymentFeeCents,
    error: result?.feeReconcileLastError || "",
  });
}
