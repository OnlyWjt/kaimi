import { and, asc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { agentPlanPrices, paymentChannelConfigs, platformPlans } from "@/db/schema";
import { groupPlansByBase, regionConfirmationRequired } from "@/lib/cardplatform/regions";
import { LOCAL_ACCOUNT_FULFILLMENT } from "@/lib/finished-account-core";
import { unusedFinishedAccountCounts } from "@/lib/finished-accounts";

/**
 * 代理店里真正能下单的套餐。店铺页和开放 API 共用这一份判断，
 * 免得列表上看得到、一下单就报「买不了」。
 *
 * 条件和 createStoreOrder 对齐：分配启用、平台启用、卡台可售或本地成品号、
 * 零售价大于 0 且不低于成本。
 */
export async function loadAgentSellablePlans(agentId: number) {
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      basePlanKey: platformPlans.basePlanKey,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
      regionNote: platformPlans.regionNote,
      sortOrder: platformPlans.sortOrder,
      name: platformPlans.name,
      description: platformPlans.description,
      category: platformPlans.category,
      fulfillmentKind: platformPlans.fulfillmentKind,
      cardplatformSellable: platformPlans.cardplatformSellable,
      retailPriceCents: agentPlanPrices.retailPriceCents,
      coverUrl: agentPlanPrices.coverUrl,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, agentId),
        eq(agentPlanPrices.enabled, true),
        eq(platformPlans.enabled, true),
        or(
          eq(platformPlans.cardplatformSellable, true),
          eq(platformPlans.fulfillmentKind, LOCAL_ACCOUNT_FULFILLMENT),
        ),
      ),
    )
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));

  // 下单时的地区确认按「卡台可售」的同组套餐数算，不看零售价，这里照抄。
  const regionGroupSize = new Map<string, number>();
  for (const group of groupPlansByBase(rows.filter((row) => row.cardplatformSellable))) {
    regionGroupSize.set(group.baseKey, group.plans.length);
  }

  const sellable = rows.filter((row) => {
    const costCents = row.costOverrideCents ?? row.globalCostPriceCents;
    return row.retailPriceCents > 0 && row.retailPriceCents >= costCents;
  });
  const unusedByPlan = await unusedFinishedAccountCounts(
    sellable
      .filter((row) => row.fulfillmentKind === LOCAL_ACCOUNT_FULFILLMENT)
      .map((row) => row.planKey),
  );
  return sellable.map((row) => {
    const localAccount = row.fulfillmentKind === LOCAL_ACCOUNT_FULFILLMENT;
    const baseKey = row.basePlanKey || row.planKey;
    return {
      ...row,
      costCents: row.costOverrideCents ?? row.globalCostPriceCents,
      localAccount,
      available: localAccount ? (unusedByPlan.get(row.planKey) || 0) > 0 : true,
      /** 本地成品号的剩余库存；卡台发卡没有库存概念，为 null。 */
      stock: localAccount ? unusedByPlan.get(row.planKey) || 0 : null,
      regionConfirmationRequired:
        row.regionCapable && regionConfirmationRequired(regionGroupSize.get(baseKey) ?? 1),
    };
  });
}

export type AgentSellablePlan = Awaited<ReturnType<typeof loadAgentSellablePlans>>[number];

export async function enabledPaymentChannels() {
  return (
    await db.query.paymentChannelConfigs.findMany({
      where: eq(paymentChannelConfigs.enabled, true),
    })
  )
    .map((row) => row.channel)
    .filter(
      (channel): channel is "alipay" | "wxpay" =>
        channel === "alipay" || channel === "wxpay",
    );
}
