import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts, platformPlans } from "@/db/schema";
import { getDefaultCardplatformClient } from "@/lib/cardplatform/config";
import { bootDb } from "@/lib/config";
import { isLocalAccountPlan } from "@/lib/finished-account-core";

export async function syncDefaultCardplatformPlans() {
  await bootDb();
  const { account, client } = await getDefaultCardplatformClient();
  const plans = await client.getPlans();
  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    await tx
      .update(platformPlans)
      .set({ cardplatformSellable: false, updatedAt: now })
      .where(eq(platformPlans.fulfillmentKind, "cardplatform"));
    for (const plan of plans) {
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
            cardplatformRawJson: JSON.stringify(plan.raw),
            syncedAt: now,
            updatedAt: now,
          })
          .where(eq(platformPlans.id, existing.id));
        updated += 1;
      } else {
        await tx.insert(platformPlans).values({
          planKey: plan.key,
          name: plan.name,
          sortOrder: plan.sortOrder,
          enabled: false,
          cardplatformSellable: plan.enabled,
          cardplatformRawJson: JSON.stringify(plan.raw),
          syncedAt: now,
        });
        created += 1;
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
  return { count: plans.length, created, updated };
}
