import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { issuedCdks, platformPlans } from "@/db/schema";
import { regionDisplay } from "@/lib/cardplatform/regions";

type RegionPlan = { regionCapable: boolean; regionLabel: string };

export type OpenRegion = { code: string; name: string; name_en: string } | null;

/** 和 /orders/{orderNo} 的 region 同格式。套餐没有地区概念时为 null，不能只看 payment_country 是否为空（空串 = 菲区）。 */
export function openRegion(paymentCountry: string, plan: RegionPlan | null | undefined): OpenRegion {
  if (!plan?.regionCapable) return null;
  const region = regionDisplay(paymentCountry, plan.regionLabel);
  return { code: region.code, name: region.zh, name_en: region.en };
}

/** 一次查出多张卡用到的套餐地区配置。 */
export async function loadRegionPlans(planKeys: string[]) {
  const keys = [...new Set(planKeys.filter(Boolean))];
  if (!keys.length) return new Map<string, RegionPlan>();
  const rows = await db
    .select({
      planKey: platformPlans.planKey,
      regionCapable: platformPlans.regionCapable,
      regionLabel: platformPlans.regionLabel,
    })
    .from(platformPlans)
    .where(inArray(platformPlans.planKey, keys));
  return new Map(rows.map((row) => [row.planKey, row]));
}

/** 兑换单上的卡（商城卖的或提卡来的）实际付款地区。查不到卡时 payment_country 为 null。 */
export async function redemptionRegionFields(issuedCdkId: number | null | undefined) {
  const issued = issuedCdkId
    ? await db.query.issuedCdks.findFirst({
        where: eq(issuedCdks.id, issuedCdkId),
        columns: { planKey: true, paymentCountry: true },
      })
    : null;
  if (!issued) return { payment_country: null, region: null as OpenRegion };
  const plans = await loadRegionPlans([issued.planKey]);
  return {
    payment_country: issued.paymentCountry,
    region: openRegion(issued.paymentCountry, plans.get(issued.planKey)),
  };
}
