import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agents,
  agentSettlements,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { newOrderNo } from "@/lib/ids";
import { periodBoundary } from "@/lib/period";

const createSchema = z.object({
  agentId: z.number().int().positive(),
  periodStart: z.string().trim().min(10).max(40),
  periodEnd: z.string().trim().min(10).max(40),
  notes: z.string().trim().max(500).optional().default(""),
});

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const list = await db
    .select({
      id: agentSettlements.id,
      settlementNo: agentSettlements.settlementNo,
      agentId: agentSettlements.agentId,
      agentName: agents.displayName,
      periodStart: agentSettlements.periodStart,
      periodEnd: agentSettlements.periodEnd,
      amountCents: agentSettlements.amountCents,
      status: agentSettlements.status,
      paymentMethod: agentSettlements.paymentMethod,
      paymentReference: agentSettlements.paymentReference,
      createdAt: agentSettlements.createdAt,
      paidAt: agentSettlements.paidAt,
    })
    .from(agentSettlements)
    .innerJoin(agents, eq(agents.id, agentSettlements.agentId))
    .orderBy(desc(agentSettlements.id))
    .limit(200);
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
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  let periodStart: string;
  let periodEnd: string;
  try {
    periodStart = periodBoundary(data.periodStart, false);
    periodEnd = periodBoundary(data.periodEnd, true);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算周期格式无效" },
      { status: 400 },
    );
  }
  if (periodStart > periodEnd) {
    return NextResponse.json({ error: "结算开始时间不能晚于结束时间" }, { status: 400 });
  }

  try {
  const result = await db.transaction(async (tx) => {
    const earningRows = await tx
      .select({
        id: agentEarnings.id,
        earningCents: agentEarnings.earningCents,
      })
      .from(agentEarnings)
      .innerJoin(storeOrders, eq(storeOrders.id, agentEarnings.orderId))
      .where(
        and(
          eq(agentEarnings.agentId, data.agentId),
          eq(agentEarnings.status, "pending"),
          isNull(agentEarnings.settlementId),
          gte(agentEarnings.confirmedAt, periodStart),
          lte(agentEarnings.confirmedAt, periodEnd),
          inArray(storeOrders.feeReconcileStatus, [
            "confirmed",
            "unsupported",
          ]),
          eq(storeOrders.fulfillStatus, "delivered"),
        ),
      );
    const adjustmentRows = await tx
      .select({
        id: agentEarningAdjustments.id,
        amountCents: agentEarningAdjustments.amountCents,
      })
      .from(agentEarningAdjustments)
      .where(
        and(
          eq(agentEarningAdjustments.agentId, data.agentId),
          eq(agentEarningAdjustments.status, "pending"),
          isNull(agentEarningAdjustments.settlementId),
          lte(agentEarningAdjustments.createdAt, periodEnd),
        ),
      );
    if (!earningRows.length && !adjustmentRows.length) {
      throw new Error("该时间范围没有待结算收益或调整项");
    }
    const amountCents =
      earningRows.reduce((sum, row) => sum + row.earningCents, 0) +
      adjustmentRows.reduce((sum, row) => sum + row.amountCents, 0);
    if (amountCents <= 0) {
      throw new Error(
        `待结算净收益为 ${(amountCents / 100).toFixed(2)} 元。退款倒扣已结转到后续周期，请等有正收益后再生成结算单`,
      );
    }
    const now = new Date().toISOString();
    const [settlement] = await tx
      .insert(agentSettlements)
      .values({
        settlementNo: newOrderNo("ST"),
        agentId: data.agentId,
        periodStart,
        periodEnd,
        amountCents,
        status: "pending_payment",
        notes: data.notes,
        createdBy: session.id,
        createdAt: now,
      })
      .returning();
    if (!settlement) throw new Error("结算单创建失败");
    if (earningRows.length) {
      const claimedEarnings = await tx
        .update(agentEarnings)
        .set({
          settlementId: settlement.id,
          status: "settling",
          updatedAt: now,
        })
        .where(
          and(
            inArray(agentEarnings.id, earningRows.map((row) => row.id)),
            eq(agentEarnings.status, "pending"),
            isNull(agentEarnings.settlementId),
          ),
        )
        .returning({ id: agentEarnings.id });
      if (claimedEarnings.length !== earningRows.length) {
        throw new Error("部分收益状态已变化，请刷新后重试");
      }
    }
    if (adjustmentRows.length) {
      const claimedAdjustments = await tx
        .update(agentEarningAdjustments)
        .set({
          settlementId: settlement.id,
          status: "settling",
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              agentEarningAdjustments.id,
              adjustmentRows.map((row) => row.id),
            ),
            eq(agentEarningAdjustments.status, "pending"),
            isNull(agentEarningAdjustments.settlementId),
          ),
        )
        .returning({ id: agentEarningAdjustments.id });
      if (claimedAdjustments.length !== adjustmentRows.length) {
        throw new Error("部分账务调整状态已变化，请刷新后重试");
      }
    }
    return settlement;
  });
  await writeAuditLog({
    actor: session,
    action: "admin.settlement.create",
    targetType: "agent_settlement",
    targetId: result.id,
    metadata: {
      agentId: data.agentId,
      periodStart,
      periodEnd,
      amountCents: result.amountCents,
    },
  });
  return NextResponse.json({ settlement: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算单创建失败" },
      { status: 409 },
    );
  }
}
