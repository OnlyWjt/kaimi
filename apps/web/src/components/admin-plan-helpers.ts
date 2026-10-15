import { groupPlansByBase, regionDisplay } from "@/lib/cardplatform/regions";
import { isLocalAccountPlan } from "@/lib/finished-account-core";
import { centsFromYuanText } from "@/lib/money";

/** 后台「套餐定价」和「代理管理」共用的套餐分组小件。 */

export type RegionFields = {
  basePlanKey?: string;
  paymentCountry?: string;
  regionLabel?: string;
  regionCapable?: boolean;
  regionNote?: string;
  sortOrder?: number;
};

export const PLAN_SHELVES = ["全部", "会员", "续费", "点数", "成品号"] as const;
export type PlanShelf = (typeof PLAN_SHELVES)[number];

export function planShelf(plan: { name: string; planKey: string; fulfillmentKind?: string }): Exclude<PlanShelf, "全部"> {
  if (isLocalAccountPlan(plan) || /成品/.test(plan.name)) return "成品号";
  if (/续费|renew/i.test(`${plan.name} ${plan.planKey}`)) return "续费";
  if (/点数|credit/i.test(`${plan.name} ${plan.planKey}`)) return "点数";
  return "会员";
}

export function withRegion<T extends { planKey: string; name: string } & RegionFields>(plans: T[]) {
  return plans.map((plan) => ({
    ...plan,
    basePlanKey: plan.basePlanKey || "",
    paymentCountry: plan.paymentCountry || "",
    regionLabel: plan.regionLabel || "",
    regionCapable: Boolean(plan.regionCapable),
    sortOrder: plan.sortOrder ?? 0,
  }));
}

export function allowedPlanLabels(plans: Array<{ planKey: string; name: string } & RegionFields>) {
  return groupPlansByBase(withRegion(plans)).map((group) => {
    if (!group.plans.some((plan) => plan.regionCapable)) return group.primary.name;
    const regions = group.plans.map((plan) => regionDisplay(plan.paymentCountry, plan.regionLabel).zh);
    return `${group.primary.name}（${regions.join("/")}）`;
  });
}

export function regionTone(cost: string, enabled: boolean) {
  const cents = centsFromYuanText(cost);
  const priced = cents != null && cents > 0;
  if (!priced) return { text: "待定价", tone: "text-amber-700 bg-amber-50" };
  if (enabled) return { text: "已启用", tone: "text-emerald-800 bg-emerald-50" };
  return { text: "未启用", tone: "text-[var(--km-fg-muted)] bg-[var(--km-bg-muted)]" };
}

export function sellableLabel(plan: {
  planKey: string;
  fulfillmentKind?: string;
  cardplatformSellable: boolean;
  paymentCountry?: string;
}) {
  if (isLocalAccountPlan(plan)) return "本地库存";
  if (plan.cardplatformSellable) return "可售";
  return plan.paymentCountry ? "卡台已停售" : "不可售";
}
