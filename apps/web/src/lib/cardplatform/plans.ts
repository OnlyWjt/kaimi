import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts, platformPlans } from "@/db/schema";
import { getDefaultCardplatformClient } from "@/lib/cardplatform/config";
import { supportsPaymentCountry } from "./protocol";
import {
  parseRegionWhitelist,
  paymentRegionsSettingKey,
  planRegionCapable,
  REGION_WHITELIST_SETTING,
  variantPlanKey,
} from "@/lib/cardplatform/regions";
import { bootDb, getSetting, setSetting } from "@/lib/config";
import { isLocalAccountPlan } from "@/lib/finished-account-core";

export async function syncDefaultCardplatformPlans() {
  await bootDb();
  const { account, client } = await getDefaultCardplatformClient();
  const { plans, regions } = await client.getPlansWithRegions();
  // 环境变量账户（id 0）按旧台协议处理；Avanfinity 没有付款地区。
  const protocol = "protocol" in account ? account.protocol : "";
  const regionSupported = account.id === 0 || supportsPaymentCountry(protocol);
  const activeRegions = regionSupported ? regions : [];
  const now = new Date().toISOString();
  const whitelist = new Set(
    parseRegionWhitelist(await getSetting(REGION_WHITELIST_SETTING, "US,CL")),
  );

  await setSetting(
    paymentRegionsSettingKey(account.id),
    JSON.stringify({ syncedAt: now, regions: activeRegions }),
  );

  let created = 0;
  let updated = 0;
  let variantsCreated = 0;
  await db.transaction(async (tx) => {
    await tx
      .update(platformPlans)
      .set({ cardplatformSellable: false, updatedAt: now })
      .where(eq(platformPlans.fulfillmentKind, "cardplatform"));
    for (const plan of plans) {
      const regionCapable = planRegionCapable(plan);
      const existing = await tx.query.platformPlans.findFirst({
        where: eq(platformPlans.planKey, plan.key),
      });
      if (existing) {
        if (isLocalAccountPlan(existing)) continue;
        await tx
          .update(platformPlans)
          .set({
            name: existing.name || plan.name,
            sortOrder: plan.sortOrder,
            cardplatformSellable: plan.enabled,
            regionCapable,
            // 老行一次性回填分组键，幂等。
            ...(existing.basePlanKey ? {} : { basePlanKey: plan.key, upstreamPlanKey: plan.key }),
            cardplatformRawJson: JSON.stringify(plan.raw),
            syncedAt: now,
            updatedAt: now,
          })
          .where(eq(platformPlans.id, existing.id));
        updated += 1;
      } else {
        await tx.insert(platformPlans).values({
          planKey: plan.key,
          basePlanKey: plan.key,
          upstreamPlanKey: plan.key,
          regionCapable,
          name: plan.name,
          sortOrder: plan.sortOrder,
          enabled: false,
          cardplatformSellable: plan.enabled,
          cardplatformRawJson: JSON.stringify(plan.raw),
          syncedAt: now,
        });
        created += 1;
      }

      if (!regionCapable) continue;
      for (const region of activeRegions) {
        const key = variantPlanKey(plan.key, region.country);
        const variant = await tx.query.platformPlans.findFirst({
          where: eq(platformPlans.planKey, key),
        });
        if (variant) {
          await tx
            .update(platformPlans)
            .set({
              cardplatformSellable: plan.enabled,
              sortOrder: plan.sortOrder,
              cardplatformRawJson: JSON.stringify(plan.raw),
              syncedAt: now,
              updatedAt: now,
            })
            .where(eq(platformPlans.id, variant.id));
        } else if (whitelist.has(region.country)) {
          await tx.insert(platformPlans).values({
            planKey: key,
            basePlanKey: plan.key,
            upstreamPlanKey: plan.key,
            paymentCountry: region.country,
            regionCapable: true,
            name: plan.name,
            sortOrder: plan.sortOrder,
            enabled: false,
            globalCostPriceCents: 0,
            cardplatformSellable: plan.enabled,
            cardplatformRawJson: JSON.stringify(plan.raw),
            syncedAt: now,
          });
          variantsCreated += 1;
        }
      }
    }
    if (account.id > 0) {
      await tx
        .update(cardplatformAccounts)
        .set({
          lastHealthAt: now,
          lastPlansSyncAt: now,
          lastError: "",
          updatedAt: now,
        })
        .where(eq(cardplatformAccounts.id, account.id));
    }
  });
  return {
    count: plans.length,
    created,
    updated,
    regions: activeRegions.map((region) => region.country),
    variantsCreated,
  };
}
