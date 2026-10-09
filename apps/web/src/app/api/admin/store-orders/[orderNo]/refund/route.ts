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
import { isLocalAccountPlan } from "@/lib/finished-account-core";

function isFinishedDelivery(cdk: {
  planKey: string;
  upstreamRef: string;
  cardplatformAccountId: number;
}) {
  return (
    isLocalAccountPlan(cdk) ||
    cdk.cardplatformAccountId === 0 ||
    cdk.upstreamRef.startsWith("finished:")
  );
}
import { releaseCouponForTransition } from "@/lib/coupons";
import { recordOpsAlert } from "@/lib/ops-health";

// 退款中间态：已有展示标签/筛选（status-labels），之前没有写入方。
const REFUNDING = "refunding";

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
  if (order.payStatus === REFUNDING) {
    return NextResponse.json(
      { error: "退款正在处理或上次处理失败，请人工核对卡台与本地账务" },
      { status: 409 },
    );
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
  if (
    !["pending", "paid_undelivered", "partially_delivered", "delivered"].includes(
      order.fulfillStatus,
    )
  ) {
    return NextResponse.json(
      { error: "订单正在发卡或结果不确定，请先完成履约核对" },
      { status: 409 },
    );
  }

  const [earning, cdks] = await Promise.all([
    db.query.agentEarnings.findFirst({
      where: eq(agentEarnings.orderId, order.id),
    }),
    // 一单可能有多张卡，全部都要能退掉才允许登记。
    db.query.issuedCdks.findMany({
      where: eq(issuedCdks.orderId, order.id),
    }),
  ]);
  if (earning?.status === "settling") {
    return NextResponse.json(
      { error: "该收益正在结算，请先取消待付款结算单" },
      { status: 409 },
    );
  }
  if (
    cdks.some(
      (cdk) =>
        ["used", "locked", "redeeming"].includes(cdk.status) && !isFinishedDelivery(cdk),
    )
  ) {
    return NextResponse.json(
      { error: "卡密已使用或正在兑换，禁止直接退款，请先人工核对" },
      { status: 409 },
    );
  }
  // 顺序：本地条件 update 把 paid 锁成 refunding（中间态）→ 上游退卡 → 本地事务 refunding→refunded。
  // 上游失败时把 refunding 退回 paid；上游成功但本地提交失败时订单停在 refunding，
  // 写审计 + 告警并提示转人工，不会出现“上游已删卡、本地仍 paid”。
  const lockedAt = new Date().toISOString();
  const [locked] = await db
    .update(storeOrders)
    .set({ payStatus: REFUNDING, updatedAt: lockedAt })
    .where(
      and(
        eq(storeOrders.id, order.id),
        eq(storeOrders.payStatus, "paid"),
        eq(storeOrders.fulfillStatus, order.fulfillStatus),
        eq(storeOrders.updatedAt, order.updatedAt),
      ),
    )
    .returning({ id: storeOrders.id });
  if (!locked) {
    return NextResponse.json(
      { error: "订单状态已变化，请刷新后重试" },
      { status: 409 },
    );
  }
  const unlock = () =>
    db
      .update(storeOrders)
      .set({ payStatus: "paid", updatedAt: new Date().toISOString() })
      .where(and(eq(storeOrders.id, order.id), eq(storeOrders.payStatus, REFUNDING)))
      .catch((error) => {
        console.error(`[refund] 回滚 refunding 失败 ${orderNo}`, error);
      });

  const upstreamDone: number[] = [];
  for (const cdk of cdks) {
    if (cdk.status !== "unused") continue;
    // 成品号不在卡台，upstreamRef 也不是卡台 ID，禁用只走本地。
    if (
      cdk.cardplatformAccountId === 0 ||
      isLocalAccountPlan(cdk)
    ) {
      continue;
    }
    const upstreamId = Number(cdk.upstreamRef);
    if (!Number.isSafeInteger(upstreamId) || upstreamId <= 0) {
      if (!upstreamDone.length) await unlock();
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
      upstreamDone.push(cdk.id);
    } catch (error) {
      await writeAuditLog({
        actor: session,
        action: "admin.store_order.refund_upstream_failed",
        targetType: "store_order",
        targetId: order.id,
        metadata: {
          orderNo,
          cdkId: cdk.id,
          outcomeUnknown:
            error instanceof CardplatformError && error.outcomeUnknown,
          error: error instanceof Error ? error.message : "unknown",
          upstreamDoneCdkIds: upstreamDone,
        },
      });
      // 一张都没退掉时退回 paid 允许重试；已有部分卡在上游删除时保持 refunding，转人工。
      if (!upstreamDone.length) await unlock();
      return NextResponse.json(
        {
          error: upstreamDone.length
            ? "部分卡密已在卡台退卡，其余退卡结果未确认，未修改本地账务，请核对后重试"
            : "卡台退卡结果未确认，未修改本地账务，请核对后重试",
          needsManual: upstreamDone.length > 0,
        },
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
            eq(storeOrders.payStatus, REFUNDING),
            eq(storeOrders.fulfillStatus, order.fulfillStatus),
            eq(storeOrders.updatedAt, lockedAt),
          ),
        )
        .returning();
      if (!updated) throw new Error("订单状态已变化");
      // 只有这次条件 update 拿到了行才会走到这里，所以优惠券次数只还一次。
      await releaseCouponForTransition(tx, updated, "paid", "refunded");
      for (const cdk of cdks) {
        const deliveredAccount = isFinishedDelivery(cdk) && cdk.status === "used";
        if (cdk.status !== "unused" && !deliveredAccount) continue;
        const [disabled] = await tx
          .update(issuedCdks)
          .set({ status: "disabled", updatedAt: now })
          .where(
            and(
              eq(issuedCdks.id, cdk.id),
              eq(issuedCdks.status, deliveredAccount ? "used" : "unused"),
            ),
          )
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
    const message = error instanceof Error ? error.message : "退款登记失败";
    const latest = await db.query.storeOrders
      .findFirst({ where: eq(storeOrders.id, order.id) })
      .catch(() => null);
    if (latest?.payStatus === "refunded") {
      // 并发的另一次登记已经完成。
      return NextResponse.json({ ok: true, alreadyProcessed: true });
    }
    if (upstreamDone.length) {
      await writeAuditLog({
        actor: session,
        action: "admin.store_order.refund_local_failed_after_upstream",
        targetType: "store_order",
        targetId: order.id,
        metadata: {
          orderNo,
          type: parsed.data.type,
          reference: parsed.data.reference,
          cdkIds: upstreamDone,
          error: message,
        },
      }).catch((auditError) => {
        console.error(`[refund] 审计写入失败 ${orderNo}`, auditError);
      });
      await recordOpsAlert({
        level: "critical",
        code: `refund_local_failed:${orderNo}`,
        message: `订单 ${orderNo} 卡台已退卡，但本地退款登记失败（${message}），需人工处理`,
      }).catch((alertError) => {
        console.error(`[refund] 告警写入失败 ${orderNo}`, alertError);
      });
      return NextResponse.json(
        {
          error: `卡台已退卡，但本地退款登记失败（${message}），请转人工处理`,
          needsManual: true,
        },
        { status: 500 },
      );
    }
    await unlock();
    return NextResponse.json({ error: message }, { status: 409 });
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
