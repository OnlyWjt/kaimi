import { NextResponse } from "next/server";
import { and, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, storeOrders } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { normalizePage, normalizePageSize } from "@/lib/pagination-core";
import { parseStoreOrderQuery } from "@/lib/store-order-query-core";

export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const query = new URL(req.url).searchParams;
  const page = normalizePage(query.get("page"));
  const pageSize = normalizePageSize(query.get("pageSize"));
  const filters = parseStoreOrderQuery({
    q: query.get("q"),
    agentId: query.get("agentId"),
    payStatus: query.get("payStatus"),
    fulfillStatus: query.get("fulfillStatus"),
    invoiceOnly: query.get("invoiceOnly"),
  });

  const conditions: SQL[] = [];
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    const textMatch = or(
      like(storeOrders.orderNo, pattern),
      like(storeOrders.customerEmail, pattern),
      like(storeOrders.productNameSnapshot, pattern),
      like(storeOrders.planKeySnapshot, pattern),
      like(storeOrders.invoiceTitle, pattern),
      like(storeOrders.invoiceEmail, pattern),
      like(agents.displayName, pattern),
    );
    if (textMatch) conditions.push(textMatch);
  }
  if (filters.agentId != null) {
    conditions.push(eq(storeOrders.agentId, filters.agentId));
  }
  if (filters.payStatus) {
    conditions.push(eq(storeOrders.payStatus, filters.payStatus));
  }
  if (filters.fulfillStatus) {
    conditions.push(eq(storeOrders.fulfillStatus, filters.fulfillStatus));
  }
  if (filters.invoiceOnly) {
    conditions.push(eq(storeOrders.invoiceRequested, true));
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(storeOrders)
    .innerJoin(agents, eq(agents.id, storeOrders.agentId))
    .where(where);
  const list = await db
    .select({
      id: storeOrders.id,
      orderNo: storeOrders.orderNo,
      agentId: storeOrders.agentId,
      agentName: agents.displayName,
      productName: storeOrders.productNameSnapshot,
      quantity: storeOrders.quantity,
      retailPriceCents: storeOrders.retailPriceCents,
      agentCostCents: storeOrders.agentCostCents,
      grossCents: storeOrders.grossCents,
      agentCostTotalCents: storeOrders.agentCostTotalCents,
      // 部分发卡的订单要看出「已出几张」，卡密行数才是真相。
      issuedCount: sql<number>`(
        select count(*) from issued_cdks where issued_cdks.order_id = ${storeOrders.id}
      )`,
      paymentChannel: storeOrders.paymentChannel,
      finalPaymentFeeCents: storeOrders.finalPaymentFeeCents,
      agentEarningCents: storeOrders.agentEarningCents,
      payStatus: storeOrders.payStatus,
      fulfillStatus: storeOrders.fulfillStatus,
      feeReconcileStatus: storeOrders.feeReconcileStatus,
      lastErrorCode: storeOrders.lastErrorCode,
      lastErrorMessage: storeOrders.lastErrorMessage,
      invoiceRequested: storeOrders.invoiceRequested,
      invoiceTitle: storeOrders.invoiceTitle,
      invoiceNote: storeOrders.invoiceNote,
      invoiceEmail: storeOrders.invoiceEmail,
      invoiceAmountCents: storeOrders.invoiceAmountCents,
      invoiceSurchargeCents: storeOrders.invoiceSurchargeCents,
      couponCodeSnapshot: storeOrders.couponCodeSnapshot,
      couponDiscountCents: storeOrders.couponDiscountCents,
      listGoodsCents: storeOrders.listGoodsCents,
      invoiceNotifyStatus: storeOrders.invoiceNotifyStatus,
      invoiceNotifyError: storeOrders.invoiceNotifyError,
      invoiceNotifiedAt: storeOrders.invoiceNotifiedAt,
      createdAt: storeOrders.createdAt,
      paidAt: storeOrders.paidAt,
      deliveredAt: storeOrders.deliveredAt,
    })
    .from(storeOrders)
    .innerJoin(agents, eq(agents.id, storeOrders.agentId))
    .where(where)
    .orderBy(desc(storeOrders.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return NextResponse.json({ list, page, pageSize, total: Number(total) || 0 });
}
