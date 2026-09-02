import { randomUUID } from "crypto";
import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, storeOrders } from "@/db/schema";
import { fulfillStoreOrder } from "@/lib/fulfillment/fulfill-store-order";
import { refreshOpsHealth } from "@/lib/ops-health";
import { reconcilePaymentFee } from "@/lib/payments/reconcile";

const JOB_LEASE_MS = 5 * 60_000;

async function executeJob(type: string, payloadJson: string) {
  if (type === "refresh_ops_health") {
    await refreshOpsHealth();
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
      await db
        .update(backgroundJobs)
        .set({
          status: exhausted ? "failed" : "retrying",
          runAfter: new Date(failedAt.getTime() + backoffMs).toISOString(),
          lockedAt: null,
          lockedBy: "",
          lastError:
            error instanceof Error ? error.message.slice(0, 1000) : "未知错误",
          updatedAt: failedAt.toISOString(),
        })
        .where(
          and(
            eq(backgroundJobs.id, job.id),
            eq(backgroundJobs.lockedBy, workerId),
          ),
        );
      failed += 1;
    }
  }
  return { completed, failed };
}
