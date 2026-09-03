import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { decryptSecret, hashLookupValue } from "@/lib/crypto";
import { fulfillStoreOrder } from "@/lib/fulfillment/fulfill-store-order";
import { epayReady, getEpayConfig } from "@/lib/payments/config";
import {
  confirmStoreOrderPaid,
  confirmStoreOrderPaidFromGateway,
} from "@/lib/payments/confirm-store-order";
import { verifyEpayNotify } from "@/lib/payments/epay";
import { getPublicBaseUrl } from "@/lib/public-url";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  epayParamsFromSearch,
  pickStoreQueryToken,
} from "@/lib/store-order-access";

async function serializePublicOrder(
  order: typeof storeOrders.$inferSelect,
  req: Request,
) {
  const cdk =
    order.fulfillStatus === "delivered"
      ? await db.query.issuedCdks.findFirst({
          where: eq(issuedCdks.orderId, order.id),
        })
      : null;
  const code = cdk ? decryptSecret(cdk.codeEncrypted) : null;
  const rechargePath = code
    ? `/recharge?code=${encodeURIComponent(code)}`
    : "/recharge";
  const origin = await getPublicBaseUrl(req);
  const queryToken = order.queryTokenEncrypted
    ? decryptSecret(order.queryTokenEncrypted)
    : "";
  return {
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
          : order.payStatus === "paid" && order.fulfillStatus !== "delivered"
            ? "支付成功，正在生成卡密"
            : "",
    code,
    queryToken,
    rechargePath,
    rechargeUrl: origin ? `${origin}${rechargePath}` : rechargePath,
    cdkStatus: cdk?.status ?? null,
    paidAt: order.paidAt,
    deliveredAt: order.deliveredAt,
  };
}

export async function GET(
  req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  const limited = enforceRateLimit(req, "public-store-order-query", 30);
  if (limited) return limited;
  await bootDb();
  const { orderNo } = await context.params;
  const search = new URL(req.url).searchParams;
  const token = pickStoreQueryToken(search);
  const epayParams = epayParamsFromSearch(search);

  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }

  const tokenOk = Boolean(token) &&
    order.queryTokenHash === hashLookupValue(token);

  let epayOk = false;
  const config = await getEpayConfig();
  if (epayReady(config) && epayParams.sign) {
    const outTradeNo = (epayParams.out_trade_no || "").trim();
    if (!outTradeNo || outTradeNo === order.orderNo) {
      epayOk = verifyEpayNotify(config, {
        ...epayParams,
        out_trade_no: outTradeNo || order.orderNo,
      }).ok;
    }
  }

  if (!tokenOk && !epayOk) {
    return NextResponse.json(
      {
        error:
          token || epayParams.sign
            ? "查询凭证无效，请从支付完成页重新进入"
            : "缺少订单查询凭证，请从支付完成页重新进入",
      },
      { status: token || epayParams.sign ? 403 : 400 },
    );
  }

  let current = order;
  let newlyPaid = false;
  if (current.payStatus === "unpaid") {
    if (epayOk) {
      const confirmed = await confirmStoreOrderPaid({
        orderNo: current.orderNo,
        moneyYuan: epayParams.money || "",
        tradeNo: epayParams.trade_no || "",
        rawParams: { ...epayParams, out_trade_no: current.orderNo },
      });
      if (confirmed.kind === "ok") {
        current = confirmed.order;
        newlyPaid = confirmed.newlyPaid;
      }
    } else {
      try {
        const confirmed = await confirmStoreOrderPaidFromGateway(current.orderNo);
        if (confirmed.kind === "ok") {
          current = confirmed.order;
          newlyPaid = confirmed.newlyPaid;
        }
      } catch {
        /* 查单失败时仍返回当前订单，由页面继续轮询 */
      }
    }
  }

  if (
    current.payStatus === "paid" &&
    (newlyPaid || current.fulfillStatus === "pending")
  ) {
    const fulfilled = await fulfillStoreOrder(current.id);
    if (fulfilled) current = fulfilled;
  }

  return NextResponse.json(await serializePublicOrder(current, req));
}
