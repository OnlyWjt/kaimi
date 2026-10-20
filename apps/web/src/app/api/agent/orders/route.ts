import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import {
  agentInvoiceStatus,
  agentOrderStatus,
  ATTENTION_FULFILL_STATUSES,
  parseAgentOrderKeyword,
  parseAgentOrderView,
  REFUND_PAY_STATUSES,
  UNPAID_PAY_STATUSES,
  type AgentOrderView,
} from "@/lib/agent-orders-core";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { readFolioConfig } from "@/lib/folio/sign";
import { getPublicBaseUrl } from "@/lib/public-url";
import { storeOrderQueryUrl } from "@/lib/store-order-links";

const PAID = ["paid", "manual"];

function viewCondition(view: AgentOrderView): SQL | undefined {
  switch (view) {
    case "attention":
      return and(
        inArray(storeOrders.payStatus, PAID),
        inArray(storeOrders.fulfillStatus, [...ATTENTION_FULFILL_STATUSES]),
      );
    case "done":
      return and(inArray(storeOrders.payStatus, PAID), eq(storeOrders.fulfillStatus, "delivered"));
    case "unpaid":
      return inArray(storeOrders.payStatus, [...UNPAID_PAY_STATUSES]);
    case "closed":
      return eq(storeOrders.payStatus, "closed");
    case "refund":
      return inArray(storeOrders.payStatus, [...REFUND_PAY_STATUSES]);
    default:
      return undefined;
  }
}

export async function GET(req: Request) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const start = query.get("start")?.trim();
  const end = query.get("end")?.trim();
  const page = Math.max(1, Number(query.get("page") || 1) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(query.get("pageSize") || 20) || 20));
  const view = parseAgentOrderView(query.get("view"));
  const keyword = parseAgentOrderKeyword(query.get("q"));

  const base = [eq(storeOrders.agentId, session.agentId)];
  if (start) base.push(gte(storeOrders.createdAt, start));
  if (end) base.push(lte(storeOrders.createdAt, end));
  if (keyword?.kind === "email") base.push(eq(storeOrders.customerEmail, keyword.value));
  if (keyword?.kind === "orderNo") base.push(like(storeOrders.orderNo, `%${keyword.value}%`));
  const viewWhere = viewCondition(view);
  const where = and(...base, ...(viewWhere ? [viewWhere] : []));

  const [list, [{ total }], [{ attention }], origin, folio] = await Promise.all([
    db.query.storeOrders.findMany({
      where,
      orderBy: [desc(storeOrders.id)],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    db.select({ total: sql<number>`count(*)` }).from(storeOrders).where(where),
    // 待处理数量不受当前筛选影响，给标签上的红点用。
    db
      .select({ attention: sql<number>`count(*)` })
      .from(storeOrders)
      .where(and(eq(storeOrders.agentId, session.agentId), viewCondition("attention"))),
    getPublicBaseUrl(req),
    readFolioConfig(),
  ]);

  return NextResponse.json({
    list: list.map((order) => {
      const status = agentOrderStatus(order.payStatus, order.fulfillStatus);
      let queryUrl = "";
      if (order.queryTokenEncrypted && origin && queryLinkAllowed(order.payStatus)) {
        try {
          queryUrl = storeOrderQueryUrl(origin, order.orderNo, decryptSecret(order.queryTokenEncrypted));
        } catch {
          queryUrl = "";
        }
      }
      return {
        orderNo: order.orderNo,
        productName: order.productNameSnapshot,
        quantity: order.quantity,
        customerEmail: order.customerEmail,
        unitPriceCents: order.retailPriceCents,
        listGoodsCents: order.listGoodsCents,
        couponCode: order.couponCodeSnapshot,
        couponDiscountCents: order.couponDiscountCents,
        goodsCents: Math.max(0, order.grossCents - (order.invoiceSurchargeCents || 0)),
        agentCostTotalCents: order.agentCostTotalCents,
        amountCents: order.grossCents,
        paymentChannel: order.paymentChannel,
        paymentFeeCents: order.agentFeeCents,
        earningCents: order.agentEarningCents,
        payStatus: order.payStatus,
        fulfillStatus: order.fulfillStatus,
        statusLabel: status.label,
        statusTone: status.tone,
        statusHint: status.hint,
        invoiceStatus: agentInvoiceStatus(order, folio.enabled),
        feeReconcileStatus: order.feeReconcileStatus,
        deliveryMailStatus: order.deliveryMailStatus,
        canResendMail: order.fulfillStatus === "delivered" && PAID.includes(order.payStatus),
        queryUrl,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        deliveredAt: order.deliveredAt,
      };
    }),
    page,
    pageSize,
    total: Number(total) || 0,
    attentionCount: Number(attention) || 0,
  });
}

/** 查单链接只给付过款的单（含退款的，买家要看记录）。未付款、已关闭的单买家用不上。 */
function queryLinkAllowed(payStatus: string) {
  return PAID.includes(payStatus) || (REFUND_PAY_STATUSES as readonly string[]).includes(payStatus);
}
