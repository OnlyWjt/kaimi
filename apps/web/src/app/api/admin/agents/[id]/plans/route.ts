import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPlanPrices, agents, platformPlans } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const batchSchema = z.object({
  plans: z.array(
    z.object({
      planKey: z.string().trim().min(1),
      enabled: z.boolean(),
      costOverrideCents: z.number().int().min(0).nullable().optional(),
    }),
  ),
});

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const agentId = Number((await context.params).id);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "代理 ID 无效" }, { status: 400 });
  }
  const plans = await db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      platformEnabled: platformPlans.enabled,
      cardplatformSellable: platformPlans.cardplatformSellable,
      enabled: agentPlanPrices.enabled,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      retailPriceCents: agentPlanPrices.retailPriceCents,
    })
    .from(platformPlans)
    .leftJoin(
      agentPlanPrices,
      and(
        eq(agentPlanPrices.planId, platformPlans.id),
        eq(agentPlanPrices.agentId, agentId),
      ),
    )
    .orderBy(asc(platformPlans.sortOrder), asc(platformPlans.id));
  return NextResponse.json({
    list: plans.map((plan) => ({
      ...plan,
      enabled: plan.enabled ?? false,
      retailPriceCents:
        plan.retailPriceCents ??
        plan.costOverrideCents ??
        plan.globalCostPriceCents,
    })),
  });
}

export async function PUT(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const agentId = Number((await context.params).id);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return NextResponse.json({ error: "代理 ID 无效" }, { status: 400 });
  }
  const parsed = batchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "套餐格式无效" }, { status: 400 });
  }
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  if (!agent) return NextResponse.json({ error: "代理不存在" }, { status: 404 });
  const catalog = await db.query.platformPlans.findMany();
  const byKey = new Map(catalog.map((item) => [item.planKey, item]));
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const item of parsed.data.plans) {
      const plan = byKey.get(item.planKey);
      if (!plan) continue;
      const existing = await tx.query.agentPlanPrices.findFirst({
        where: and(
          eq(agentPlanPrices.agentId, agentId),
          eq(agentPlanPrices.planId, plan.id),
        ),
      });
      const cost = item.costOverrideCents ?? null;
      const values = {
        enabled: item.enabled,
        costOverrideCents: cost,
        updatedAt: now,
      };
      if (existing) {
        await tx
          .update(agentPlanPrices)
          .set(values)
          .where(eq(agentPlanPrices.id, existing.id));
      } else {
        await tx.insert(agentPlanPrices).values({
          agentId,
          planId: plan.id,
          retailPriceCents: cost ?? plan.globalCostPriceCents,
          ...values,
        });
      }
    }
  });
  return NextResponse.json({ ok: true });
}
