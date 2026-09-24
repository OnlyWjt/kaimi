import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { storeOrders } from "@/db/schema";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openOk } from "@/lib/open-api/respond";

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "orders:read");
  if (!isApiKeyContext(auth)) return auth;
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "20") || 20));
  const cursor = Number(url.searchParams.get("cursor") || 0);
  const filters = [];
  if (auth.ownerType === "agent") {
    if (!auth.agentId) return openOk({ orders: [] });
    filters.push(eq(storeOrders.agentId, auth.agentId));
  }
  if (Number.isSafeInteger(cursor) && cursor > 0) filters.push(lt(storeOrders.id, cursor));
  const payStatus = url.searchParams.get("pay_status")?.trim();
  if (payStatus) filters.push(eq(storeOrders.payStatus, payStatus));
  const rows = await db
    .select({
      id: storeOrders.id,
      orderNo: storeOrders.orderNo,
      planKey: storeOrders.planKeySnapshot,
      productName: storeOrders.productNameSnapshot,
      quantity: storeOrders.quantity,
      grossCents: storeOrders.grossCents,
      currency: storeOrders.currency,
      customerEmail: storeOrders.customerEmail,
      payStatus: storeOrders.payStatus,
      fulfillStatus: storeOrders.fulfillStatus,
      createdAt: storeOrders.createdAt,
      paidAt: storeOrders.paidAt,
    })
    .from(storeOrders)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(storeOrders.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return openOk({
    orders: page.map((row) => ({
      order_no: row.orderNo,
      plan_key: row.planKey,
      product_name: row.productName,
      quantity: row.quantity,
      gross_cents: row.grossCents,
      currency: row.currency,
      customer_email: row.customerEmail,
      pay_status: row.payStatus,
      fulfill_status: row.fulfillStatus,
      created_at: row.createdAt,
      paid_at: row.paidAt,
    })),
    page: { next_cursor: hasMore && last ? String(last.id) : null, has_more: hasMore },
  });
}
