import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPlanPrices, platformPlans } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAgent } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { retailPriceError } from "@/lib/plan-price-core";

// 两个字段至少带一个：改零售价，或在店里上架 / 下架。
const updateSchema = z
  .object({
    retailPriceCents: z.number().int().min(0).optional(),
    hidden: z.boolean().optional(),
  })
  .refine((body) => body.retailPriceCents !== undefined || body.hidden !== undefined);

export async function PATCH(
  req: Request,
  context: { params: Promise<{ planKey: string }> },
) {
  let session;
  try {
    session = await requireAgent();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();

  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { planKey } = await context.params;
  const [assignment] = await db
    .select({
      id: agentPlanPrices.id,
      enabled: agentPlanPrices.enabled,
      agentHidden: agentPlanPrices.agentHidden,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      maxRetailPriceCents: platformPlans.maxRetailPriceCents,
      planEnabled: platformPlans.enabled,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, session.agentId),
        eq(platformPlans.planKey, planKey),
      ),
    )
    .limit(1);

  if (!assignment || !assignment.enabled || !assignment.planEnabled) {
    return NextResponse.json({ error: "该套餐未向当前代理开放" }, { status: 404 });
  }
  // 下架的套餐不卖，零售价随便填（包括 0）都不拦；上架时才要求价格合法。
  const hidden = parsed.data.hidden ?? assignment.agentHidden;
  if (parsed.data.retailPriceCents !== undefined && !hidden) {
    const priceError = retailPriceError(parsed.data.retailPriceCents, {
      costPriceCents:
        assignment.costOverrideCents ?? assignment.globalCostPriceCents,
      maxRetailPriceCents: assignment.maxRetailPriceCents,
    });
    if (priceError) {
      return NextResponse.json({ error: priceError }, { status: 400 });
    }
  }

  await db
    .update(agentPlanPrices)
    .set({
      ...(parsed.data.retailPriceCents !== undefined ? { retailPriceCents: parsed.data.retailPriceCents } : {}),
      ...(parsed.data.hidden !== undefined ? { agentHidden: parsed.data.hidden } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentPlanPrices.id, assignment.id));
  if (parsed.data.hidden !== undefined && parsed.data.hidden !== assignment.agentHidden) {
    await writeAuditLog({
      actor: session,
      action: parsed.data.hidden ? "agent.plan.hide" : "agent.plan.show",
      targetType: "agent_plan_price",
      targetId: assignment.id,
      metadata: { planKey },
    });
  }

  return NextResponse.json({ ok: true });
}
