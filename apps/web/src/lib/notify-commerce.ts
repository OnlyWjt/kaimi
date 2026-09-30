import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, issuedCdks, orders, platformPlans, storeOrders } from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { planNameWithRegion } from "@/lib/cardplatform/regions";
import type { NotifyPayload } from "@/lib/notify-core";

/** 用兑换单号找回代理店、开通账号、售价和这一张的收益。 */
export async function loadRedeemNotifyContext(orderNo: string): Promise<Partial<NotifyPayload>> {
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
  });
  if (!order) return {};

  const issued = await db.query.issuedCdks.findFirst({
    where: eq(issuedCdks.redemptionOrderId, order.id),
  });
  const store = issued
    ? await db.query.storeOrders.findFirst({
        where: eq(storeOrders.id, issued.orderId),
      })
    : null;
  const agentId = store?.agentId ?? issued?.agentId;
  const agent = agentId
    ? await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
        columns: { displayName: true, shopName: true },
      })
    : null;

  const quantity = Math.max(1, store?.quantity ?? 1);
  // 提卡来的卡没有商城订单，套餐名从套餐表拼，带上地区。
  const drawPlan = !store && issued
    ? await db.query.platformPlans.findFirst({
        where: eq(platformPlans.planKey, issued.planKey),
      })
    : null;
  const plan = store?.productNameSnapshot
    || (drawPlan
      ? planNameWithRegion(drawPlan.name, drawPlan.regionCapable, issued?.paymentCountry || "", drawPlan.regionLabel)
      : "")
    || order.upstreamPlan
    || "";
  const goodsCents = store ? Math.max(0, store.grossCents - (store.invoiceSurchargeCents || 0)) : undefined;
  const listGoodsCents =
    store && store.listGoodsCents > 0 ? store.listGoodsCents : goodsCents;
  let cardIndex: number | undefined;
  if (store && issued && quantity > 1) {
    const siblings = await db.query.issuedCdks.findMany({
      where: eq(issuedCdks.orderId, store.id),
      columns: { id: true },
      orderBy: [asc(issuedCdks.id)],
    });
    const index = siblings.findIndex((row) => row.id === issued.id);
    if (index >= 0) cardIndex = index + 1;
  }
  return {
    agentName: agent ? publicShopName(agent) : "",
    account: (order.accountEmail || "").trim(),
    plan: plan || undefined,
    quantity,
    cardIndex,
    listGoodsCents,
    couponCode: store?.couponCodeSnapshot || undefined,
    couponDiscountCents: store?.couponDiscountCents || undefined,
    goodsCents,
    agentCostTotalCents: store?.agentCostTotalCents,
    agentFeeCents: store?.agentFeeCents,
    agentEarningCents: store?.agentEarningCents,
    upstreamCostTotalCents: store?.upstreamCostTotalCents,
    platformProfitCents: store?.platformProfitCents,
  };
}
