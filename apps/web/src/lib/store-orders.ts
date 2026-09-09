import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  agentStorefronts,
  agents,
  paymentChannelConfigs,
  platformPlans,
  storeOrders,
} from "@/db/schema";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { decryptSecret, encryptSecret, hashLookupValue } from "@/lib/crypto";
import { newOrderNo } from "@/lib/ids";
import { getDefaultCardplatformAccount } from "@/lib/cardplatform/config";
import { createEpayPayment } from "@/lib/payments/epay";
import { epayReady, getEpayConfig } from "@/lib/payments/config";
import type { PaymentChannel } from "@/lib/payments/fees";
import { assertStoreSalesOpen } from "@/lib/ops-health";
import { requirePublicBaseUrl } from "@/lib/public-url";
import { resolveProductName, rowToSettings } from "@/lib/agent-storefront-config";
import { getMaxOrderQuantity, resolveOrderQuantity } from "@/lib/store-quantity";
import {
  normalizeInvoiceRequest,
  quoteStorePayment,
} from "@/lib/invoice-core";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { countUnusedFinishedAccounts } from "@/lib/finished-accounts";

export async function createStoreOrder(input: {
  request: Request;
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  customerEmail: string;
  quantity?: number;
  invoiceRequested?: boolean;
  invoiceTitle?: string;
  invoiceNote?: string;
  invoiceEmail?: string;
}) {
  /** 配置没弄好是我们的问题，买家只需要知道买不了；真实原因留在服务端日志里。 */
  function unavailable(detail: string): never {
    console.warn(`[store-order] 拒绝下单：${detail}`);
    throw new Error("这个套餐暂时买不了，请联系店主。");
  }

  const agent = await db.query.agents.findFirst({
    where: and(
      eq(agents.currentSlug, normalizeAgentSlug(input.slug)),
      eq(agents.status, "active"),
    ),
  });
  if (!agent) throw new Error("店铺不存在或已关闭");
  await assertStoreSalesOpen();

  const maxQuantity = await getMaxOrderQuantity();
  const quantity = resolveOrderQuantity(input.quantity, maxQuantity);
  if (quantity === null) {
    throw new Error(`一次最多买 ${maxQuantity} 张，请调整数量后重试。`);
  }

  const [offer] = await db
    .select({
      planId: platformPlans.id,
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      cardplatformSellable: platformPlans.cardplatformSellable,
      fulfillmentKind: platformPlans.fulfillmentKind,
      assignmentEnabled: agentPlanPrices.enabled,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      retailPriceCents: agentPlanPrices.retailPriceCents,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, agent.id),
        eq(platformPlans.planKey, input.planKey),
        eq(platformPlans.enabled, true),
      ),
    )
    .limit(1);
  const localAccount = offer
    ? isLocalAccountPlan({
        planKey: offer.planKey,
        fulfillmentKind: offer.fulfillmentKind,
      })
    : false;
  if (
    !offer ||
    !offer.assignmentEnabled ||
    (!offer.cardplatformSellable && !localAccount)
  ) {
    throw new Error("这个套餐现在买不了，换一个或联系店主。");
  }

  const costCents =
    offer.costOverrideCents ?? offer.globalCostPriceCents;
  if (costCents <= 0 || offer.retailPriceCents < costCents) {
    unavailable(`套餐 ${offer.planKey} 价格配置无效：成本 ${costCents}，零售 ${offer.retailPriceCents}`);
  }
  const storefront = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agent.id),
  });
  const displayName = resolveProductName(
    offer.planKey,
    offer.name,
    rowToSettings(storefront).productNames,
  ).zh;
  const channelConfig = await db.query.paymentChannelConfigs.findFirst({
    where: and(
      eq(paymentChannelConfigs.channel, input.channel),
      eq(paymentChannelConfigs.enabled, true),
    ),
  });
  if (!channelConfig) throw new Error("这个支付方式暂时不可用，换一个试试。");
  const cardplatform = localAccount
    ? null
    : await getDefaultCardplatformAccount();
  if (!localAccount && !cardplatform) unavailable("没有可用的卡台账户");
  if (localAccount) {
    const unused = await countUnusedFinishedAccounts(offer.planKey);
    if (unused < quantity) {
      throw new Error("这个套餐正在补货中，请稍后再试。");
    }
  }

  const epay = await getEpayConfig();
  if (!epayReady(epay)) unavailable("易支付未配置");

  // 一单只是一笔支付：比例费率按买家实付抽，固定手续费整单只收一次。
  // 开票加价归平台，代理收益仍按商品额扣成本和手续费。
  const invoice = normalizeInvoiceRequest({
    requested: input.invoiceRequested,
    title: input.invoiceTitle,
    note: input.invoiceNote,
    email: input.invoiceEmail,
    fallbackEmail: input.customerEmail,
  });
  const goodsCents = offer.retailPriceCents * quantity;
  const agentCostTotalCents = costCents * quantity;
  const quote = quoteStorePayment({
    goodsCents,
    costTotalCents: agentCostTotalCents,
    invoiceRequested: invoice.requested,
    feeRule: {
      ratePpm: channelConfig.feeRatePpm,
      fixedFeeCents: channelConfig.fixedFeeCents,
    },
  });
  const grossCents = quote.payCents;
  const estimatedFeeCents = quote.feeCents;
  const earningCents = quote.earningCents;
  if (earningCents < 0) {
    unavailable(
      `套餐 ${offer.planKey} 扣手续费后代理收益为负：零售 ${offer.retailPriceCents}，成本 ${costCents}，数量 ${quantity}，手续费 ${estimatedFeeCents}`,
    );
  }

  const orderNo = newOrderNo("KS");
  const queryToken = crypto.randomBytes(24).toString("base64url");
  const base = await requirePublicBaseUrl(input.request);
  const fulfillmentIdempotencyKey = `kaimi-order-${orderNo}`;
  const createdAt = new Date().toISOString();
  const [order] = await db
    .insert(storeOrders)
    .values({
      orderNo,
      queryTokenHash: hashLookupValue(queryToken),
      queryTokenEncrypted: encryptSecret(queryToken),
      agentId: agent.id,
      planId: offer.planId,
      planKeySnapshot: offer.planKey,
      productNameSnapshot: displayName,
      quantity,
      retailPriceCents: offer.retailPriceCents,
      agentCostCents: costCents,
      grossCents,
      agentCostTotalCents,
      paymentChannel: input.channel,
      feeRatePpm: channelConfig.feeRatePpm,
      fixedFeeCents: channelConfig.fixedFeeCents,
      estimatedPaymentFeeCents: estimatedFeeCents,
      finalPaymentFeeCents: estimatedFeeCents,
      agentEarningCents: earningCents,
      invoiceRequested: invoice.requested,
      invoiceTitle: invoice.title,
      invoiceNote: invoice.note,
      invoiceEmail: invoice.email,
      invoiceAmountCents: invoice.requested ? quote.payCents : 0,
      invoiceSurchargeCents: quote.surchargeCents,
      customerEmail: input.customerEmail.trim().toLowerCase(),
      fulfillmentIdempotencyKey,
      cardplatformAccountId: cardplatform?.id ?? null,
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  if (!order) throw new Error("订单创建失败");

  const payment = await createEpayPayment(epay, {
    outTradeNo: orderNo,
    name: quantity > 1
      ? `${localAccount ? "账号" : "CDK"} ${displayName} ×${quantity}`
      : `${localAccount ? "账号" : "CDK"} ${displayName}`,
    moneyCents: grossCents,
    notifyUrl: `${base}/api/webhooks/epay`,
    returnUrl: `${base}/shop/order/${orderNo}?qt=${encodeURIComponent(queryToken)}`,
    channel: input.channel,
    clientIp:
      input.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined,
  });
  if (payment.tradeNo) {
    await db
      .update(storeOrders)
      .set({
        paymentTradeNo: payment.tradeNo,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeOrders.id, order.id));
  }

  return {
    order,
    queryToken,
    payUrl: payment.payUrl,
    gatewayTradeNo: payment.tradeNo,
  };
}

export async function listStoreOrdersByEmail(input: {
  slug: string;
  email: string;
}) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.currentSlug, normalizeAgentSlug(input.slug)),
  });
  if (!agent) throw new Error("店铺不存在");
  const email = input.email.trim().toLowerCase();
  const rows = await db.query.storeOrders.findMany({
    where: and(
      eq(storeOrders.agentId, agent.id),
      eq(storeOrders.customerEmail, email),
    ),
    orderBy: [desc(storeOrders.id)],
    limit: 20,
  });
  return rows.map((order) => ({
    orderNo: order.orderNo,
    productName: order.productNameSnapshot,
    quantity: order.quantity,
    amountCents: order.grossCents,
    payStatus: order.payStatus,
    fulfillStatus: order.fulfillStatus,
    createdAt: order.createdAt,
    queryToken: order.queryTokenEncrypted
      ? decryptSecret(order.queryTokenEncrypted)
      : "",
  }));
}
