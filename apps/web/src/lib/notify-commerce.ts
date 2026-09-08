import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, issuedCdks, orders, storeOrders } from "@/db/schema";
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
        columns: { displayName: true },
      })
    : null;

  const quantity = Math.max(1, store?.quantity ?? 1);
  const plan = store?.productNameSnapshot || order.upstreamPlan || "";
  return {
    agentName: agent?.displayName || "",
    account: (order.accountEmail || "").trim(),
    plan: plan || undefined,
    retailCents: store?.retailPriceCents,
    platformCents: store?.agentCostCents,
    agentEarningCents: store
      ? Math.round(store.agentEarningCents / quantity)
      : undefined,
  };
}
