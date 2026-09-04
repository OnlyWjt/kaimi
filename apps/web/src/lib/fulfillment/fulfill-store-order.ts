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
import { issueIdempotencyKey } from "@/lib/fulfillment/issue-keys";
import {
  FULFILLMENT_FAILED_RESULTS,
  fulfillmentRetryDelayMs,
  fulfillmentRetryExhausted,
} from "@/lib/fulfillment/retry-policy";

const ISSUING_LEASE_MS = 5 * 60_000;

/** 还能继续发卡的状态：没发过、发失败了、只发出一部分。 */
const RESUMABLE_STATUSES = [
  "pending",
  "paid_undelivered",
  "partially_delivered",
];

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
          inArray(storeOrders.fulfillStatus, RESUMABLE_STATUSES),
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
  const quantity = Math.max(1, claimed.quantity);
  let alreadyIssued = 0;
  try {
    const existing = await db.query.issuedCdks.findMany({
      where: eq(issuedCdks.orderId, order.id),
    });
    alreadyIssued = existing.length;
    const remaining = quantity - alreadyIssued;
    const ownedHashes = new Set(existing.map((row) => row.codeHash));

    const fresh: Array<{
      code: string;
      codeHash: string;
      codePrefix: string;
      upstreamRef: string;
      upstreamFeeMinor: number;
    }> = [];
    let accountId: number = order.cardplatformAccountId;

    if (remaining > 0) {
      const [{ nextAttempt }] = await db
        .select({
          nextAttempt: sql<number>`coalesce(max(${fulfillmentAttempts.attemptNo}), 0) + 1`,
        })
        .from(fulfillmentAttempts)
        .where(eq(fulfillmentAttempts.orderId, order.id));
      // 卡台明确回过几次空。零进展的重试要是继续用同一个键，上游缓存了那个空响应
      // 就再也发不出卡来了。超时之类的未知结果不算在内，那种必须复用旧键。
      const [{ emptyResponses }] = await db
        .select({ emptyResponses: sql<number>`count(*)` })
        .from(fulfillmentAttempts)
        .where(
          and(
            eq(fulfillmentAttempts.orderId, order.id),
            eq(fulfillmentAttempts.errorCode, "CARDPLATFORM_ISSUED_NONE"),
          ),
        );
      // 补发剩余必须换幂等键，否则卡台会重放上一次那几张。
      const idempotencyKey = issueIdempotencyKey(
        order.fulfillmentIdempotencyKey,
        alreadyIssued,
        Number(emptyResponses || 0),
      );
      const [createdAttempt] = await db
        .insert(fulfillmentAttempts)
        .values({
          orderId: order.id,
          attemptNo: Number(nextAttempt || 1),
          idempotencyKey,
          requestSummaryJson: JSON.stringify({
            plan: order.planKeySnapshot,
            count: remaining,
            quantity,
            alreadyIssued,
          }),
          result: "running",
        })
        .returning();
      attempt = createdAttempt;

      const { account, client } = await getCardplatformClientById(
        order.cardplatformAccountId,
      );
      accountId = account.id;
      const pref = await issuePrefFromAccount(account.id);
      const cdks = await client.issueMany(
        order.planKeySnapshot,
        remaining,
        idempotencyKey,
        pref
          ? {
              issuer: pref.issuer,
              segmentType: pref.segmentType,
              segmentKey: pref.segmentKey,
            }
          : undefined,
      );

      const hashes = cdks.map((cdk) => hashLookupValue(cdk.code.toUpperCase()));
      const clashes = await db.query.issuedCdks.findMany({
        where: inArray(issuedCdks.codeHash, hashes),
      });
      if (clashes.some((row) => row.orderId !== order.id)) {
        throw new CardplatformError({
          message: "卡台返回了已绑定其他订单的卡密，已停止自动重试",
          errorCode: "CARDPLATFORM_DUPLICATE_CDK",
          outcomeUnknown: true,
        });
      }
      for (const row of clashes) ownedHashes.add(row.codeHash);

      // 幂等键被重放时会拿回已经入库的卡密，按 code_hash 跳过即可，不算失败。
      const seen = new Set<string>();
      for (const cdk of cdks) {
        const codeHash = hashLookupValue(cdk.code.toUpperCase());
        if (ownedHashes.has(codeHash) || seen.has(codeHash)) continue;
        seen.add(codeHash);
        fresh.push({
          code: cdk.code,
          codeHash,
          codePrefix:
            cdk.codePrefix ||
            (cdk.code.length >= 14 ? cdk.code.slice(0, 14) : ""),
          upstreamRef: String(cdk.id || ""),
          upstreamFeeMinor: cdk.feeAmountMinor,
        });
      }
    }

    const now = new Date().toISOString();
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
      if (fresh.length > 0) {
        await tx
          .insert(issuedCdks)
          .values(
            fresh.map((item) => ({
              orderId: order.id,
              agentId: order.agentId,
              planKey: order.planKeySnapshot,
              codeEncrypted: encryptSecret(item.code),
              codeHash: item.codeHash,
              codePrefix: item.codePrefix,
              cardplatformAccountId: accountId,
              upstreamRef: item.upstreamRef,
              upstreamFeeMinor: item.upstreamFeeMinor,
              status: "unused",
              issuedAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoNothing({ target: issuedCdks.codeHash });
      }

      const [{ issuedTotal }] = await tx
        .select({ issuedTotal: sql<number>`count(*)` })
        .from(issuedCdks)
        .where(eq(issuedCdks.orderId, order.id));
      const delivered = Number(issuedTotal || 0);
      const complete = delivered >= quantity;

      // 收益按整单总额记一次，只在卡发齐了之后写；不写会被后续尝试改来改去的部分收益。
      if (complete) {
        await tx
          .insert(agentEarnings)
          .values({
            orderId: order.id,
            agentId: order.agentId,
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

      await tx
        .update(storeOrders)
        .set({
          fulfillStatus: complete ? "delivered" : "partially_delivered",
          deliveredAt: complete ? now : freshOrder.deliveredAt,
          lastErrorCode: complete ? "" : "CARDPLATFORM_PARTIAL_ISSUE",
          lastErrorMessage: complete
            ? ""
            : `卡台只发出 ${delivered}/${quantity} 张，正在自动补发剩余`,
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
            result: complete ? "success" : "partial",
            responseSummaryJson: JSON.stringify({
              issued: fresh.length,
              deliveredTotal: delivered,
              quantity,
              upstreamRefs: fresh.map((item) => item.upstreamRef),
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
    // 已经发出去几张的订单退回 partially_delivered，别把买家手上的卡当成一张都没发。
    const retryStatus =
      alreadyIssued > 0 ? "partially_delivered" : "paid_undelivered";
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(storeOrders)
        .set({
          fulfillStatus: unknown ? "unknown" : retryStatus,
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
      inArray(storeOrders.fulfillStatus, [...RESUMABLE_STATUSES, "issuing"]),
    ),
    orderBy: [asc(storeOrders.paidAt)],
    limit: Math.max(1, Math.min(limit, 50)),
  });
  let delivered = 0;
  let checked = 0;
  for (const order of rows) {
    const last = await db.query.fulfillmentAttempts.findFirst({
      where: eq(fulfillmentAttempts.orderId, order.id),
      orderBy: [desc(fulfillmentAttempts.attemptNo)],
    });
    // 预算和退避都按「真失败过几次」算。partial 是进展，不吃预算也不拉长等待，
    // 否则卡台一次只回一张时，多张单会被自己的进展饿死在退避里。
    const [{ failedAttempts }] = await db
      .select({ failedAttempts: sql<number>`count(*)` })
      .from(fulfillmentAttempts)
      .where(
        and(
          eq(fulfillmentAttempts.orderId, order.id),
          inArray(fulfillmentAttempts.result, FULFILLMENT_FAILED_RESULTS),
        ),
      );
    const failures = Number(failedAttempts || 0);
    const issuingFresh =
      order.fulfillStatus === "issuing" &&
      new Date(order.updatedAt).getTime() > Date.now() - ISSUING_LEASE_MS;
    if (issuingFresh) continue;
    if (fulfillmentRetryExhausted(failures)) {
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
      const delay = fulfillmentRetryDelayMs(failures);
      if (Date.now() - new Date(last.finishedAt).getTime() < delay) continue;
    }
    checked += 1;
    const result = await fulfillStoreOrder(order.id);
    if (result?.fulfillStatus === "delivered") delivered += 1;
  }
  return { checked, delivered };
}
