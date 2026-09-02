import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts, platformPlans } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { getDefaultCardplatformClient } from "@/lib/cardplatform/config";
import { bootDb } from "@/lib/config";

export async function POST() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  try {
    const { account, client } = await getDefaultCardplatformClient();
    const plans = await client.getPlans();
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(platformPlans)
        .set({ cardplatformSellable: false, updatedAt: now });
      for (const plan of plans) {
        const existing = await tx.query.platformPlans.findFirst({
          where: eq(platformPlans.planKey, plan.key),
        });
        if (existing) {
          await tx
            .update(platformPlans)
            .set({
              name: existing.name || plan.name,
              cardplatformSellable: plan.enabled,
              cardplatformRawJson: JSON.stringify(plan.raw),
              syncedAt: now,
              updatedAt: now,
            })
            .where(eq(platformPlans.id, existing.id));
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
        }
      }
      await tx
        .update(cardplatformAccounts)
        .set({
          lastHealthAt: now,
          lastPlansSyncAt: now,
          lastError: "",
          updatedAt: now,
        })
        .where(eq(cardplatformAccounts.id, account.id));
    });
    return NextResponse.json({ ok: true, count: plans.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "套餐同步失败" },
      { status: 502 },
    );
  }
}
