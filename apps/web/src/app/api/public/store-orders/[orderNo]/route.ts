import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { decryptSecret, hashLookupValue } from "@/lib/crypto";
import { getPublicBaseUrl } from "@/lib/public-url";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function GET(
  req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  const limited = enforceRateLimit(req, "public-store-order-query", 30);
  if (limited) return limited;
  await bootDb();
  const { orderNo } = await context.params;
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!token) {
    return NextResponse.json({ error: "缺少订单查询凭证" }, { status: 400 });
  }
  const order = await db.query.storeOrders.findFirst({
    where: and(
      eq(storeOrders.orderNo, orderNo),
      eq(storeOrders.queryTokenHash, hashLookupValue(token)),
    ),
  });
  if (!order) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  const cdk =
    order.fulfillStatus === "delivered"
      ? await db.query.issuedCdks.findFirst({
          where: eq(issuedCdks.orderId, order.id),
        })
      : null;
  const code = cdk ? decryptSecret(cdk.codeEncrypted) : null;
  const rechargePath = code ? `/recharge?code=${encodeURIComponent(code)}` : "/recharge";
  const origin = await getPublicBaseUrl(req);
  return NextResponse.json({
    orderNo: order.orderNo,
    productName: order.productNameSnapshot,
    amountCents: order.retailPriceCents,
    paymentChannel: order.paymentChannel,
    payStatus: order.payStatus,
    fulfillStatus: order.fulfillStatus,
    message:
      order.fulfillStatus === "paid_undelivered"
        ? "支付成功，正在重试发卡"
        : order.fulfillStatus === "unknown"
          ? "支付成功，订单正在人工核对"
          : "",
    code,
    rechargePath,
    rechargeUrl: origin ? `${origin}${rechargePath}` : rechargePath,
    cdkStatus: cdk?.status ?? null,
    paidAt: order.paidAt,
    deliveredAt: order.deliveredAt,
  });
}
