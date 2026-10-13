import { after } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, platformPlans, storeOrders } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { regionDisplay } from "@/lib/cardplatform/regions";
import { decryptSecret, maskCode } from "@/lib/crypto";
import { isLocalAccountPlan, parseFinishedAccountLine } from "@/lib/finished-account-core";
import { isApiKeyContext, requireApiKey } from "@/lib/open-api/auth";
import { openFail, openOk } from "@/lib/open-api/respond";
import { getTestOrder, serializeTestOrderDetail } from "@/lib/open-api/sandbox";
import { processBackgroundJobs } from "@/lib/background-jobs";
import { checkStoreOrderPaidAtGateway } from "@/lib/payments/confirm-store-order";
import { rateLimit } from "@/lib/rate-limit";

/** 成品号明文是一行「邮箱----GPT密码----邮箱密码----Session」，拆开给调用方。 */
function finishedAccountFields(code: string) {
  try {
    const parts = parseFinishedAccountLine(code);
    return {
      email: parts.email,
      password: parts.gptPassword,
      mailbox_password: parts.mailboxPassword,
      session: parts.session,
    };
  } catch {
    return null;
  }
}

export async function GET(
  req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  const auth = await requireApiKey(req, "orders:read");
  if (!isApiKeyContext(auth)) return auth;
  const reveal = new URL(req.url).searchParams.get("reveal") === "1";
  if (reveal && !auth.scopes.includes("cdks:reveal")) {
    return openFail("FORBIDDEN_SCOPE", "API Key 没有看卡密明文的权限");
  }
  const { orderNo } = await context.params;
  if (auth.mode === "test" && auth.agentId) {
    const testOrder = await getTestOrder(auth.agentId, orderNo);
    if (!testOrder) return openFail("NOT_FOUND", "订单不存在");
    return openOk(serializeTestOrderDetail(testOrder, reveal));
  }
  const filters = [eq(storeOrders.orderNo, orderNo)];
  if (auth.ownerType === "agent" && auth.agentId) {
    filters.push(eq(storeOrders.agentId, auth.agentId));
  }
  let order = await db.query.storeOrders.findFirst({
    where: and(...filters),
  });
  if (!order) return openFail("NOT_FOUND", "订单不存在");
  // 买家付完款跳回的是代理自己的站，不会经过本站订单页的网关补查。
  // 代理轮询未付款订单时替他向网关查一次；同一单 30 秒最多查一次。
  if (order.payStatus === "unpaid" && rateLimit(`open-order-gateway:${order.id}`, 1, 30_000).ok) {
    if ((await checkStoreOrderPaidAtGateway(order.orderNo)) === "paid") {
      order = (await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, order.id) })) ?? order;
      after(() => processBackgroundJobs(4).catch(() => undefined));
    }
  }
  const [cdks, plan] = await Promise.all([
    db
      .select({
        id: issuedCdks.id,
        status: issuedCdks.status,
        planKey: issuedCdks.planKey,
        paymentCountry: issuedCdks.paymentCountry,
        codeEncrypted: issuedCdks.codeEncrypted,
        issuedAt: issuedCdks.issuedAt,
        usedAt: issuedCdks.usedAt,
      })
      .from(issuedCdks)
      .where(eq(issuedCdks.orderId, order.id))
      .orderBy(asc(issuedCdks.id)),
    db.query.platformPlans.findFirst({
      where: eq(platformPlans.planKey, order.planKeySnapshot),
      columns: { regionCapable: true, regionLabel: true, fulfillmentKind: true },
    }),
  ]);
  const account = isLocalAccountPlan({
    planKey: order.planKeySnapshot,
    fulfillmentKind: plan?.fulfillmentKind,
  });
  const region = plan?.regionCapable
    ? regionDisplay(order.paymentCountrySnapshot, plan.regionLabel)
    : null;
  if (reveal && cdks.length) {
    await writeAuditLog({
      action: "open_api_order_reveal",
      targetType: "store_order",
      targetId: order.id,
      ip: auth.ip,
      metadata: { keyId: auth.id, agentId: auth.agentId, count: cdks.length },
    });
  }
  return openOk({
    order_no: order.orderNo,
    plan_key: order.planKeySnapshot,
    payment_country: order.paymentCountrySnapshot,
    region: region && { code: region.code, name: region.zh, name_en: region.en },
    kind: account ? "account" : "cdk",
    product_name: order.productNameSnapshot,
    quantity: order.quantity,
    list_goods_cents: order.listGoodsCents,
    discount_cents: order.couponDiscountCents,
    coupon_code: order.couponCodeSnapshot,
    invoice_surcharge_cents: order.invoiceSurchargeCents,
    gross_cents: order.grossCents,
    currency: order.currency,
    customer_email: order.customerEmail,
    pay_status: order.payStatus,
    fulfill_status: order.fulfillStatus,
    created_at: order.createdAt,
    paid_at: order.paidAt,
    delivered_at: order.deliveredAt,
    cdks: cdks.map((cdk) => {
      let code = "";
      try {
        code = decryptSecret(cdk.codeEncrypted);
      } catch {
        code = "";
      }
      return {
        id: cdk.id,
        status: cdk.status,
        plan_key: cdk.planKey,
        payment_country: cdk.paymentCountry,
        code_masked: code ? maskCode(code) : "",
        ...(reveal
          ? { code, ...(account ? { account: finishedAccountFields(code) } : {}) }
          : {}),
        issued_at: cdk.issuedAt,
        used_at: cdk.usedAt,
      };
    }),
  });
}
