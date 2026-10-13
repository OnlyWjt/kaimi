import crypto from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { agentStorefronts, agents, apiTestOrders } from "@/db/schema";
import { loadAgentSellablePlans } from "@/lib/agent-catalog";
import { resolveProductName, rowToSettings } from "@/lib/agent-storefront-config";
import { planNameWithRegion, regionDisplay } from "@/lib/cardplatform/regions";
import { hashLookupValue } from "@/lib/crypto";
import { newOrderNo } from "@/lib/ids";
import { buildReturnUrl } from "@/lib/open-api/return-url";
import { enqueueAgentWebhook } from "@/lib/open-api/webhooks";
import { quoteStoreCheckout } from "@/lib/store-orders";

/**
 * 测试 Key 的沙箱订单。
 *
 * 价格、套餐、优惠券都按正式规则校验（quoteStoreCheckout 只读不写），这样测试通过的参数在正式环境也能下单；
 * 但订单只写 api_test_orders，付款是一个模拟链接，卡密是 TEST- 开头的假卡，回调里 livemode=false。
 */

export class SandboxError extends Error {}

function fakeCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(12);
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `TEST-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

export async function createTestOrder(input: {
  keyId: number;
  agentId: number;
  baseUrl: string;
  planKey: string;
  channel: "alipay" | "wxpay";
  customerEmail: string;
  quantity?: number;
  couponCode?: string;
  invoiceRequested?: boolean;
  regionConfirmed?: boolean;
  returnUrl?: string;
}) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, input.agentId),
    columns: { currentSlug: true },
  });
  if (!agent?.currentSlug) throw new SandboxError("店铺还没有地址");
  const plan = (await loadAgentSellablePlans(input.agentId)).find((item) => item.planKey === input.planKey);
  if (!plan) throw new SandboxError("这个套餐现在买不了，换一个或联系店主。");
  if (plan.regionConfirmationRequired && input.regionConfirmed !== true) {
    throw new SandboxError("请确认付款地区");
  }
  const quote = await quoteStoreCheckout({
    slug: agent.currentSlug,
    planKey: input.planKey,
    channel: input.channel,
    quantity: input.quantity,
    couponCode: input.couponCode,
    invoiceRequested: input.invoiceRequested,
  });
  // 和正式下单一样用代理在店铺装修里改过的商品名，订单名和 GET /plans 对得上。
  const storefront = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, input.agentId),
  });
  const baseName = resolveProductName(
    plan.basePlanKey || plan.planKey,
    plan.name,
    rowToSettings(storefront).productNames,
  ).zh;
  const orderNo = newOrderNo("KT");
  const payToken = crypto.randomBytes(24).toString("base64url");
  const quantity = input.quantity ?? 1;
  await db.insert(apiTestOrders).values({
    keyId: input.keyId,
    agentId: input.agentId,
    orderNo,
    planKey: plan.planKey,
    paymentCountry: plan.paymentCountry,
    productName: planNameWithRegion(baseName, plan.regionCapable, plan.paymentCountry, plan.regionLabel, "paren"),
    quantity,
    grossCents: quote.payCents,
    customerEmail: input.customerEmail.trim().toLowerCase(),
    returnUrl: input.returnUrl || "",
    payTokenHash: hashLookupValue(payToken),
  });
  return {
    order_no: orderNo,
    pay_url: `${input.baseUrl}/api/v1/open/sandbox/pay/${orderNo}?t=${encodeURIComponent(payToken)}`,
    gross_cents: quote.payCents,
    currency: "CNY",
    pay_status: "unpaid",
    query_token: "",
    livemode: false,
  };
}

/**
 * 打开模拟付款链接：直接记成已付款并发齐假卡，推 order.paid、order.delivered。
 * 重复打开不会重复推送。返回要跳回的地址（没有则为空串）。
 */
export async function payTestOrder(orderNo: string, token: string) {
  const order = await db.query.apiTestOrders.findFirst({ where: eq(apiTestOrders.orderNo, orderNo) });
  if (!order || !token || order.payTokenHash !== hashLookupValue(token)) {
    throw new SandboxError("模拟付款链接无效");
  }
  const returnUrl = order.returnUrl ? buildReturnUrl(order.returnUrl, order.orderNo) : "";
  if (order.payStatus !== "unpaid") return { order, returnUrl, newlyPaid: false };
  const now = new Date().toISOString();
  const codes = Array.from({ length: Math.max(1, order.quantity) }, fakeCode);
  const [updated] = await db
    .update(apiTestOrders)
    .set({
      payStatus: "paid",
      fulfillStatus: "delivered",
      paidAt: now,
      deliveredAt: now,
      codesJson: JSON.stringify(codes),
    })
    .where(and(eq(apiTestOrders.id, order.id), eq(apiTestOrders.payStatus, "unpaid")))
    .returning();
  if (!updated) {
    const latest = await db.query.apiTestOrders.findFirst({ where: eq(apiTestOrders.id, order.id) });
    return { order: latest ?? order, returnUrl, newlyPaid: false };
  }
  const body = testWebhookBody(updated);
  await enqueueAgentWebhook(updated.agentId, "order.paid", body);
  await enqueueAgentWebhook(updated.agentId, "order.delivered", body);
  return { order: updated, returnUrl, newlyPaid: true };
}

type TestOrder = typeof apiTestOrders.$inferSelect;

function testWebhookBody(order: TestOrder) {
  return {
    livemode: false,
    order_no: order.orderNo,
    pay_status: order.payStatus,
    fulfill_status: order.fulfillStatus,
    plan_key: order.planKey,
    payment_country: order.paymentCountry,
    product_name: order.productName,
    quantity: order.quantity,
    gross_cents: order.grossCents,
    currency: "CNY",
    customer_email: order.customerEmail,
    created_at: order.createdAt,
    paid_at: order.paidAt,
    delivered_at: order.deliveredAt,
  };
}

function testCodes(order: TestOrder) {
  try {
    const value = JSON.parse(order.codesJson);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function maskTestCode(code: string) {
  return code.length > 9 ? `${code.slice(0, 5)}****${code.slice(-4)}` : code;
}

/** 和 GET /orders 正式返回同样的字段，多一个 livemode=false。 */
export function serializeTestOrderSummary(order: TestOrder) {
  return {
    order_no: order.orderNo,
    plan_key: order.planKey,
    payment_country: order.paymentCountry,
    product_name: order.productName,
    quantity: order.quantity,
    gross_cents: order.grossCents,
    currency: "CNY",
    customer_email: order.customerEmail,
    pay_status: order.payStatus,
    fulfill_status: order.fulfillStatus,
    created_at: order.createdAt,
    paid_at: order.paidAt,
    livemode: false,
  };
}

export function serializeTestOrderDetail(order: TestOrder, reveal: boolean) {
  const region = order.paymentCountry ? regionDisplay(order.paymentCountry) : null;
  return {
    ...serializeTestOrderSummary(order),
    region: region && { code: region.code, name: region.zh, name_en: region.en },
    kind: "cdk",
    list_goods_cents: order.grossCents,
    discount_cents: 0,
    coupon_code: "",
    invoice_surcharge_cents: 0,
    delivered_at: order.deliveredAt,
    cdks: testCodes(order).map((code, index) => ({
      id: index + 1,
      status: "unused",
      plan_key: order.planKey,
      payment_country: order.paymentCountry,
      code_masked: maskTestCode(code),
      ...(reveal ? { code } : {}),
      issued_at: order.deliveredAt,
      used_at: null,
    })),
  };
}

export async function getTestOrder(agentId: number, orderNo: string) {
  return db.query.apiTestOrders.findFirst({
    where: and(eq(apiTestOrders.agentId, agentId), eq(apiTestOrders.orderNo, orderNo)),
  });
}

export async function listTestOrders(input: {
  agentId: number;
  limit: number;
  cursor: number;
  payStatus?: string;
  customerEmail?: string;
}) {
  const filters = [eq(apiTestOrders.agentId, input.agentId)];
  if (Number.isSafeInteger(input.cursor) && input.cursor > 0) filters.push(lt(apiTestOrders.id, input.cursor));
  if (input.payStatus) filters.push(eq(apiTestOrders.payStatus, input.payStatus));
  if (input.customerEmail) filters.push(eq(apiTestOrders.customerEmail, input.customerEmail));
  const rows = await db
    .select()
    .from(apiTestOrders)
    .where(and(...filters))
    .orderBy(desc(apiTestOrders.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    orders: page.map(serializeTestOrderSummary),
    page: { next_cursor: hasMore && last ? String(last.id) : null, has_more: hasMore },
  };
}

/** 沙箱订单留 30 天，够代理调试；再久没用处。 */
export async function pruneTestOrders(now = Date.now()) {
  const deleted = await db
    .delete(apiTestOrders)
    .where(lt(apiTestOrders.createdAt, new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()))
    .returning({ id: apiTestOrders.id });
  return deleted.length;
}
