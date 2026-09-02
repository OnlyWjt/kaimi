import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { platformPlans } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const planSchema = z.object({
  planKey: z.string().trim().min(1).max(64).regex(/^[a-z0-9_:-]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional().default(""),
  coverUrl: z.string().trim().max(1000).optional().default(""),
  globalCostPriceCents: z.number().int().min(0),
  enabled: z.boolean().optional().default(false),
  cardplatformSellable: z.boolean().optional().default(false),
  sortOrder: z.number().int().min(-10000).max(10000).optional().default(0),
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
