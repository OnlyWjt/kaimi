import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";

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
  const { orderNo } = await context.params;
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (!order.queryTokenEncrypted) {
    return NextResponse.json(
      { error: "该订单创建于恢复功能上线前，无法生成恢复链接" },
      { status: 409 },
    );
  }
  const token = decryptSecret(order.queryTokenEncrypted);
  const origin =
    process.env.KAIMI_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    new URL(req.url).origin;
  await writeAuditLog({
    actor: session,
    action: "admin.store_order.recovery_link",
    targetType: "store_order",
    targetId: order.id,
    metadata: { orderNo: order.orderNo },
  });
  return NextResponse.json({
    recoveryUrl: `${origin}/shop/order/${encodeURIComponent(order.orderNo)}?token=${encodeURIComponent(token)}`,
    customerEmail: order.customerEmail,
  });
}
