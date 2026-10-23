import { assertAgentContactReady } from "@/lib/agent-contact";
import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
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
import { clientIp } from "@/lib/rate-limit";
import { buildReturnUrl } from "@/lib/open-api/return-url";
import { maskOrderNo } from "@/lib/order-no-mask";
import { storeOrderQueryUrl } from "@/lib/store-order-links";
import { shouldCloseUnpaidOrder, type GatewayPaidCheck } from "@/lib/store-order-close-core";
import { requireCallbackBaseUrl, requirePublicBaseUrl } from "@/lib/public-url";
import { resolveProductName, rowToSettings } from "@/lib/agent-storefront-config";
import { getMaxOrderQuantity, resolveOrderQuantity } from "@/lib/store-quantity";
import {
  INVOICE_DEFAULT_RATE_PCT,
  LEGACY_INVOICE_POLICY,
  assertInvoiceRateUnchanged,
  invoicePolicyFor,
  normalizeInvoiceRequest,
  quoteStorePayment,
  type InvoicePolicy,
} from "@/lib/invoice-core";
import { getAgentInvoiceTaxBp } from "@/lib/invoice-policy";
import { computeOrderLedger } from "@/lib/order-ledger-core";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { accountSupportsPaymentCountry } from "@/lib/cardplatform/issue-target";
import {
  groupPlansByBase,
  planNameWithRegion,
  regionConfirmationRequired,
} from "@/lib/cardplatform/regions";
import {
  countPendingStoreAccountClaims,
  countUnusedFinishedAccounts,
} from "@/lib/finished-accounts";
import {
  applyCheckoutCoupon,
  loadCheckoutCoupon,
  releaseCouponForTransition,
  reserveCoupon,
} from "@/lib/coupons";
import { specFromRecord } from "@/lib/coupon-core";
import {
  applyReferralCoupon,
  findReferralCoupon,
  releaseReferralCouponForClosedOrder,
  reserveReferralCoupon,
  resolveCheckoutReferralCode,
} from "@/lib/referrals";

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
  // 没有售后联系方式的店不能收钱：买家找不到人会去支付渠道投诉。
  await assertAgentContactReady(agent.id);

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
      agentHidden: agentPlanPrices.agentHidden,
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
    offer.agentHidden ||
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
  // 税点存坏了只拦开票单（在 quoteCheckoutAmounts 里），不开票的单照常卖
  let invoicePolicy: InvoicePolicy | null = null;
  try {
    invoicePolicy = invoicePolicyFor(agent, await getAgentInvoiceTaxBp());
  } catch (error) {
    console.warn(`[store-order] 代理 ${agent.id} 开票规则无效：${error instanceof Error ? error.message : error}`);
  }

  return {
    agent,
    invoicePolicy,
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
  /** 邀请券要核对下单邮箱。 */
  customerEmail?: string;
}) {
  const checkout = await resolveStoreCheckout(input);
  if (input.invoiceRequested && !checkout.invoicePolicy) {
    throw new Error("这家店暂时不能开票，请取消开票或联系店主。");
  }
  const invoicePolicy = checkout.invoicePolicy ?? LEGACY_INVOICE_POLICY;
  const listGoodsCents = checkout.listGoodsCents;
  let goodsCents = listGoodsCents;
  let discountCents = 0;
  let coupon: Awaited<ReturnType<typeof loadCheckoutCoupon>> | null = null;
  let referralCoupon: Awaited<ReturnType<typeof findReferralCoupon>> = null;
  const code = (input.couponCode || "").trim();
  if (code) {
    // 先按代理手建的券查，查不到再按邀请券查；两种券一单只能用一张。
    referralCoupon = await findReferralCoupon(checkout.agent.id, code);
    if (referralCoupon) {
      const applied = applyReferralCoupon({
        coupon: referralCoupon,
        customerEmail: input.customerEmail,
        planKey: checkout.offer.planKey,
        listGoodsCents,
        costTotalCents: checkout.agentCostTotalCents,
        feeRule: checkout.feeRule,
        invoiceRequested: Boolean(input.invoiceRequested),
        invoicePolicy,
      });
      goodsCents = applied.goodsCents;
      discountCents = applied.discountCents;
    } else {
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
        invoiceRequested: Boolean(input.invoiceRequested),
        invoicePolicy,
      });
      goodsCents = applied.goodsCents;
      discountCents = applied.discountCents;
    }
  }
  const quote = quoteStorePayment({
    goodsCents,
    costTotalCents: checkout.agentCostTotalCents,
    invoiceRequested: Boolean(input.invoiceRequested),
    feeRule: checkout.feeRule,
    invoicePolicy,
  });
  if (quote.earningCents < 0) {
    if (coupon || referralCoupon) {
      throw new Error("这张券用在当前商品上后，扣完通道费会低于成本");
    }
    unavailable(
      `套餐 ${checkout.offer.planKey} 扣手续费后代理收益为负：零售 ${checkout.offer.retailPriceCents}，成本 ${checkout.costCents}，数量 ${checkout.quantity}，手续费 ${quote.feeCents}`,
    );
  }
  return { checkout, invoicePolicy, coupon, referralCoupon, listGoodsCents, goodsCents, discountCents, quote };
}

export async function quoteStoreCheckout(input: {
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  quantity?: number;
  couponCode?: string;
  invoiceRequested?: boolean;
  customerEmail?: string;
}) {
  const priced = await quoteCheckoutAmounts(input);
  return {
    listGoodsCents: priced.listGoodsCents,
    discountCents: priced.discountCents,
    goodsCents: priced.goodsCents,
    surchargeCents: priced.quote.surchargeCents,
    payCents: priced.quote.payCents,
    /** 这家店当前的开票税点（%），结账页提示用。 */
    invoiceRatePct: priced.checkout.invoicePolicy?.ratePct ?? INVOICE_DEFAULT_RATE_PCT,
    couponCode: priced.coupon?.code || priced.referralCoupon?.code || "",
    /** 邀请券：结账页显示「邀请券 立减 ¥x」。 */
    couponKind: priced.referralCoupon ? "referral" : priced.coupon ? "store" : "",
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
  /** 付款后跳回的地址，开放 API 代客下单用；已校验过，可含 {order_no}。不传回本站订单页。 */
  returnUrl?: string;
  /** 邀请链接带进来的邀请码；不是这家店的当没带，是否算有效邀请等发货后再判。 */
  referralCode?: string;
  /**
   * 买家页面上显示的开票税点。和代理现在的税点对不上（页面开着时代理改了税点）就拒单，
   * 免得买家按旧价看、按新价付。不传不核对。
   */
  expectedInvoiceRatePct?: number;
}) {
  await assertStoreSalesOpen();
  const priced = await quoteCheckoutAmounts(input);
  assertInvoiceRateUnchanged({
    invoiceRequested: Boolean(input.invoiceRequested),
    expectedRatePct: input.expectedInvoiceRatePct,
    currentRatePct: priced.invoicePolicy.ratePct,
  });
  const { checkout, coupon, referralCoupon, listGoodsCents, discountCents, quote } = priced;
  const referralCodeId = await resolveCheckoutReferralCode(checkout.agent.id, input.referralCode);
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
          eq(agentPlanPrices.agentHidden, false),
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
  const assertAccountsAvailable = async (conn: Parameters<typeof countUnusedFinishedAccounts>[1]) => {
    const [unused, pending] = await Promise.all([
      countUnusedFinishedAccounts(offer.planKey, conn),
      countPendingStoreAccountClaims(offer.planKey, conn),
    ]);
    if (unused - pending < quantity) {
      throw new Error("这个套餐正在补货中，请稍后再试。");
    }
  };
  if (localAccount) await assertAccountsAvailable(db);

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
        invoicePolicy: priced.invoicePolicy,
      })
    : quote;
  const invoiceSnapshot = invoiceQuote.snapshot;
  const ledger = computeOrderLedger({
    grossCents: invoiceQuote.payCents,
    invoiceSurchargeCents: invoiceSnapshot.invoiceSurchargeCents,
    invoiceSplit: invoiceSnapshot.invoiceSplit,
    invoiceAgentShareCents: invoiceSnapshot.invoiceAgentShareCents,
    invoiceAgentTaxCents: invoiceSnapshot.invoiceAgentTaxCents,
    agentCostTotalCents: checkout.agentCostTotalCents,
    upstreamCostTotalCents: checkout.upstreamCostTotalCents,
    feeRule: checkout.feeRule,
  });

  const orderNo = newOrderNo("KS");
  const queryToken = crypto.randomBytes(24).toString("base64url");
  // 买家跳回的订单页用公网地址；易支付的异步通知走回调地址（可以是不经 Cloudflare 的域名）。
  const [base, callbackBase] = await Promise.all([
    requirePublicBaseUrl(input.request),
    requireCallbackBaseUrl(input.request),
  ]);
  const fulfillmentIdempotencyKey = `kaimi-order-${orderNo}`;
  const createdAt = new Date().toISOString();
  const order = await db.transaction(async (tx) => {
    // 事务里再数一次：上面那次和插入之间可能有别人刚下了单。
    if (localAccount) await assertAccountsAvailable(tx);
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
        ...invoiceSnapshot,
        couponId: coupon?.id ?? null,
        couponCodeSnapshot: coupon?.code ?? referralCoupon?.code ?? "",
        couponKindSnapshot: coupon?.kind ?? (referralCoupon ? "referral" : ""),
        couponPercentSnapshot: coupon?.percentZhe ?? 0,
        couponThresholdCents: coupon?.thresholdCents ?? 0,
        couponAmountSnapshot: coupon?.amountCents ?? (referralCoupon ? discountCents : 0),
        listGoodsCents,
        couponDiscountCents: discountCents,
        referralCodeId,
        referralCouponId: referralCoupon?.id ?? null,
        customerEmail: input.customerEmail.trim().toLowerCase(),
        fulfillmentIdempotencyKey,
        cardplatformAccountId: cardplatform?.id ?? null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    if (!created) throw new Error("订单创建失败");
    if (referralCoupon) await reserveReferralCoupon(tx, referralCoupon.id, created.id);
    return created;
  });

  let payment: Awaited<ReturnType<typeof createEpayPayment>>;
  const buyerIp = clientIp(input.request);
  try {
    payment = await createEpayPayment(epay, {
      outTradeNo: orderNo,
      name: quantity > 1
        ? `${localAccount ? "账号" : "CDK"} ${displayName} ×${quantity}`
        : `${localAccount ? "账号" : "CDK"} ${displayName}`,
      moneyCents: invoiceQuote.payCents,
      notifyUrl: `${callbackBase}/api/webhooks/epay`,
      returnUrl: input.returnUrl
        ? buildReturnUrl(input.returnUrl, orderNo)
        : storeOrderQueryUrl(base, orderNo, queryToken),
      channel: input.channel,
      clientIp: buyerIp === "local" ? undefined : buyerIp,
    });
  } catch (error) {
    // 支付单都没建成，买家付不了款：关掉订单并归还优惠券次数。
    await closeStoreOrder(orderNo).catch((closeError) => {
      console.error(`[store-order] 下单失败后关闭订单 ${orderNo} 也失败`, closeError);
    });
    throw error;
  }
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

/** 未付款订单关闭后的付款状态。 */
export const STORE_ORDER_CLOSED_PAY_STATUS = "closed";
/** 默认未付款订单 30 分钟后关闭。 */
export const STORE_ORDER_UNPAID_TTL_MS = 30 * 60 * 1000;

/**
 * 关闭一笔未付款订单并归还优惠券次数。
 * 条件 update（payStatus=unpaid）+ returning 保证：已付款/已关闭的不动，重复调用只还一次。
 * 返回是否由本次调用关闭。
 */
export async function closeStoreOrder(orderNo: string) {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const closed = await tx
      .update(storeOrders)
      .set({
        payStatus: STORE_ORDER_CLOSED_PAY_STATUS,
        fulfillStatus: "cancelled",
        updatedAt: now,
      })
      .where(and(eq(storeOrders.orderNo, orderNo), eq(storeOrders.payStatus, "unpaid")))
      .returning({ id: storeOrders.id, couponId: storeOrders.couponId, referralCouponId: storeOrders.referralCouponId });
    for (const row of closed) {
      await releaseCouponForTransition(tx, row, "unpaid", STORE_ORDER_CLOSED_PAY_STATUS);
      await releaseReferralCouponForClosedOrder(tx, row);
    }
    return closed.length > 0;
  });
}

/**
 * 批量关闭超时未付款订单并归还优惠券次数。
 * 由 sync-scheduler 每 5 分钟调用一次。
 *
 * 传了 checkPaid 时，关单前逐单向网关补查：支付通知丢了的单会在这里被确认成已付款，
 * 不会被误关；查不清的先留着，超过 STORE_ORDER_GATEWAY_GIVE_UP_MS 才关。
 */
export async function closeExpiredStoreOrders(options: {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  checkPaid?: (orderNo: string) => Promise<GatewayPaidCheck>;
} = {}) {
  const olderThanMs = options.olderThanMs ?? STORE_ORDER_UNPAID_TTL_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  // 要逐单打网关时少取一些，一轮别跑太久。
  const limit = Math.max(1, Math.min(options.limit ?? (options.checkPaid ? 50 : 200), 1000));
  const rows = await db
    .select({ id: storeOrders.id, orderNo: storeOrders.orderNo, createdAt: storeOrders.createdAt })
    .from(storeOrders)
    .where(and(eq(storeOrders.payStatus, "unpaid"), lt(storeOrders.createdAt, cutoff)))
    .orderBy(asc(storeOrders.id))
    .limit(limit);
  const candidates: typeof rows = [];
  // 网关单次查询最多等 15 秒。网关挂了时连着查 50 单会把整个调度器卡住十几分钟，
  // 连续失败 3 次就停，剩下的下一轮再查。
  let consecutiveErrors = 0;
  for (const row of rows) {
    const check = options.checkPaid ? await options.checkPaid(row.orderNo) : null;
    if (shouldCloseUnpaidOrder({ check, createdAt: row.createdAt, now })) candidates.push(row);
    consecutiveErrors = check === "error" ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) break;
  }
  if (!candidates.length) return { closed: 0, couponsReleased: 0 };
  return db.transaction(async (tx) => {
    const closed = await tx
      .update(storeOrders)
      .set({
        payStatus: STORE_ORDER_CLOSED_PAY_STATUS,
        fulfillStatus: "cancelled",
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          inArray(storeOrders.id, candidates.map((row) => row.id)),
          // 再判一次：查完到这里之间可能已经付款
          eq(storeOrders.payStatus, "unpaid"),
          lt(storeOrders.createdAt, cutoff),
        ),
      )
      .returning({ id: storeOrders.id, couponId: storeOrders.couponId, referralCouponId: storeOrders.referralCouponId });
    let couponsReleased = 0;
    for (const row of closed) {
      if (await releaseCouponForTransition(tx, row, "unpaid", STORE_ORDER_CLOSED_PAY_STATUS)) {
        couponsReleased += 1;
      }
      await releaseReferralCouponForClosedOrder(tx, row);
    }
    return { closed: closed.length, couponsReleased };
  });
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
  // 只凭邮箱不给完整订单号和查询凭证：知道别人的邮箱不等于能取走他的卡。
  // 买家要看卡密，用 verifyStoreOrderOwnership 交完整订单号换凭证，或让我们把链接发到邮箱。
  return rows.map((order) => {
    const plan = planByKey.get(order.planKeySnapshot);
    return {
      orderRef: maskOrderNo(order.orderNo),
      productName: order.productNameSnapshot,
      quantity: order.quantity,
      amountCents: order.grossCents,
      payStatus: order.payStatus,
      fulfillStatus: order.fulfillStatus,
      createdAt: order.createdAt,
      paymentCountry: plan?.regionCapable ? order.paymentCountrySnapshot : null,
      regionLabel: plan?.regionCapable ? plan.regionLabel : null,
    };
  });
}

/**
 * 买家交出完整订单号，证明这一单是自己的，换回查询凭证。
 * 邮箱也要对上：只有订单号、却填错邮箱的，当作不存在。
 */
export async function verifyStoreOrderOwnership(input: {
  slug: string;
  email: string;
  orderNo: string;
}) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.currentSlug, normalizeAgentSlug(input.slug)),
    columns: { id: true },
  });
  if (!agent) return null;
  const order = await db.query.storeOrders.findFirst({
    where: and(
      eq(storeOrders.agentId, agent.id),
      eq(storeOrders.orderNo, input.orderNo.trim().toUpperCase()),
      eq(storeOrders.customerEmail, input.email.trim().toLowerCase()),
    ),
    columns: { orderNo: true, queryTokenEncrypted: true },
  });
  if (!order?.queryTokenEncrypted) return null;
  return { orderNo: order.orderNo, queryToken: decryptSecret(order.queryTokenEncrypted) };
}

