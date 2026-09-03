import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarnings,
  fulfillmentAttempts,
  issuedCdks,
  storeOrders,
} from "@/db/schema";
import { CardplatformError } from "@/lib/cardplatform/client";
import { getCardplatformClientById } from "@/lib/cardplatform/config";
import { issuePrefFromAccount } from "@/lib/cardplatform/policy";
import { encryptSecret, hashLookupValue } from "@/lib/crypto";

const ISSUING_LEASE_MS = 5 * 60_000;

export async function fulfillStoreOrder(orderId: number) {
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
  });
  if (!order) throw new Error("订单不存在");
  if (order.fulfillStatus === "delivered") return order;
  if (order.payStatus !== "paid") throw new Error("订单尚未支付");
  if (!order.cardplatformAccountId) throw new Error("订单未绑定卡台账户");
  const staleBefore = new Date(Date.now() - ISSUING_LEASE_MS).toISOString();

  const [claimed] = await db
    .update(storeOrders)
    .set({
      fulfillStatus: "issuing",
      lastErrorCode: "",
      lastErrorMessage: "",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(storeOrders.id, order.id),
        eq(storeOrders.payStatus, "paid"),
        or(
          inArray(storeOrders.fulfillStatus, ["pending", "paid_undelivered"]),
          and(
            eq(storeOrders.fulfillStatus, "issuing"),
            lte(storeOrders.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    return await db.query.storeOrders.findFirst({
      where: eq(storeOrders.id, order.id),
    });
  }

  let attempt: typeof fulfillmentAttempts.$inferSelect | undefined;
  try {
    const [{ nextAttempt }] = await db
      .select({
        nextAttempt: sql<number>`coalesce(max(${fulfillmentAttempts.attemptNo}), 0) + 1`,
      })
      .from(fulfillmentAttempts)
      .where(eq(fulfillmentAttempts.orderId, order.id));
    const [createdAttempt] = await db
      .insert(fulfillmentAttempts)
      .values({
        orderId: order.id,
        attemptNo: Number(nextAttempt || 1),
        idempotencyKey: order.fulfillmentIdempotencyKey,
        requestSummaryJson: JSON.stringify({
          plan: order.planKeySnapshot,
          count: 1,
        }),
        result: "running",
      })
      .returning();
    attempt = createdAttempt;

    const { account, client } = await getCardplatformClientById(
      order.cardplatformAccountId,
    );
    const pref = await issuePrefFromAccount(account.id);
    const cdk = await client.issueOne(
      order.planKeySnapshot,
      order.fulfillmentIdempotencyKey,
      pref
        ? {
            issuer: pref.issuer,
            segmentType: pref.segmentType,
            segmentKey: pref.segmentKey,
          }
        : undefined,
    );
    const now = new Date().toISOString();
    const prefix =
      cdk.codePrefix || (cdk.code.length >= 14 ? cdk.code.slice(0, 14) : "");
    const codeHash = hashLookupValue(cdk.code.toUpperCase());
    const duplicateCode = await db.query.issuedCdks.findFirst({
      where: eq(issuedCdks.codeHash, codeHash),
    });
    if (duplicateCode && duplicateCode.orderId !== order.id) {
      throw new CardplatformError({
        message: "卡台返回了已绑定其他订单的卡密，已停止自动重试",
        errorCode: "CARDPLATFORM_DUPLICATE_CDK",
        outcomeUnknown: true,
      });
    }

    await db.transaction(async (tx) => {
      const freshOrder = await tx.query.storeOrders.findFirst({
        where: eq(storeOrders.id, order.id),
      });
      if (!freshOrder) throw new Error("订单在履约过程中被删除");
      if (
        freshOrder.payStatus !== "paid" ||
        freshOrder.fulfillStatus !== "issuing"
      ) {
        throw new Error("订单状态已变化，已阻止写入发卡和收益记录");
      }
      await tx
        .insert(issuedCdks)
        .values({
          orderId: order.id,
          agentId: order.agentId,
          planKey: order.planKeySnapshot,
          codeEncrypted: encryptSecret(cdk.code),
          codeHash,
          codePrefix: prefix,
          cardplatformAccountId: account.id,
          upstreamRef: String(cdk.id || ""),
          upstreamFeeMinor: cdk.feeAmountMinor,
          status: "unused",
          issuedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: issuedCdks.orderId });

      await tx
        .insert(agentEarnings)
        .values({
          orderId: order.id,
          agentId: order.agentId,
          grossCents: freshOrder.retailPriceCents,
          costCents: freshOrder.agentCostCents,
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

      await tx
        .update(storeOrders)
        .set({
          fulfillStatus: "delivered",
          deliveredAt: now,
          lastErrorCode: "",
          lastErrorMessage: "",
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            eq(storeOrders.fulfillStatus, "issuing"),
          ),
        );

      if (attempt) {
        await tx
          .update(fulfillmentAttempts)
          .set({
            result: "success",
            responseSummaryJson: JSON.stringify({
              upstreamRef: String(cdk.id || ""),
              codePrefix: prefix,
            }),
            finishedAt: now,
          })
          .where(eq(fulfillmentAttempts.id, attempt.id));
      }
    });
  } catch (error) {
    const cardError =
      error instanceof CardplatformError
        ? error
        : new CardplatformError({
            message: error instanceof Error ? error.message : "发卡失败",
          });
    const unknown = cardError.outcomeUnknown && !cardError.retryable;
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(storeOrders)
        .set({
          fulfillStatus: unknown ? "unknown" : "paid_undelivered",
          lastErrorCode:
            cardError.errorCode ||
            (unknown ? "CARDPLATFORM_OUTCOME_UNKNOWN" : "CARDPLATFORM_FAILED"),
          lastErrorMessage: cardError.message.slice(0, 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            eq(storeOrders.fulfillStatus, "issuing"),
          ),
        );
      if (attempt) {
        await tx
          .update(fulfillmentAttempts)
          .set({
            result: unknown ? "unknown" : "failed",
            errorCode: cardError.errorCode,
            errorMessage: cardError.message.slice(0, 500),
            finishedAt: now,
          })
          .where(eq(fulfillmentAttempts.id, attempt.id));
      }
    });
  }

  return await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, order.id),
  });
}

export async function retryPendingStoreOrders(limit = 10) {
  const rows = await db.query.storeOrders.findMany({
    where: and(
      eq(storeOrders.payStatus, "paid"),
      inArray(storeOrders.fulfillStatus, [
        "pending",
        "paid_undelivered",
        "issuing",
      ]),
    ),
    orderBy: [asc(storeOrders.paidAt)],
    limit: Math.max(1, Math.min(limit, 50)),
  });
  let delivered = 0;
  let checked = 0;
  const retryDelaysMs = [
    0,
    60_000,
    3 * 60_000,
    10 * 60_000,
    30 * 60_000,
    2 * 60 * 60_000,
    6 * 60 * 60_000,
    24 * 60 * 60_000,
  ];
  for (const order of rows) {
    const last = await db.query.fulfillmentAttempts.findFirst({
      where: eq(fulfillmentAttempts.orderId, order.id),
      orderBy: [desc(fulfillmentAttempts.attemptNo)],
    });
    const issuingFresh =
      order.fulfillStatus === "issuing" &&
      new Date(order.updatedAt).getTime() > Date.now() - ISSUING_LEASE_MS;
    if (issuingFresh) continue;
    if (last?.attemptNo && last.attemptNo >= retryDelaysMs.length) {
      await db
        .update(storeOrders)
        .set({
          fulfillStatus: "unknown",
          lastErrorCode: "FULFILLMENT_RETRY_EXHAUSTED",
          lastErrorMessage: "自动发卡重试次数已用尽，等待人工核对",
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            eq(storeOrders.fulfillStatus, order.fulfillStatus),
            eq(storeOrders.updatedAt, order.updatedAt),
          ),
        );
      continue;
    }
    if (last?.finishedAt) {
      const delay =
        retryDelaysMs[last.attemptNo] ??
        retryDelaysMs[retryDelaysMs.length - 1]!;
      if (Date.now() - new Date(last.finishedAt).getTime() < delay) continue;
    }
    checked += 1;
    const result = await fulfillStoreOrder(order.id);
    if (result?.fulfillStatus === "delivered") delivered += 1;
  }
  return { checked, delivered };
}
