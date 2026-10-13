import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, storeOrders } from "@/db/schema";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { claimIdempotent, releaseIdempotent, storeIdempotent } from "@/lib/open-api/idempotency";
import { checkReturnUrl } from "@/lib/open-api/return-url";
import { createTestOrder, listTestOrders } from "@/lib/open-api/sandbox";
import { requirePublicBaseUrl } from "@/lib/public-url";
import { openFail, openOk } from "@/lib/open-api/respond";
import { HARD_MAX_ORDER_QUANTITY } from "@/lib/store-quantity-core";
import { createStoreOrder } from "@/lib/store-orders";

const createSchema = z.object({
  plan_key: z.string().trim().min(1).max(64),
  channel: z.enum(["alipay", "wxpay"]),
  customer_email: z.string().trim().email().max(254),
  quantity: z.number().int().min(1).max(HARD_MAX_ORDER_QUANTITY).optional(),
  region_confirmed: z.boolean().optional(),
  coupon_code: z.string().trim().max(20).optional(),
  invoice_requested: z.boolean().optional(),
  invoice_title: z.string().max(120).optional(),
  invoice_tax_no: z.string().max(32).optional(),
  invoice_note: z.string().max(200).optional(),
  invoice_email: z.string().max(254).optional(),
  return_url: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const auth = await requireApiKey(req, "orders:write");
  if (!isApiKeyContext(auth)) return auth;
  if (auth.ownerType !== "agent" || !auth.agentId) {
    return openFail("FORBIDDEN_SCOPE", "只有代理 Key 可以代客下单");
  }
  const idemKey = req.headers.get("idempotency-key")?.trim() || "";
  if (!idemKey) return openFail("VALIDATION_FAILED", "请带 Idempotency-Key");
  const raw = await req.text();
  const idem = await claimIdempotent({ keyId: auth.id, idemKey, body: raw });
  if (idem.replay) return idem.replay;
  const finish = async (response: Response) => {
    await storeIdempotent({
      keyId: auth.id,
      idemKey,
      requestHash: idem.requestHash,
      status: response.status,
      responseJson: await response.clone().text(),
    });
    return response;
  };
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(JSON.parse(raw || "{}"));
  } catch {
    return finish(openFail("VALIDATION_FAILED", "下单参数无效"));
  }
  let returnUrl: string | undefined;
  if (body.return_url !== undefined) {
    const check = checkReturnUrl(body.return_url);
    if (!check.ok) return finish(openFail("VALIDATION_FAILED", check.error));
    returnUrl = check.url;
  }
  // 下面 createStoreOrder 的错误都会存成结果；这里是唯一可能意外抛出、留下占位行的地方。
  const agent = await db.query.agents
    .findFirst({
      where: eq(agents.id, auth.agentId),
      columns: { currentSlug: true },
    })
    .catch(async (error: unknown) => {
      await releaseIdempotent({ keyId: auth.id, idemKey }).catch(() => undefined);
      throw error;
    });
  if (!agent?.currentSlug) return finish(openFail("VALIDATION_FAILED", "店铺还没有地址"));
  if (auth.mode === "test") {
    try {
      return finish(
        openOk(
          await createTestOrder({
            keyId: auth.id,
            agentId: auth.agentId,
            baseUrl: await requirePublicBaseUrl(req),
            planKey: body.plan_key,
            channel: body.channel,
            customerEmail: body.customer_email,
            quantity: body.quantity,
            couponCode: body.coupon_code,
            invoiceRequested: body.invoice_requested,
            regionConfirmed: body.region_confirmed,
            returnUrl,
          }),
        ),
      );
    } catch (error) {
      return finish(openFail("VALIDATION_FAILED", error instanceof Error ? error.message : "下单失败"));
    }
  }
  try {
    const result = await createStoreOrder({
      request: req,
      slug: agent.currentSlug,
      planKey: body.plan_key,
      channel: body.channel,
      customerEmail: body.customer_email,
      quantity: body.quantity,
      regionConfirmed: body.region_confirmed,
      couponCode: body.coupon_code,
      invoiceRequested: body.invoice_requested,
      invoiceTitle: body.invoice_title,
      invoiceTaxNo: body.invoice_tax_no,
      invoiceNote: body.invoice_note,
      invoiceEmail: body.invoice_email,
      returnUrl,
    });
    return finish(
      openOk({
        order_no: result.order.orderNo,
        pay_url: result.payUrl,
        gross_cents: result.order.grossCents,
        currency: result.order.currency,
        pay_status: result.order.payStatus,
        query_token: result.queryToken,
      }),
    );
  } catch (error) {
    return finish(openFail("VALIDATION_FAILED", error instanceof Error ? error.message : "下单失败"));
  }
}

export async function GET(req: Request) {
  const auth = await requireApiKey(req, "orders:read");
  if (!isApiKeyContext(auth)) return auth;
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "20") || 20));
  const cursor = Number(url.searchParams.get("cursor") || 0);
  const payStatus = url.searchParams.get("pay_status")?.trim();
  // 下单时邮箱已转小写存储，这里同样处理，买家大小写写错也能查到。
  const customerEmail = url.searchParams.get("customer_email")?.trim().toLowerCase();
  if (auth.mode === "test" && auth.agentId) {
    return openOk(await listTestOrders({ agentId: auth.agentId, limit, cursor, payStatus, customerEmail }));
  }
  const filters = [];
  if (auth.ownerType === "agent") {
    if (!auth.agentId) return openOk({ orders: [] });
    filters.push(eq(storeOrders.agentId, auth.agentId));
  }
  if (Number.isSafeInteger(cursor) && cursor > 0) filters.push(lt(storeOrders.id, cursor));
  if (payStatus) filters.push(eq(storeOrders.payStatus, payStatus));
  if (customerEmail) filters.push(eq(storeOrders.customerEmail, customerEmail));
  const rows = await db
    .select({
      id: storeOrders.id,
      orderNo: storeOrders.orderNo,
      planKey: storeOrders.planKeySnapshot,
      paymentCountry: storeOrders.paymentCountrySnapshot,
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
      payment_country: row.paymentCountry,
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
