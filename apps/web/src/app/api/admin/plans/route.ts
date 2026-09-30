import { NextResponse } from "next/server";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPlanPrices, agents, platformPlans } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { MAX_CATEGORY_LENGTH, normalizeCategory } from "@/lib/plan-category";
import { maxRetailPriceError } from "@/lib/plan-price-core";
import { planNameWithRegion } from "@/lib/cardplatform/regions";

/** 分类标签存的就是展示文案，统一收敛空白后入库，前台按它分组 */
const categorySchema = z
  .string()
  .max(MAX_CATEGORY_LENGTH * 2)
  .optional()
  .default("")
  .transform(normalizeCategory);

const planSchema = z.object({
  planKey: z.string().trim().min(1).max(64).regex(/^[a-z0-9_:-]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional().default(""),
  coverUrl: z.string().trim().max(1000).optional().default(""),
  category: categorySchema,
  globalCostPriceCents: z.number().int().min(0),
  maxRetailPriceCents: z.number().int().min(0).nullable().optional(),
  enabled: z.boolean().optional().default(false),
  cardplatformSellable: z.boolean().optional().default(false),
  sortOrder: z.number().int().min(-10000).max(10000).optional().default(0),
  // 地区语义由卡台同步生成，不接受手工改。
  regionLabel: z.string().trim().max(20).optional(),
  regionNote: z.string().trim().max(40).optional(),
});

async function authorize() {
  try {
    await requireAdmin();
    return null;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function GET() {
  const denied = await authorize();
  if (denied) return denied;
  await bootDb();
  const list = await db.query.platformPlans.findMany({
    orderBy: [asc(platformPlans.sortOrder), asc(platformPlans.id)],
  });
  return NextResponse.json({ list });
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = planSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const capError = maxRetailPriceError(
    data.maxRetailPriceCents ?? null,
    data.globalCostPriceCents,
  );
  if (capError) return NextResponse.json({ error: capError }, { status: 400 });
  const now = new Date().toISOString();
  const existing = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.planKey, data.planKey),
  });
  if (existing) {
    await db
      .update(platformPlans)
      .set({ ...data, updatedAt: now })
      .where(eq(platformPlans.id, existing.id));
  } else {
    await db.insert(platformPlans).values(data);
  }
  const plan = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.planKey, data.planKey),
  });
  await writeAuditLog({
    actor: session,
    action: existing ? "admin.plan.update" : "admin.plan.create",
    targetType: "platform_plan",
    targetId: plan?.id,
    metadata: { planKey: data.planKey, cardplatformSellable: data.cardplatformSellable },
  });
  return NextResponse.json({ plan }, { status: existing ? 200 : 201 });
}

const batchSchema = z.object({
  plans: z.array(
    z.object({
      planKey: z.string().trim().min(1),
      name: z.string().trim().min(1).max(100).optional(),
      category: categorySchema,
      regionLabel: z.string().trim().max(20).optional(),
      regionNote: z.string().trim().max(40).optional(),
      globalCostPriceCents: z.number().int().min(0),
      upstreamCostCents: z.number().int().min(0).nullable().optional(),
      maxRetailPriceCents: z.number().int().min(0).nullable().optional(),
      enabled: z.boolean(),
    }),
  ),
});

export async function PUT(req: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const parsed = batchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "套餐格式无效" }, { status: 400 });
  }
  // 成本价和限价在同一张表里改，任何一边都可能把区间压反，所以整批先校验再落库。
  const existingPlans = await db.query.platformPlans.findMany();
  const existingByKey = new Map(existingPlans.map((plan) => [plan.planKey, plan]));
  for (const item of parsed.data.plans) {
    const existing = existingByKey.get(item.planKey);
    if (existing && existing.paymentCountry && item.enabled && item.globalCostPriceCents <= 0) {
      const label = planNameWithRegion(
        existing.name,
        true,
        existing.paymentCountry,
        item.regionLabel ?? existing.regionLabel,
      );
      return NextResponse.json(
        { error: `${label}：请先填默认成本再启用` },
        { status: 400 },
      );
    }
  }
  for (const item of parsed.data.plans) {
    const capError = maxRetailPriceError(
      item.maxRetailPriceCents ?? null,
      item.globalCostPriceCents,
    );
    if (capError) {
      return NextResponse.json(
        { error: `${item.name || item.planKey}：${capError}` },
        { status: 400 },
      );
    }
  }
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const item of parsed.data.plans) {
      const existing = await tx.query.platformPlans.findFirst({
        where: eq(platformPlans.planKey, item.planKey),
      });
      if (!existing) continue;
      await tx
        .update(platformPlans)
        .set({
          name: item.name || existing.name,
          category: item.category,
          ...(item.regionLabel !== undefined ? { regionLabel: item.regionLabel } : {}),
          ...(item.regionNote !== undefined ? { regionNote: item.regionNote } : {}),
          globalCostPriceCents: item.globalCostPriceCents,
          ...(item.upstreamCostCents !== undefined
            ? { upstreamCostCents: item.upstreamCostCents }
            : {}),
          maxRetailPriceCents: item.maxRetailPriceCents ?? null,
          enabled: item.enabled,
          updatedAt: now,
        })
        .where(eq(platformPlans.id, existing.id));
    }
  });
  const warnings: string[] = [];
  for (const item of parsed.data.plans) {
    if (
      item.upstreamCostCents != null &&
      item.upstreamCostCents > item.globalCostPriceCents
    ) {
      const existing = existingByKey.get(item.planKey);
      const label = existing
        ? planNameWithRegion(existing.name, existing.regionCapable, existing.paymentCountry, item.regionLabel ?? existing.regionLabel)
        : item.name || item.planKey;
      warnings.push(`${label}：上游进价高于默认成本，按这个价卖平台会亏`);
      if (existing?.paymentCountry) {
        const base = existingByKey.get(existing.basePlanKey);
        if (base && base.globalCostPriceCents > 0 && item.globalCostPriceCents < base.globalCostPriceCents) {
          warnings.push(`${label}：成本比菲区还低，确认没填错？`);
        }
      }
    }
  }
  const cheap = await db
    .select({
      agentName: agents.displayName,
      planName: platformPlans.name,
      upstreamCostCents: platformPlans.upstreamCostCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .innerJoin(agents, eq(agents.id, agentPlanPrices.agentId))
    .where(and(eq(agents.status, "active"), isNotNull(platformPlans.upstreamCostCents)))
    .limit(20);
  for (const row of cheap) {
    const cost = row.costOverrideCents ?? row.globalCostPriceCents;
    if (row.upstreamCostCents != null && cost < row.upstreamCostCents) {
      warnings.push(`${row.agentName} 的 ${row.planName} 成本低于上游进价`);
    }
  }
  await writeAuditLog({
    actor: session,
    action: "admin.plan.batch",
    targetType: "platform_plan",
    metadata: { count: parsed.data.plans.length },
  });
  return NextResponse.json({ ok: true, warnings: warnings.slice(0, 20) });
}
