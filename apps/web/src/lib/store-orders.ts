import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agentPlanPrices,
  agents,
  paymentChannelConfigs,
  platformPlans,
  storeOrders,
} from "@/db/schema";
import { normalizeAgentSlug } from "@/lib/agent-slug";
import { encryptSecret, hashLookupValue } from "@/lib/crypto";
import { newOrderNo } from "@/lib/ids";
import { getDefaultCardplatformAccount } from "@/lib/cardplatform/config";
import { createEpayPayment } from "@/lib/payments/epay";
import { epayReady, getEpayConfig } from "@/lib/payments/config";
import {
  calculateAgentEarningCents,
  calculatePaymentFeeCents,
  type PaymentChannel,
} from "@/lib/payments/fees";
import { assertStoreSalesOpen } from "@/lib/ops-health";
import { getPublicBaseUrl } from "@/lib/public-url";

async function publicBaseFromRequest(req: Request) {
  const base = await getPublicBaseUrl(req);
  if (base) return base;
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 KAIMI_PUBLIC_BASE_URL");
  }
  return "http://localhost:3100";
}

export async function createStoreOrder(input: {
  request: Request;
  slug: string;
  planKey: string;
  channel: PaymentChannel;
  customerEmail: string;
}) {
  const agent = await db.query.agents.findFirst({
    where: and(
      eq(agents.currentSlug, normalizeAgentSlug(input.slug)),
      eq(agents.status, "active"),
    ),
  });
  if (!agent) throw new Error("店铺不存在或已关闭");
  await assertStoreSalesOpen();

  const [offer] = await db
    .select({
      planId: platformPlans.id,
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      cardplatformSellable: platformPlans.cardplatformSellable,
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
  if (!offer || !offer.assignmentEnabled || !offer.cardplatformSellable) {
    throw new Error("该套餐暂不可购买");
  }

  const costCents =
    offer.costOverrideCents ?? offer.globalCostPriceCents;
  if (costCents <= 0 || offer.retailPriceCents < costCents) {
    throw new Error("商品价格配置无效");
  }
  const channelConfig = await db.query.paymentChannelConfigs.findFirst({
    where: and(
      eq(paymentChannelConfigs.channel, input.channel),
      eq(paymentChannelConfigs.enabled, true),
    ),
  });
  if (!channelConfig) throw new Error("该支付方式未开通");
  const cardplatform = await getDefaultCardplatformAccount();
  if (!cardplatform) throw new Error("卡台未配置，暂不能下单");

  const epay = await getEpayConfig();
  if (!epayReady(epay)) throw new Error("易支付未配置，暂不能下单");

  const estimatedFeeCents = calculatePaymentFeeCents(
    offer.retailPriceCents,
    {
      ratePpm: channelConfig.feeRatePpm,
      fixedFeeCents: channelConfig.fixedFeeCents,
    },
  );
  const earningCents = calculateAgentEarningCents(
    offer.retailPriceCents,
    costCents,
    estimatedFeeCents,
  );
  if (earningCents < 0) throw new Error("当前价格扣除手续费后收益为负，商品已暂停");

  const orderNo = newOrderNo("KS");
  const queryToken = crypto.randomBytes(24).toString("base64url");
  const base = await publicBaseFromRequest(input.request);
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
      productNameSnapshot: offer.name,
      retailPriceCents: offer.retailPriceCents,
      agentCostCents: costCents,
      paymentChannel: input.channel,
      feeRatePpm: channelConfig.feeRatePpm,
      fixedFeeCents: channelConfig.fixedFeeCents,
      estimatedPaymentFeeCents: estimatedFeeCents,
      finalPaymentFeeCents: estimatedFeeCents,
      agentEarningCents: earningCents,
      customerEmail: input.customerEmail.trim().toLowerCase(),
      fulfillmentIdempotencyKey,
      cardplatformAccountId: cardplatform.id,
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  if (!order) throw new Error("订单创建失败");

  const payment = await createEpayPayment(epay, {
    outTradeNo: orderNo,
    name: `CDK ${offer.name}`,
    moneyCents: offer.retailPriceCents,
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
