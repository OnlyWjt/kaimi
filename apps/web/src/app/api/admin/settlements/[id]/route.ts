import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import {
  BAD_STATE_MESSAGE,
  MIRROR_MESSAGE,
  STATE_CHANGED_MESSAGE,
  reviewLegacySettlement,
} from "@/lib/legacy-settlement-review";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark_paid"),
    paymentMethod: z.string().trim().min(1).max(64),
    paymentReference: z.string().trim().min(1).max(128),
  }),
  z.object({ action: z.literal("cancel") }),
]);

/**
 * 旧周结单人工核验。mark_paid 只认 pending_payment；cancel 也认 draft（把占用的收益退回未结）。
 * 对账批次的镜像行一律 409，归对账页管。逻辑在 lib/legacy-settlement-review.ts（有内存 SQLite 测试）。
 */
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
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400 });
  }
  const outcome = await reviewLegacySettlement(db, id, parsed.data, new Date().toISOString());
  if (outcome.kind === "not_found") {
    return NextResponse.json({ error: "结算单不存在" }, { status: 404 });
  }
  if (outcome.kind === "mirror") {
    return NextResponse.json({ error: MIRROR_MESSAGE }, { status: 409 });
  }
  if (outcome.kind === "bad_state") {
    return NextResponse.json({ error: BAD_STATE_MESSAGE }, { status: 409 });
  }
  if (outcome.kind === "changed") {
    return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
  }
  await writeAuditLog({
    actor: session,
    action: `admin.settlement.${parsed.data.action}`,
    targetType: "agent_settlement",
    targetId: id,
    metadata: {
      source: "legacy_weekly_settlement_review",
      settlementNo: outcome.settlement.settlementNo,
      agentId: outcome.settlement.agentId,
      amountCents: outcome.settlement.amountCents,
      fromStatus: outcome.settlement.status,
      toStatus: outcome.toStatus,
      earningRows: outcome.earnings,
      adjustmentRows: outcome.adjustments,
      ...(parsed.data.action === "mark_paid"
        ? {
            paymentMethod: parsed.data.paymentMethod,
            paymentReference: parsed.data.paymentReference,
          }
        : {}),
    },
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  return NextResponse.json({ ok: true, earnings: outcome.earnings, adjustments: outcome.adjustments });
}
