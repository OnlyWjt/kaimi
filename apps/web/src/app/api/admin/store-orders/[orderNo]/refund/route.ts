import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agentEarningAdjustments,
  agentEarnings,
  issuedCdks,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { getCardplatformClientById } from "@/lib/cardplatform/config";
import { CardplatformError } from "@/lib/cardplatform/client";
import { bootDb } from "@/lib/config";

const schema = z.object({
  type: z.enum(["refund", "chargeback"]),
  reference: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
  confirmation: z.string().trim(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ orderNo: string }> },
) {
  let session;
  try {
    session = await requireAdmin();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  await bootDb();
  const { orderNo } = await context.params;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.confirmation !== orderNo) {
    return NextResponse.json(
      { error: "请输入完整订单号确认退款/拒付已在支付渠道完成" },
      { status: 400 },
    );
  }
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.payStatus === "refunded") {
    return NextResponse.json({ ok: true, alreadyProcessed: true });
  }
  if (order.payStatus !== "paid") {
    return NextResponse.json(
      { error: "只有已付款订单可以登记退款或拒付" },
      { status: 409 },
    );
  }
  if (["issuing", "unknown"].includes(order.fulfillStatus)) {
    return NextResponse.json(
      { error: "订单正在发卡或结果不确定，请先完成人工核对" },
      { status: 409 },
    );
  }
  if (!["pending", "paid_undelivered", "delivered"].includes(order.fulfillStatus)) {
    return NextResponse.json(
      { error: "订单正在发卡或结果不确定，请先完成履约核对" },
      { status: 409 },
    );
  }

  const [earning, cdk] = await Promise.all([
    db.query.agentEarnings.findFirst({
      where: eq(agentEarnings.orderId, order.id),
    }),
    db.query.issuedCdks.findFirst({
      where: eq(issuedCdks.orderId, order.id),
    }),
  ]);
  if (earning?.status === "settling") {
    return NextResponse.json(
      { error: "该收益正在结算，请先取消待付款结算单" },
      { status: 409 },
    );
  }
  if (cdk && ["used", "locked", "redeeming"].includes(cdk.status)) {
    return NextResponse.json(
      { error: "卡密已使用或正在兑换，禁止直接退款，请先人工核对" },
      { status: 409 },
    );
  }
  if (cdk?.status === "unused") {
    const upstreamId = Number(cdk.upstreamRef);
    if (!Number.isSafeInteger(upstreamId) || upstreamId <= 0) {
      return NextResponse.json(
        { error: "卡密缺少卡台引用，无法确认禁用，已阻止退款登记" },
        { status: 409 },
      );
    }
    try {
      const { client } = await getCardplatformClientById(
        cdk.cardplatformAccountId,
        { allowDisabled: true },
      );
      try {
        await client.deleteCdkAndRefund(upstreamId);
      } catch (error) {
        if (error instanceof CardplatformError && error.httpStatus === 404) {
          // A prior attempt may have removed the card before local commit.
        } else if (
          error instanceof CardplatformError &&
          error.httpStatus === 405
        ) {
          await client.disableCdk(upstreamId);
        } else {
          throw error;
        }
      }
    } catch (error) {
      await writeAuditLog({
        actor: session,
        action: "admin.store_order.refund_upstream_failed",
        targetType: "store_order",
        targetId: order.id,
        metadata: {
          orderNo,
          outcomeUnknown:
            error instanceof CardplatformError && error.outcomeUnknown,
          error: error instanceof Error ? error.message : "unknown",
        },
      });
      return NextResponse.json(
        { error: "卡台退卡结果未确认，未修改本地账务，请核对后重试" },
        { status: 502 },
      );
    }
  }

  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(storeOrders)
        .set({
          payStatus: "refunded",
          fulfillStatus: "refunded",
          refundedAt: now,
          lastErrorCode: parsed.data.type.toUpperCase(),
          lastErrorMessage: parsed.data.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            eq(storeOrders.payStatus, "paid"),
            eq(storeOrders.fulfillStatus, order.fulfillStatus),
            eq(storeOrders.updatedAt, order.updatedAt),
          ),
        )
        .returning();
      if (!updated) throw new Error("订单状态已变化");
      if (cdk) {
        const [disabled] = await tx
          .update(issuedCdks)
          .set({ status: "disabled", updatedAt: now })
          .where(and(eq(issuedCdks.id, cdk.id), eq(issuedCdks.status, "unused")))
          .returning({ id: issuedCdks.id });
        if (!disabled) {
          throw new Error("卡密已使用或正在兑换，禁止直接退款");
        }
      }
      if (earning?.status === "settled") {
        await tx
          .insert(agentEarningAdjustments)
          .values({
            agentId: earning.agentId,
            orderId: order.id,
            sourceEarningId: earning.id,
            type: parsed.data.type,
            amountCents: -earning.earningCents,
            reason: parsed.data.reason,
            reference: parsed.data.reference,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [
              agentEarningAdjustments.orderId,
              agentEarningAdjustments.type,
            ],
          });
      } else if (earning) {
        const [reversed] = await tx
          .update(agentEarnings)
          .set({
            status: "reversed",
            reversalReason: parsed.data.reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentEarnings.id, earning.id),
              inArray(agentEarnings.status, ["pending"]),
              isNull(agentEarnings.settlementId),
            ),
          )
          .returning({ id: agentEarnings.id });
        if (!reversed) throw new Error("收益状态已变化，请刷新后重试");
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "退款登记失败" },
      { status: 409 },
    );
  }
  await writeAuditLog({
    actor: session,
    action: `admin.store_order.${parsed.data.type}`,
    targetType: "store_order",
    targetId: order.id,
    metadata: {
      orderNo,
      reference: parsed.data.reference,
      earningAdjustmentCents:
        earning?.status === "settled" ? -earning.earningCents : 0,
    },
  });
  return NextResponse.json({ ok: true });
}
