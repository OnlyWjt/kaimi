import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentEarnings,
  finishedAccounts,
  fulfillmentAttempts,
  issuedCdks,
  platformPlans,
  storeOrders,
} from "@/db/schema";
import { CardplatformError } from "@/lib/cardplatform/client";
import { getCardplatformClientById } from "@/lib/cardplatform/config";
import {
  accountSupportsPaymentCountry,
  isRegionIssueError,
  issueTargetFromSnapshot,
} from "@/lib/cardplatform/issue-target";
import { issuePrefFromAccount } from "@/lib/cardplatform/policy";
import { decryptSecret, encryptSecret, hashLookupValue } from "@/lib/crypto";
import { writeAuditLog } from "@/lib/audit";
import { issueIdempotencyKey } from "@/lib/fulfillment/issue-keys";
import {
  LOCAL_WRITE_CONFLICT,
  LeaseLostError,
  newLeaseToken,
  upstreamRefsSummary,
} from "@/lib/fulfillment/lease-core";
import {
  FULFILLMENT_FAILED_RESULTS,
  fulfillmentRetryDelayMs,
  fulfillmentRetryExhausted,
} from "@/lib/fulfillment/retry-policy";
import {
  formatFinishedAccountLine,
  isLocalAccountPlan,
} from "@/lib/finished-account-core";
import {
  allocateFinishedAccounts,
  decryptFinishedAccount,
} from "@/lib/finished-accounts";
import {
  computeOrderLedger,
  earningSnapshotFromOrder,
  ledgerInputFromOrder,
} from "@/lib/order-ledger-core";

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
  const plan = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.planKey, order.planKeySnapshot),
  });
  const localAccount = isLocalAccountPlan({
    planKey: order.planKeySnapshot,
    fulfillmentKind: plan?.fulfillmentKind,
  });
  if (!localAccount && !order.cardplatformAccountId) {
    throw new Error("订单未绑定卡台账户");
  }
  const staleBefore = new Date(Date.now() - ISSUING_LEASE_MS).toISOString();
  // 占用 token：后续所有写入都以 lastErrorCode = leaseToken 为条件，丢了租约就放弃。
  const leaseToken = newLeaseToken();

  const [claimed] = await db
    .update(storeOrders)
    .set({
      fulfillStatus: "issuing",
      lastErrorCode: leaseToken,
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

  if (localAccount) {
    return await fulfillLocalAccountOrder(claimed, leaseToken);
  }
  const boundAccountId = claimed.cardplatformAccountId;
  if (!boundAccountId) {
    throw new Error("订单未绑定卡台账户");
  }

  let attempt: typeof fulfillmentAttempts.$inferSelect | undefined;
  const quantity = Math.max(1, claimed.quantity);
  let alreadyIssued = 0;
  // 上游已经返回卡密之后，本地写库失败就不能当成普通失败重试：卡已经出了，要留引用等人工处理。
  let upstreamReturned = false;
  let upstreamItems: Array<{
    upstreamRef: string;
    codePrefix: string;
    codeEncrypted: string;
  }> = [];
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
    let accountId = boundAccountId;

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
            upstreamPlan: order.upstreamPlanKeySnapshot || order.planKeySnapshot,
            paymentCountry: order.paymentCountrySnapshot,
            count: remaining,
            quantity,
            alreadyIssued,
          }),
          result: "running",
        })
        .returning();
      attempt = createdAttempt;

      const { account, client } = await getCardplatformClientById(boundAccountId);
      accountId = account.id;
      const target = issueTargetFromSnapshot(order);
      if (target.paymentCountry && !accountSupportsPaymentCountry(account)) {
        throw new CardplatformError({
          message: "订单绑定的卡台账户不支持付款地区，已停止发卡",
          errorCode: "CARDPLATFORM_REGION_UNSUPPORTED",
        });
      }
      const pref = await issuePrefFromAccount(account.id);
      // 调上游前续租：租约已经被别的 worker 接手就别再出卡。
      if (!(await renewStoreLease(order.id, leaseToken))) {
        throw new LeaseLostError();
      }
      const cdks = await client.issueMany(target.plan, remaining, idempotencyKey, {
        ...(pref
          ? {
              issuer: pref.issuer,
              segmentType: pref.segmentType,
              segmentKey: pref.segmentKey,
            }
          : {}),
        ...(target.paymentCountry ? { paymentCountry: target.paymentCountry } : {}),
      });

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
      upstreamReturned = true;
      // 卡密只以密文留档，本地入库失败时供人工找回。
      upstreamItems = fresh.map((item) => ({
        upstreamRef: item.upstreamRef,
        codePrefix: item.codePrefix,
        codeEncrypted: encryptSecret(item.code),
      }));
      // 调上游后续租；失败说明租约已丢，走本地冲突处理，不能当普通失败重发。
      if (!(await renewStoreLease(order.id, leaseToken))) {
        throw new LeaseLostError();
      }
    }

    const now = new Date().toISOString();
    let mailDelivered = false;
    await db.transaction(async (tx) => {
      const freshOrder = await tx.query.storeOrders.findFirst({
        where: eq(storeOrders.id, order.id),
      });
      if (!freshOrder) throw new Error("订单在履约过程中被删除");
      if (
        freshOrder.payStatus !== "paid" ||
        freshOrder.fulfillStatus !== "issuing" ||
        freshOrder.lastErrorCode !== leaseToken
      ) {
        throw new LeaseLostError("订单状态已变化，已阻止写入发卡和收益记录");
      }
      if (fresh.length > 0) {
        await tx
          .insert(issuedCdks)
          .values(
            fresh.map((item) => ({
              orderId: order.id,
              agentId: order.agentId,
              planKey: order.planKeySnapshot,
              paymentCountry: order.paymentCountrySnapshot,
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
            ...earningSnapshotFromOrder(freshOrder),
            feeSource:
              freshOrder.feeReconcileStatus === "confirmed"
                ? "gateway_actual"
                : freshOrder.feeReconcileStatus === "unsupported"
                  ? "configured_fallback"
                  : "estimated",
            status: "pending",
            confirmedAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: agentEarnings.orderId });
        mailDelivered = true;
      }

      const updatedOrder = await tx
        .update(storeOrders)
        .set({
          fulfillStatus: complete ? "delivered" : "partially_delivered",
          deliveredAt: complete ? now : freshOrder.deliveredAt,
          deliveryMailStatus:
            complete && !freshOrder.deliveryMailStatus ? "pending" : freshOrder.deliveryMailStatus,
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
            eq(storeOrders.lastErrorCode, leaseToken),
          ),
        )
        .returning({ id: storeOrders.id });
      // 0 行：事务内租约被抢占，整体回滚，交给外层按本地冲突处理。
      if (updatedOrder.length === 0) throw new LeaseLostError();

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
    if (mailDelivered) queueDeliveryMail(order.id);
  } catch (error) {
    const cardError =
      error instanceof CardplatformError
        ? error
        : new CardplatformError({
            message: error instanceof Error ? error.message : "发卡失败",
          });
    // 上游已经出卡、本地却写不进去（租约丢失或订单状态变化）：卡已经在上游消耗，
    // 记成 unknown 等人工处理，绝不能记 failed 让重试再出一次卡。
    const localConflict =
      upstreamReturned &&
      upstreamItems.length > 0 &&
      !(error instanceof CardplatformError);
    const unknown =
      localConflict || (cardError.outcomeUnknown && !cardError.retryable);
    const regionError = !localConflict && isRegionIssueError(cardError);
    const errorCode = localConflict
      ? LOCAL_WRITE_CONFLICT
      : regionError
        ? "CARDPLATFORM_REGION_UNAVAILABLE"
        : cardError.errorCode ||
          (unknown ? "CARDPLATFORM_OUTCOME_UNKNOWN" : "CARDPLATFORM_FAILED");
    const errorMessage = (
      localConflict
        ? `卡台已出卡 ${upstreamItems.length} 张，但本地写库失败：${cardError.message}，需人工处理`
        : cardError.message
    ).slice(0, 500);
    // 已经发出去几张的订单退回 partially_delivered，别把买家手上的卡当成一张都没发。
    const retryStatus =
      alreadyIssued > 0 ? "partially_delivered" : "paid_undelivered";
    const now = new Date().toISOString();
    let orderReleased = false;
    await db.transaction(async (tx) => {
      // 只有仍持有租约时才改订单；租约已被别人接手（或管理员已处理）就不覆盖。
      const released = await tx
        .update(storeOrders)
        .set({
          fulfillStatus: unknown ? "unknown" : retryStatus,
          lastErrorCode: errorCode,
          lastErrorMessage: errorMessage,
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            eq(storeOrders.fulfillStatus, "issuing"),
            eq(storeOrders.lastErrorCode, leaseToken),
          ),
        )
        .returning({ id: storeOrders.id });
      orderReleased = released.length > 0;
      if (attempt) {
        await tx
          .update(fulfillmentAttempts)
          .set({
            result: unknown ? "unknown" : "failed",
            errorCode: localConflict
              ? LOCAL_WRITE_CONFLICT
              : error instanceof LeaseLostError
                ? "LEASE_LOST"
                : cardError.errorCode,
            errorMessage,
            ...(localConflict
              ? {
                  responseSummaryJson: JSON.stringify({
                    issued: 0,
                    quantity,
                    upstreamReturned: upstreamItems.length,
                    ...upstreamRefsSummary(upstreamItems),
                    // 密文留档，人工核对后可解密补录。
                    codesEncrypted: upstreamItems.map((item) => item.codeEncrypted),
                  }),
                }
              : {}),
            finishedAt: now,
          })
          .where(eq(fulfillmentAttempts.id, attempt.id));
      }
    });
    if (localConflict) {
      await writeAuditLog({
        action: "store.order.local_write_conflict",
        targetType: "store_order",
        targetId: String(order.id),
        metadata: {
          orderNo: order.orderNo,
          attemptId: attempt?.id ?? null,
          orderMarkedUnknown: orderReleased,
          reason: cardError.message.slice(0, 200),
          ...upstreamRefsSummary(upstreamItems),
        },
      }).catch((auditError) => {
        console.warn(
          `[fulfill] 本地写库冲突审计失败：${auditError instanceof Error ? auditError.message : auditError}`,
        );
      });
    }
    // 通知和套餐同步放到事务提交之后，回滚时不会误发。
    {
      if (regionError) {
        const planLabel = order.productNameSnapshot || order.planKeySnapshot;
        void import("@/lib/notify")
          .then(({ notifyRegionIssueRejected }) =>
            notifyRegionIssueRejected({
              orderNo: order.orderNo,
              planLabel,
              message: cardError.message,
            }),
          )
          .catch((notifyError) => {
            console.warn(
              `[fulfill] 地区告警发送失败：${notifyError instanceof Error ? notifyError.message : notifyError}`,
            );
          });
        // 卡台拒绝了这个地区。触发一次套餐同步让店铺尽快停售，避免更多买家下单。
        void import("@/lib/cardplatform/plans")
          .then(({ syncDefaultCardplatformPlans }) => syncDefaultCardplatformPlans())
          .catch((syncError) => {
            console.warn(
              `[fulfill] 地区错误后同步套餐失败：${syncError instanceof Error ? syncError.message : syncError}`,
            );
          });
      }
    }
  }

  return await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, order.id),
  });
}

/**
 * 续租：只有仍持有 leaseToken 的 worker 才能把 updatedAt 往后推。
 * 返回 false 表示租约已被别人接手或订单已被管理员处理，调用方必须放弃后续写入。
 */
async function renewStoreLease(orderId: number, leaseToken: string) {
  const rows = await db
    .update(storeOrders)
    .set({ updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(storeOrders.id, orderId),
        eq(storeOrders.fulfillStatus, "issuing"),
        eq(storeOrders.lastErrorCode, leaseToken),
      ),
    )
    .returning({ id: storeOrders.id });
  return rows.length > 0;
}

async function fulfillLocalAccountOrder(
  order: typeof storeOrders.$inferSelect,
  leaseToken: string,
) {
  const quantity = Math.max(1, order.quantity);
  const existing = await db.query.issuedCdks.findMany({
    where: eq(issuedCdks.orderId, order.id),
  });
  const remaining = Math.max(0, quantity - existing.length);
  const now = new Date().toISOString();
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
      idempotencyKey: `${order.fulfillmentIdempotencyKey}:local:${existing.length}`,
      requestSummaryJson: JSON.stringify({
        plan: order.planKeySnapshot,
        count: remaining,
        quantity,
        alreadyIssued: existing.length,
      }),
      result: "running",
    })
    .returning();

  let mailDelivered = false;
  try {
    await db.transaction(async (tx) => {
      const freshOrder = await tx.query.storeOrders.findFirst({
        where: eq(storeOrders.id, order.id),
      });
      if (!freshOrder) throw new Error("订单在履约过程中被删除");
      if (
        freshOrder.payStatus !== "paid" ||
        freshOrder.fulfillStatus !== "issuing"
      ) {
        throw new Error("订单状态已变化，已阻止写入成品号和收益记录");
      }
      if (freshOrder.lastErrorCode !== leaseToken) {
        throw new LeaseLostError("发货租约已被其他任务接手，放弃本次成品号写入");
      }

      const allocated =
        remaining > 0
          ? await allocateFinishedAccounts(tx, {
              planKey: order.planKeySnapshot,
              orderId: order.id,
              quantity: remaining,
            })
          : [];
      // 成品号的 codeHash 来自邮箱；管理员可能已经手工把同一邮箱补录到别的订单。
      // 冲突时跳过这一行（不让整个事务回滚后反复失败），并把这个号停用、解绑，
      // 剩余数量由下面 count(*) 重算，订单走 partially_delivered 等待下次补发。
      const conflictedAccountIds: number[] = [];
      if (allocated.length > 0) {
        const inserted = await tx.insert(issuedCdks).values(
          allocated.map((row) => {
            const parts = decryptFinishedAccount(row, decryptSecret);
            const line = formatFinishedAccountLine(parts);
            return {
              orderId: order.id,
              agentId: order.agentId,
              planKey: order.planKeySnapshot,
              codeEncrypted: encryptSecret(line),
              codeHash: hashLookupValue(parts.email),
              codePrefix: parts.email.slice(0, 14),
              cardplatformAccountId: 0,
              upstreamRef: `finished:${row.id}`,
              upstreamFeeMinor: 0,
              status: "unused",
              issuedAt: now,
              updatedAt: now,
            };
          }),
        )
          .onConflictDoNothing({ target: issuedCdks.codeHash })
          .returning({ upstreamRef: issuedCdks.upstreamRef });
        const insertedRefs = new Set(inserted.map((row) => row.upstreamRef));
        for (const row of allocated) {
          if (insertedRefs.has(`finished:${row.id}`)) continue;
          conflictedAccountIds.push(row.id);
          await tx
            .update(finishedAccounts)
            .set({ status: "disabled", storeOrderId: null, updatedAt: now })
            .where(
              and(
                eq(finishedAccounts.id, row.id),
                eq(finishedAccounts.storeOrderId, order.id),
              ),
            );
        }
      }

      const [{ issuedTotal }] = await tx
        .select({ issuedTotal: sql<number>`count(*)` })
        .from(issuedCdks)
        .where(eq(issuedCdks.orderId, order.id));
      const delivered = Number(issuedTotal || 0);
      const complete = delivered >= quantity;
      const issuedNow = allocated.length - conflictedAccountIds.length;
      const short = remaining > 0 && issuedNow < remaining;

      if (complete) {
        const accounts = await tx.query.finishedAccounts.findMany({
          where: eq(finishedAccounts.storeOrderId, order.id),
        });
        if (
          accounts.length === quantity &&
          accounts.every((row) => row.costCents != null)
        ) {
          const total = accounts.reduce((sum, row) => sum + (row.costCents ?? 0), 0);
          const ledger = computeOrderLedger(
            ledgerInputFromOrder({
              ...freshOrder,
              upstreamCostTotalCents: total,
            }),
            { gatewayFeeCents: freshOrder.finalPaymentFeeCents },
          );
          const sameUnit = accounts.every(
            (row) => row.costCents === accounts[0]?.costCents,
          );
          await tx
            .update(storeOrders)
            .set({
              upstreamCostUnitCents: sameUnit ? (accounts[0]?.costCents ?? null) : null,
              upstreamCostTotalCents: total,
              upstreamCostSource: "finished_account",
              platformProfitCents: ledger.platformProfitCents,
              updatedAt: now,
            })
            .where(eq(storeOrders.id, order.id));
        }
        await tx
          .insert(agentEarnings)
          .values({
            orderId: order.id,
            agentId: order.agentId,
            ...earningSnapshotFromOrder(freshOrder),
            feeSource:
              freshOrder.feeReconcileStatus === "confirmed"
                ? "gateway_actual"
                : freshOrder.feeReconcileStatus === "unsupported"
                  ? "configured_fallback"
                  : "estimated",
            status: "pending",
            confirmedAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: agentEarnings.orderId });
        mailDelivered = true;
      }

      const released = await tx
        .update(storeOrders)
        .set({
          fulfillStatus: complete
            ? "delivered"
            : delivered > 0
              ? "partially_delivered"
              : "paid_undelivered",
          deliveredAt: complete ? now : freshOrder.deliveredAt,
          deliveryMailStatus:
            complete && !freshOrder.deliveryMailStatus ? "pending" : freshOrder.deliveryMailStatus,
          lastErrorCode: complete
            ? ""
            : short
              ? "LOCAL_ACCOUNT_STOCK_SHORT"
              : "LOCAL_ACCOUNT_PARTIAL",
          lastErrorMessage: complete
            ? ""
            : `成品号库存不足，已出 ${delivered}/${quantity}，补货后会自动继续发放`,
          updatedAt: now,
        })
        .where(
          and(
            eq(storeOrders.id, order.id),
            eq(storeOrders.fulfillStatus, "issuing"),
            eq(storeOrders.lastErrorCode, leaseToken),
          ),
        )
        .returning({ id: storeOrders.id });
      if (released.length === 0) {
        // 事务内已校验过租约，这里只是兜底；抛出让成品号分配和收益一起回滚。
        throw new LeaseLostError("发货租约已失效，成品号分配已回滚");
      }

      await tx
        .update(fulfillmentAttempts)
        .set({
          // 缺货不是故障：补货后还要继续发。打成 failed 会吃掉重试预算，最后卡成 unknown。
          result: complete ? "success" : "partial",
          responseSummaryJson: JSON.stringify({
            issued: issuedNow,
            deliveredTotal: delivered,
            quantity,
            accountIds: allocated
              .map((row) => row.id)
              .filter((id) => !conflictedAccountIds.includes(id)),
            ...(conflictedAccountIds.length > 0
              ? { conflictedAccountIds }
              : {}),
          }),
          errorCode: complete
            ? ""
            : short
              ? "LOCAL_ACCOUNT_STOCK_SHORT"
              : "",
          errorMessage: complete
            ? ""
            : `成品号库存不足，已出 ${delivered}/${quantity}`,
          finishedAt: now,
        })
        .where(eq(fulfillmentAttempts.id, createdAttempt.id));
    });
    if (mailDelivered) queueDeliveryMail(order.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "成品号发放失败";
    const leaseLost = error instanceof LeaseLostError;
    await db.transaction(async (tx) => {
      // 本地成品号在同一个事务里分配，失败就整体回滚，库存不会丢；
      // 只有仍持有租约时才把订单放回可重试状态，租约丢了就不碰订单。
      if (!leaseLost) {
        await tx
          .update(storeOrders)
          .set({
            fulfillStatus:
              existing.length > 0 ? "partially_delivered" : "paid_undelivered",
            lastErrorCode: "LOCAL_ACCOUNT_FAILED",
            lastErrorMessage: message.slice(0, 500),
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(storeOrders.id, order.id),
              eq(storeOrders.fulfillStatus, "issuing"),
              eq(storeOrders.lastErrorCode, leaseToken),
            ),
          );
      }
      await tx
        .update(fulfillmentAttempts)
        .set({
          result: "failed",
          errorCode: leaseLost ? "LEASE_LOST" : "LOCAL_ACCOUNT_FAILED",
          errorMessage: message.slice(0, 500),
          finishedAt: new Date().toISOString(),
        })
        .where(eq(fulfillmentAttempts.id, createdAttempt.id));
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

function queueDeliveryMail(orderId: number) {
  void import("@/lib/mail")
    .then(({ sendDeliveryMail }) => sendDeliveryMail(orderId))
    .catch((error) => {
      console.warn(
        `[fulfill] 发货邮件失败：${error instanceof Error ? error.message : error}`,
      );
    });
}
