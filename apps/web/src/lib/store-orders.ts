import crypto from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import { computeOrderLedger } from "@/lib/order-ledger-core";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { accountSupportsPaymentCountry } from "@/lib/cardplatform/issue-target";
import {
  groupPlansByBase,
  planNameWithRegion,
  regionConfirmationRequired,
} from "@/lib/cardplatform/regions";
import { countUnusedFinishedAccounts } from "@/lib/finished-accounts";
import {
  applyCheckoutCoupon,
  loadCheckoutCoupon,
  reserveCoupon,
} from "@/lib/coupons";
import { specFromRecord } from "@/lib/coupon-core";

/** 配置没弄好是我们的问题，买家只需要知道买不了；真实原因留在服务端日志里。 */
function unavailable(detail: string): never {
  console.warn(`[store-order] 拒绝下单：${detail}`);
  throw new Error("这个套餐暂时买不了，请联系店主。");
}

async function resolveStoreCheckout(input: {
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  quantity?: number;
}) {
  const agent = await db.query.agents.findFirst({
    where: and(
      eq(agents.currentSlug, normalizeAgentSlug(input.slug)),
      eq(agents.status, "active"),
    ),
  });
  if (!agent) throw new Error("店铺不存在或已关闭");

  const maxQuantity = await getMaxOrderQuantity();
  const quantity = resolveOrderQuantity(input.quantity, maxQuantity);
  if (quantity === null) {
    throw new Error(`一次最多买 ${maxQuantity} 张，请调整数量后重试。`);
  }

  const [offer] = await db
    .select({
      planId: platformPlans.id,
      planKey: platformPlans.planKey,
      basePlanKey: platformPlans.basePlanKey,
      upstreamPlanKey: platformPlans.upstreamPlanKey,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
      name: platformPlans.name,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      upstreamCostCents: platformPlans.upstreamCostCents,
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

  // 地区变体必须由支持付款地区的卡台发。同步到下单之间默认账户可能换成了不支持的协议。
  if (offer.paymentCountry && !localAccount) {
    const account = await getDefaultCardplatformAccount();
    const supported = !account || accountSupportsPaymentCountry(account);
    if (!supported) {
      unavailable(`默认卡台账户不支持付款地区 ${offer.paymentCountry}`);
    }
  }

  const costCents = offer.costOverrideCents ?? offer.globalCostPriceCents;
  if (costCents <= 0 || offer.retailPriceCents < costCents) {
    unavailable(
      `套餐 ${offer.planKey} 价格配置无效：成本 ${costCents}，零售 ${offer.retailPriceCents}`,
    );
  }
  const storefront = await db.query.agentStorefronts.findFirst({
    where: eq(agentStorefronts.agentId, agent.id),
  });
  const baseName = resolveProductName(
    offer.basePlanKey || offer.planKey,
    offer.name,
    rowToSettings(storefront).productNames,
  ).zh;
  const displayName = planNameWithRegion(
    baseName,
    offer.regionCapable,
    offer.paymentCountry,
    offer.regionLabel,
    "paren",
  );
  const channelConfig = await db.query.paymentChannelConfigs.findFirst({
    where: and(
      eq(paymentChannelConfigs.channel, input.channel),
      eq(paymentChannelConfigs.enabled, true),
    ),
  });
  if (!channelConfig) throw new Error("这个支付方式暂时不可用，换一个试试。");

  return {
    agent,
    offer,
    localAccount,
    quantity,
    costCents,
    displayName,
    channelConfig,
    listGoodsCents: offer.retailPriceCents * quantity,
    agentCostTotalCents: costCents * quantity,
    upstreamCostUnitCents: offer.upstreamCostCents,
    upstreamCostTotalCents:
      offer.upstreamCostCents == null ? null : offer.upstreamCostCents * quantity,
    feeRule: {
      ratePpm: channelConfig.feeRatePpm,
      fixedFeeCents: channelConfig.fixedFeeCents,
    },
  };
}

async function quoteCheckoutAmounts(input: {
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  quantity?: number;
  couponCode?: string;
  invoiceRequested?: boolean;
}) {
  const checkout = await resolveStoreCheckout(input);
  const listGoodsCents = checkout.listGoodsCents;
  let goodsCents = listGoodsCents;
  let discountCents = 0;
  let coupon: Awaited<ReturnType<typeof loadCheckoutCoupon>> | null = null;
  const code = (input.couponCode || "").trim();
  if (code) {
    const loaded = await loadCheckoutCoupon({
      agentId: checkout.agent.id,
      code,
      planKey: checkout.offer.planKey,
    });
    coupon = loaded;
    const applied = applyCheckoutCoupon({
      listGoodsCents,
      costTotalCents: checkout.agentCostTotalCents,
      feeRule: checkout.feeRule,
      spec: specFromRecord(loaded),
    });
    goodsCents = applied.goodsCents;
    discountCents = applied.discountCents;
  }
  const quote = quoteStorePayment({
    goodsCents,
    costTotalCents: checkout.agentCostTotalCents,
    invoiceRequested: Boolean(input.invoiceRequested),
    feeRule: checkout.feeRule,
  });
  if (quote.earningCents < 0) {
    if (coupon) {
      throw new Error("这张券用在当前商品上后，扣完通道费会低于成本");
    }
    unavailable(
      `套餐 ${checkout.offer.planKey} 扣手续费后代理收益为负：零售 ${checkout.offer.retailPriceCents}，成本 ${checkout.costCents}，数量 ${checkout.quantity}，手续费 ${quote.feeCents}`,
    );
  }
  return { checkout, coupon, listGoodsCents, goodsCents, discountCents, quote };
}

export async function quoteStoreCheckout(input: {
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  quantity?: number;
  couponCode?: string;
  invoiceRequested?: boolean;
}) {
  const priced = await quoteCheckoutAmounts(input);
  return {
    listGoodsCents: priced.listGoodsCents,
    discountCents: priced.discountCents,
    goodsCents: priced.goodsCents,
    surchargeCents: priced.quote.surchargeCents,
    payCents: priced.quote.payCents,
    couponCode: priced.coupon?.code || "",
  };
}

export async function createStoreOrder(input: {
  request: Request;
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  customerEmail: string;
  quantity?: number;
  couponCode?: string;
  invoiceRequested?: boolean;
  invoiceTitle?: string;
  invoiceTaxNo?: string;
  invoiceNote?: string;
  invoiceEmail?: string;
  /** 商品组内有两个及以上在售地区时必须为 true。 */
  regionConfirmed?: boolean;
}) {
  await assertStoreSalesOpen();
  const priced = await quoteCheckoutAmounts(input);
  const { checkout, coupon, listGoodsCents, discountCents, quote } = priced;
  const { agent, offer, localAccount, quantity, costCents, displayName, channelConfig } =
    checkout;

  if (offer.regionCapable) {
    const siblings = await db
      .select({
        planKey: platformPlans.planKey,
        basePlanKey: platformPlans.basePlanKey,
        name: platformPlans.name,
        paymentCountry: platformPlans.paymentCountry,
        regionLabel: platformPlans.regionLabel,
        regionCapable: platformPlans.regionCapable,
        sortOrder: platformPlans.sortOrder,
      })
      .from(agentPlanPrices)
      .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
      .where(
        and(
          eq(agentPlanPrices.agentId, agent.id),
          eq(agentPlanPrices.enabled, true),
          eq(platformPlans.enabled, true),
          eq(platformPlans.cardplatformSellable, true),
        ),
      );
    const group = groupPlansByBase(siblings).find(
      (item) => item.baseKey === (offer.basePlanKey || offer.planKey),
    );
    if (regionConfirmationRequired(group?.plans.length ?? 1) && input.regionConfirmed !== true) {
      throw new Error("请确认付款地区");
    }
  }

  const cardplatform = localAccount ? null : await getDefaultCardplatformAccount();
  if (!localAccount && !cardplatform) unavailable("没有可用的卡台账户");
  if (localAccount) {
    const unused = await countUnusedFinishedAccounts(offer.planKey);
    if (unused < quantity) {
      throw new Error("这个套餐正在补货中，请稍后再试。");
    }
  }

  const epay = await getEpayConfig();
  if (!epayReady(epay)) unavailable("易支付未配置");

  const invoice = normalizeInvoiceRequest({
    requested: input.invoiceRequested,
    title: input.invoiceTitle,
    taxNo: input.invoiceTaxNo,
    note: input.invoiceNote,
    email: input.invoiceEmail,
  });
  const invoiceQuote = invoice.requested
    ? quoteStorePayment({
        goodsCents: priced.goodsCents,
        costTotalCents: checkout.agentCostTotalCents,
        invoiceRequested: true,
        feeRule: checkout.feeRule,
      })
    : quote;
  const ledger = computeOrderLedger({
    grossCents: invoiceQuote.payCents,
    invoiceSurchargeCents: invoiceQuote.surchargeCents,
    agentCostTotalCents: checkout.agentCostTotalCents,
    upstreamCostTotalCents: checkout.upstreamCostTotalCents,
    feeRule: checkout.feeRule,
  });

  const orderNo = newOrderNo("KS");
  const queryToken = crypto.randomBytes(24).toString("base64url");
  const base = await requirePublicBaseUrl(input.request);
  const fulfillmentIdempotencyKey = `kaimi-order-${orderNo}`;
  const createdAt = new Date().toISOString();
  const order = await db.transaction(async (tx) => {
    if (coupon) {
      await reserveCoupon(tx, { couponId: coupon.id, agentId: agent.id });
    }
    const [created] = await tx
      .insert(storeOrders)
      .values({
        orderNo,
        queryTokenHash: hashLookupValue(queryToken),
        queryTokenEncrypted: encryptSecret(queryToken),
        agentId: agent.id,
        planId: offer.planId,
        planKeySnapshot: offer.planKey,
        upstreamPlanKeySnapshot: offer.upstreamPlanKey || offer.planKey,
        paymentCountrySnapshot: offer.paymentCountry,
        productNameSnapshot: displayName,
        quantity,
        retailPriceCents: offer.retailPriceCents,
        agentCostCents: costCents,
        grossCents: invoiceQuote.payCents,
        agentCostTotalCents: checkout.agentCostTotalCents,
        paymentChannel: input.channel,
        feeRatePpm: channelConfig.feeRatePpm,
        fixedFeeCents: channelConfig.fixedFeeCents,
        estimatedPaymentFeeCents: ledger.finalPaymentFeeCents,
        finalPaymentFeeCents: ledger.finalPaymentFeeCents,
        agentEarningCents: ledger.agentEarningCents,
        agentFeeCents: ledger.agentFeeCents,
        platformFeeCents: ledger.platformFeeCents,
        upstreamCostUnitCents: checkout.upstreamCostUnitCents,
        upstreamCostTotalCents: checkout.upstreamCostTotalCents,
        upstreamCostSource: checkout.upstreamCostTotalCents == null ? "unset" : "plan",
        platformProfitCents: ledger.platformProfitCents,
        invoiceRequested: invoice.requested,
        invoiceTitle: invoice.title,
        invoiceTaxNo: invoice.taxNo,
        invoiceNote: invoice.note,
        invoiceEmail: invoice.email,
        invoiceAmountCents: invoice.requested ? invoiceQuote.payCents : 0,
        invoiceSurchargeCents: invoiceQuote.surchargeCents,
        couponId: coupon?.id ?? null,
        couponCodeSnapshot: coupon?.code ?? "",
        couponKindSnapshot: coupon?.kind ?? "",
        couponPercentSnapshot: coupon?.percentZhe ?? 0,
        couponThresholdCents: coupon?.thresholdCents ?? 0,
        couponAmountSnapshot: coupon?.amountCents ?? 0,
        listGoodsCents,
        couponDiscountCents: discountCents,
        customerEmail: input.customerEmail.trim().toLowerCase(),
        fulfillmentIdempotencyKey,
        cardplatformAccountId: cardplatform?.id ?? null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    if (!created) throw new Error("订单创建失败");
    return created;
  });

  const payment = await createEpayPayment(epay, {
    outTradeNo: orderNo,
    name: quantity > 1
      ? `${localAccount ? "账号" : "CDK"} ${displayName} ×${quantity}`
      : `${localAccount ? "账号" : "CDK"} ${displayName}`,
    moneyCents: invoiceQuote.payCents,
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
  const planKeys = [...new Set(rows.map((order) => order.planKeySnapshot))];
  const planRows = planKeys.length
    ? await db
        .select({
          planKey: platformPlans.planKey,
          regionCapable: platformPlans.regionCapable,
          regionLabel: platformPlans.regionLabel,
        })
        .from(platformPlans)
        .where(inArray(platformPlans.planKey, planKeys))
    : [];
  const planByKey = new Map(planRows.map((plan) => [plan.planKey, plan]));
  return rows.map((order) => {
    const plan = planByKey.get(order.planKeySnapshot);
    return {
    orderNo: order.orderNo,
    productName: order.productNameSnapshot,
    quantity: order.quantity,
    amountCents: order.grossCents,
    payStatus: order.payStatus,
    fulfillStatus: order.fulfillStatus,
    createdAt: order.createdAt,
    paymentCountry: plan?.regionCapable ? order.paymentCountrySnapshot : null,
    regionLabel: plan?.regionCapable ? plan.regionLabel : null,
    queryToken: order.queryTokenEncrypted
      ? decryptSecret(order.queryTokenEncrypted)
      : "",
    };
  });
}
