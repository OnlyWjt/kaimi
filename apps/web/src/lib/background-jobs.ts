import { randomUUID } from "crypto";
import { and, asc, eq, inArray, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, storeOrders } from "@/db/schema";
import { fulfillStoreOrder } from "@/lib/fulfillment/fulfill-store-order";
import { refreshOpsHealth } from "@/lib/ops-health";
import { deliverApiWebhook } from "@/lib/open-api/webhooks";
import { reconcilePaymentFee } from "@/lib/payments/reconcile";
import { deliverAgentInvoiceNotice } from "@/lib/folio/agent-notice";
import {
  markFolioPushExhausted,
  markFolioRefundExhausted,
  pushOrderToFolio,
  pushRefundToFolio,
} from "@/lib/folio/push";

const JOB_LEASE_MS = 5 * 60_000;

function payloadId(payloadJson: string, key: "orderId" | "eventId") {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  const id = Number(payload[key]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`后台任务缺少有效 ${key}`);
  return id;
}

/** 重试用尽时的收尾：把业务上的状态落定、提醒管理员。 */
async function onJobExhausted(type: string, payloadJson: string, lastError: string) {
  if (type === "folio_push_invoice") {
    await markFolioPushExhausted(payloadId(payloadJson, "orderId"), lastError);
  } else if (type === "folio_refund_event") {
    await markFolioRefundExhausted(payloadId(payloadJson, "orderId"), lastError);
  }
}

async function executeJob(type: string, payloadJson: string) {
  if (type === "deliver_api_webhook") {
    const payload = JSON.parse(payloadJson) as { deliveryId?: unknown };
    const deliveryId = Number(payload.deliveryId);
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
      throw new Error("回调任务缺少 deliveryId");
    }
    await deliverApiWebhook(deliveryId);
    return;
  }
  if (type === "refresh_ops_health") {
    await refreshOpsHealth();
    return;
  }
  // 下面两种都发生在已退款订单上（退款推送、红冲后的「已作废」通知），要放在通用分支前面
  if (type === "notify_agent_invoice") {
    await deliverAgentInvoiceNotice(payloadId(payloadJson, "eventId"));
    return;
  }
  if (type === "folio_refund_event") {
    await pushRefundToFolio(payloadId(payloadJson, "orderId"));
    return;
  }
  const payload = JSON.parse(payloadJson) as { orderId?: unknown };
  const orderId = Number(payload.orderId);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("后台任务缺少有效 orderId");
  }
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
  });
  if (!order || order.payStatus === "refunded") return;
  if (type === "fulfill_store_order") {
    const result = await fulfillStoreOrder(orderId);
    if (
      result &&
      !["delivered", "unknown", "refunded"].includes(result.fulfillStatus)
    ) {
      throw new Error(result.lastErrorMessage || "订单尚未完成发卡");
    }
    return;
  }
  if (type === "reconcile_payment_fee") {
    const result = await reconcilePaymentFee(orderId);
    if (
      result &&
      !["confirmed", "unsupported", "manual_review"].includes(
        result.feeReconcileStatus,
      )
    ) {
      throw new Error(result.feeReconcileLastError || "手续费对账尚未完成");
    }
    return;
  }
  if (type === "folio_push_invoice") {
    await pushOrderToFolio(orderId);
    return;
  }
  throw new Error(`不支持的后台任务类型：${type}`);
}

export async function processBackgroundJobs(limit = 20) {
  const workerId = `${process.pid}:${randomUUID()}`;
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const nowIso = now.toISOString();
    const staleIso = new Date(now.getTime() - JOB_LEASE_MS).toISOString();
    const candidate = await db.query.backgroundJobs.findFirst({
      where: and(
        lte(backgroundJobs.runAfter, nowIso),
        or(
          inArray(backgroundJobs.status, ["pending", "retrying"]),
          and(
            eq(backgroundJobs.status, "running"),
            lte(backgroundJobs.lockedAt, staleIso),
          ),
        ),
      ),
      orderBy: [asc(backgroundJobs.runAfter), asc(backgroundJobs.id)],
    });
    if (!candidate) break;
    const [job] = await db
      .update(backgroundJobs)
      .set({
        status: "running",
        attempts: candidate.attempts + 1,
        lockedAt: nowIso,
        lockedBy: workerId,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(backgroundJobs.id, candidate.id),
          eq(backgroundJobs.status, candidate.status),
          eq(backgroundJobs.updatedAt, candidate.updatedAt),
        ),
      )
      .returning();
    if (!job) continue;
    try {
      await executeJob(job.type, job.payloadJson);
      const finishedAt = new Date().toISOString();
      await db
        .update(backgroundJobs)
        .set({
          status: "completed",
          completedAt: finishedAt,
          lockedAt: null,
          lockedBy: "",
          lastError: "",
          updatedAt: finishedAt,
        })
        .where(
          and(
            eq(backgroundJobs.id, job.id),
            eq(backgroundJobs.lockedBy, workerId),
          ),
        );
      completed += 1;
    } catch (error) {
      const failedAt = new Date();
      const exhausted = job.attempts >= job.maxAttempts;
      const backoffMs = Math.min(
        60 * 60_000,
        30_000 * 2 ** Math.min(7, job.attempts - 1),
      );
      const lastError =
        error instanceof Error ? error.message.slice(0, 1000) : "未知错误";
      await db
        .update(backgroundJobs)
        .set({
          status: exhausted ? "failed" : "retrying",
          runAfter: new Date(failedAt.getTime() + backoffMs).toISOString(),
          lockedAt: null,
          lockedBy: "",
          lastError,
          updatedAt: failedAt.toISOString(),
        })
        .where(
          and(
            eq(backgroundJobs.id, job.id),
            eq(backgroundJobs.lockedBy, workerId),
          ),
        );
      if (exhausted) {
        await onJobExhausted(job.type, job.payloadJson, lastError).catch((reason) => {
          console.warn(`[kaimi-jobs] exhausted hook failed ${job.type}#${job.id}`, reason);
        });
      }
      failed += 1;
    }
  }
  return { completed, failed };
}

/**
 * 已完成的任务保留 30 天，之后删掉，表不再无限长。
 *
 * dedupe_key 是唯一索引，删掉完成行等于放开了同一个 key 再入队。现有的 key 都不怕：
 * 发卡、手续费对账只在订单从未付款变成已付款那一刻入队；回调投递的 key 带投递 id 和第几次，
 * 投递记录本身也只留 30 天。Folio 推单 / 退款推送同样只在付款、退款那一刻入队（补推的 key 带时间戳），
 * 代理开票通知的 key 带回调事件行 id。失败的任务不删，后台「失败任务」要看。
 */
export const COMPLETED_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneCompletedJobs(now = Date.now()) {
  const deleted = await db
    .delete(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.status, "completed"),
        lt(backgroundJobs.updatedAt, new Date(now - COMPLETED_JOB_RETENTION_MS).toISOString()),
      ),
    )
    .returning({ id: backgroundJobs.id });
  return deleted.length;
}
