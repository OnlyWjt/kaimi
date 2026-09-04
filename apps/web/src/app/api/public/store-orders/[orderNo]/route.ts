import { after, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, storeOrders } from "@/db/schema";
import { bootDb } from "@/lib/config";
import { decryptSecret, hashLookupValue } from "@/lib/crypto";
import { fulfillStoreOrder } from "@/lib/fulfillment/fulfill-store-order";
import { sanitizeLog } from "@/lib/log";
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
  // 一单可能多张，也可能只出了一部分，所以付过款就把已发的都取出来。
  const cdks =
    order.payStatus === "paid"
      ? await db.query.issuedCdks.findMany({
          where: eq(issuedCdks.orderId, order.id),
          orderBy: [asc(issuedCdks.id)],
        })
      : [];
  const codes = cdks.map((row) => decryptSecret(row.codeEncrypted));
  const origin = await getPublicBaseUrl(req);
  const queryToken = order.queryTokenEncrypted
    ? decryptSecret(order.queryTokenEncrypted)
    : "";
  // 多张卡不把卡密塞进地址：链接会很长，还会把卡密留在浏览器历史和中间代理的日志里。
  // 只带单号和已有的查询凭证，批量兑换页凭这两个自己去订单接口取卡密。
  const rechargePath =
    codes.length === 1
      ? `/recharge?code=${encodeURIComponent(codes[0]!)}`
      : codes.length > 1 && queryToken
        ? `/recharge?order=${encodeURIComponent(order.orderNo)}&qt=${encodeURIComponent(queryToken)}`
        : "/recharge";
  const quantity = Math.max(1, order.quantity);
  return {
    orderNo: order.orderNo,
    productName: order.productNameSnapshot,
    quantity,
    unitPriceCents: order.retailPriceCents,
    amountCents: order.grossCents,
    issuedCount: codes.length,
    paymentChannel: order.paymentChannel,
    payStatus: order.payStatus,
    fulfillStatus: order.fulfillStatus,
    message:
      order.fulfillStatus === "partially_delivered"
        ? `已出 ${codes.length}/${quantity} 张，剩下的正在继续生成`
        : order.fulfillStatus === "paid_undelivered"
          ? "支付成功，正在重试发卡"
          : order.fulfillStatus === "unknown"
            ? "支付成功，订单正在人工核对"
            : order.payStatus === "paid" && order.fulfillStatus !== "delivered"
              ? "支付成功，正在生成卡密"
              : "",
    code: codes[0] ?? null,
    codes,
    queryToken,
    rechargePath,
    rechargeUrl: origin ? `${origin}${rechargePath}` : rechargePath,
    cdkStatus: cdks[0]?.status ?? null,
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
    const orderId = current.id;
    const orderNoForLog = current.orderNo;
    after(async () => {
      await fulfillStoreOrder(orderId).catch((error) => {
        console.error(
          `[store-order] fulfill after return order=${orderNoForLog}`,
          sanitizeLog(error instanceof Error ? error.message : "unknown error"),
        );
      });
    });
  }

  return NextResponse.json(await serializePublicOrder(current, req));
}
