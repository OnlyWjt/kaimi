import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agentEarnings,
  fulfillmentAttempts,
  issuedCdks,
  storeOrders,
} from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { bootDb } from "@/lib/config";
import { encryptSecret, hashLookupValue } from "@/lib/crypto";
import {
  FULFILLMENT_ABANDONED_RESULT,
  FULFILLMENT_FAILED_RESULTS,
} from "@/lib/fulfillment/retry-policy";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm_not_issued"),
    confirmation: z.string(),
  }),
  z.object({
    action: z.literal("confirm_issued"),
    code: z.string().trim().min(6).max(512),
    upstreamRef: z.string().trim().max(128).optional().default(""),
  }),
]);

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
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.orderNo, orderNo),
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.payStatus !== "paid" || order.fulfillStatus !== "unknown") {
    return NextResponse.json(
      { error: "只有已付款且结果未知的订单可以人工处理" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  if (parsed.data.action === "confirm_not_issued") {
    if (parsed.data.confirmation !== order.orderNo) {
      return NextResponse.json(
        { error: "请输入完整订单号确认卡台确实未发码" },
        { status: 400 },
      );
    }
    const issued = await db
      .select({ n: sql<number>`count(*)` })
      .from(issuedCdks)
      .where(eq(issuedCdks.orderId, order.id))
      .then((rows) => Number(rows[0]?.n || 0));
    // 买家手上已经有几张的单退回 partially_delivered，说成「一张都没发」是错的。
    const nextStatus = issued > 0 ? "partially_delivered" : "paid_undelivered";
    const [updated] = await db
      .update(storeOrders)
      .set({
        fulfillStatus: nextStatus,
        lastErrorCode: "",
        lastErrorMessage:
          issued > 0
            ? `管理员已核对卡台，已发出 ${issued} 张，剩余允许安全补发`
            : "管理员已核对卡台未发码，允许安全重试",
        updatedAt: now,
      })
      .where(
        and(
          eq(storeOrders.id, order.id),
          eq(storeOrders.fulfillStatus, "unknown"),
        ),
      )
      .returning();
    if (!updated) {
      return NextResponse.json({ error: "订单状态已变化" }, { status: 409 });
    }
    // 光把状态改回去没用：失败计数还满着，下一轮扫描会立刻把它打回 unknown。
    // 人工已经核对过了，旧的失败记录不再计入预算。
    await db
      .update(fulfillmentAttempts)
      .set({ result: FULFILLMENT_ABANDONED_RESULT })
      .where(
        and(
          eq(fulfillmentAttempts.orderId, order.id),
          inArray(fulfillmentAttempts.result, FULFILLMENT_FAILED_RESULTS),
        ),
      );
  } else {
    const resolution = parsed.data;
    if (!order.cardplatformAccountId) {
      return NextResponse.json({ error: "订单未绑定卡台账户" }, { status: 409 });
    }
    const code = resolution.code.trim();
    try {
      await db.transaction(async (tx) => {
        const freshOrder = await tx.query.storeOrders.findFirst({
          where: eq(storeOrders.id, order.id),
        });
        if (
          !freshOrder ||
          freshOrder.payStatus !== "paid" ||
          freshOrder.fulfillStatus !== "unknown"
        ) {
          throw new Error("订单状态已变化");
        }
        // fulfillStoreOrder 补发时会做这一步：不查一遍就 onConflictDoNothing，
        // 粘错成别的订单的卡密时会静默什么都不做，管理员以为补录成功了。
        const codeHash = hashLookupValue(code.toUpperCase());
        const clash = await tx.query.issuedCdks.findFirst({
          where: eq(issuedCdks.codeHash, codeHash),
        });
        if (clash && clash.orderId !== order.id) {
          throw new Error("这张卡密已经绑定在别的订单上，请核对后再补录");
        }
        await tx
          .insert(issuedCdks)
          .values({
            orderId: order.id,
            agentId: freshOrder.agentId,
            planKey: freshOrder.planKeySnapshot,
            codeEncrypted: encryptSecret(code),
            codeHash,
            codePrefix: code.length >= 14 ? code.slice(0, 14) : "",
            cardplatformAccountId: freshOrder.cardplatformAccountId!,
            upstreamRef: resolution.upstreamRef,
            status: "unused",
            issuedAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: issuedCdks.codeHash });
        const quantity = Math.max(1, freshOrder.quantity);
        const [{ issuedTotal }] = await tx
          .select({ issuedTotal: sql<number>`count(*)` })
          .from(issuedCdks)
          .where(eq(issuedCdks.orderId, order.id));
        const delivered = Number(issuedTotal || 0);
        const complete = delivered >= quantity;
        // 收益与订单 1:1，只在卡补齐之后按整单总额写一次。
        if (complete) {
          await tx
            .insert(agentEarnings)
            .values({
              orderId: order.id,
              agentId: freshOrder.agentId,
              grossCents: freshOrder.grossCents,
              costCents: freshOrder.agentCostTotalCents,
              paymentFeeCents: freshOrder.finalPaymentFeeCents,
              feeSource:
                freshOrder.feeReconcileStatus === "confirmed"
                  ? "gateway_actual"
                  : freshOrder.feeReconcileStatus === "unsupported"
                    ? "configured_fallback"
                    : "estimated",
              earningCents: freshOrder.agentEarningCents,
              status: "pending",
              confirmedAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: agentEarnings.orderId });
        }
        const [updated] = await tx
          .update(storeOrders)
          .set({
            fulfillStatus: complete ? "delivered" : "partially_delivered",
            deliveredAt: complete ? now : freshOrder.deliveredAt,
            lastErrorCode: complete ? "" : "CARDPLATFORM_PARTIAL_ISSUE",
            lastErrorMessage: complete
              ? "管理员已从卡台核对并补录卡密"
              : `管理员已补录到 ${delivered}/${quantity} 张，剩余继续自动补发`,
            updatedAt: now,
          })
          .where(
            and(
              eq(storeOrders.id, order.id),
              eq(storeOrders.fulfillStatus, "unknown"),
            ),
          )
          .returning();
        if (!updated) throw new Error("订单状态已变化");
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "人工补录失败" },
        { status: 409 },
      );
    }
  }
  await writeAuditLog({
    actor: session,
    action: `admin.store_order.${parsed.data.action}`,
    targetType: "store_order",
    targetId: order.id,
    metadata: { orderNo },
  });
  return NextResponse.json({ ok: true });
}
