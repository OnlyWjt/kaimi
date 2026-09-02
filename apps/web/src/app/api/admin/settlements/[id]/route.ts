import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  agentSettlements,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark_paid"),
    paymentMethod: z.string().trim().min(1).max(64),
    paymentReference: z.string().trim().min(1).max(128),
  }),
  z.object({ action: z.literal("cancel") }),
]);

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const id = Number((await context.params).id);
  const parsed = schema.safeParse(await req.json());
  if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const settlement = await db.query.agentSettlements.findFirst({
    where: eq(agentSettlements.id, id),
  });
  if (!settlement) {
    return NextResponse.json({ error: "结算单不存在" }, { status: 404 });
  }
  if (settlement.status !== "pending_payment") {
    return NextResponse.json({ error: "当前结算单状态不可操作" }, { status: 409 });
  }
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      if (parsed.data.action === "mark_paid") {
        const [claimed] = await tx
          .update(agentSettlements)
          .set({
            status: "paid",
            paymentMethod: parsed.data.paymentMethod,
            paymentReference: parsed.data.paymentReference,
            paidAt: now,
          })
          .where(
            and(
              eq(agentSettlements.id, id),
              eq(agentSettlements.status, "pending_payment"),
            ),
          )
          .returning();
        if (!claimed) throw new Error("结算单状态已变化，请刷新后重试");
        await tx
          .update(agentEarnings)
          .set({ status: "settled", updatedAt: now })
          .where(
            and(
              eq(agentEarnings.settlementId, id),
              eq(agentEarnings.status, "settling"),
            ),
          );
        await tx
          .update(agentEarningAdjustments)
          .set({ status: "settled", updatedAt: now })
          .where(
            and(
              eq(agentEarningAdjustments.settlementId, id),
              eq(agentEarningAdjustments.status, "settling"),
            ),
          );
      } else {
        const [claimed] = await tx
          .update(agentSettlements)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(agentSettlements.id, id),
              eq(agentSettlements.status, "pending_payment"),
            ),
          )
          .returning();
        if (!claimed) throw new Error("结算单状态已变化，请刷新后重试");
        await tx
          .update(agentEarnings)
          .set({ settlementId: null, status: "pending", updatedAt: now })
          .where(
            and(
              eq(agentEarnings.settlementId, id),
              eq(agentEarnings.status, "settling"),
            ),
          );
        await tx
          .update(agentEarningAdjustments)
          .set({ settlementId: null, status: "pending", updatedAt: now })
          .where(
            and(
              eq(agentEarningAdjustments.settlementId, id),
              eq(agentEarningAdjustments.status, "settling"),
            ),
          );
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结算操作失败" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: `admin.settlement.${parsed.data.action}`,
    targetType: "agent_settlement",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
