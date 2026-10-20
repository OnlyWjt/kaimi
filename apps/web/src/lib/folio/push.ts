import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, storeOrders } from "@/db/schema";
import { sanitizeLog } from "@/lib/log";
import { recordOpsAlert } from "@/lib/ops-health";
import {
  FOLIO_PUSH_PATH,
  FOLIO_REFUND_PATH,
  classifyFolioPush,
  classifyFolioRefund,
  folioPushBody,
} from "@/lib/folio/core";
import { folioFetch, readFolioConfig } from "@/lib/folio/sign";

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "未知错误")).slice(0, 300);
}

async function setPush(orderId: number, values: Partial<typeof storeOrders.$inferInsert>) {
  await db
    .update(storeOrders)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(storeOrders.id, orderId));
}

/**
 * 后台任务 folio_push_invoice：把开票申请推给 Folio。Folio 收到会同步回调 B 查单核对金额。
 * 抛错 = 交给后台任务退避重试；被 Folio 明确拒绝的不抛，记 rejected 并告警。
 */
export async function pushOrderToFolio(orderId: number) {
  const order = await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, orderId) });
  if (!order || !order.invoiceRequested) return;
  if (order.folioPushStatus === "pushed") return;
  const config = await readFolioConfig();
  if (!config.enabled) {
    // 开关关着：和没接 Folio 一样。之后打开可以在订单详情里补推。
    if (order.folioPushStatus === "pending") await setPush(orderId, { folioPushStatus: "", folioPushError: "" });
    return;
  }
  if (order.payStatus === "refunding") throw new Error("订单退款处理中，稍后再推");
  if (order.payStatus !== "paid") {
    await setPush(orderId, { folioPushStatus: "", folioPushError: "" });
    return;
  }

  let result: Awaited<ReturnType<typeof folioFetch>>;
  try {
    result = await folioFetch(config, "POST", FOLIO_PUSH_PATH, folioPushBody(order));
  } catch (error) {
    const message = `推送 Folio 失败：${errorText(error)}`;
    await setPush(orderId, { folioPushStatus: "pending", folioPushError: message });
    throw new Error(message);
  }
  const outcome = classifyFolioPush(result.httpStatus, result.envelope);
  if (outcome.kind === "pushed") {
    const now = new Date().toISOString();
    await setPush(orderId, {
      folioPushStatus: "pushed",
      folioPushError: "",
      folioPushedAt: now,
      ...(outcome.invoiceId ? { folioInvoiceId: outcome.invoiceId } : {}),
      // 只从空状态往前走，重复推送拿回来的不覆盖已开具 / 已作废
      ...(order.invoiceStatus ? {} : { invoiceStatus: "pending_review" }),
    });
    return;
  }
  if (outcome.kind === "rejected") {
    await setPush(orderId, { folioPushStatus: "rejected", folioPushError: outcome.error });
    await recordOpsAlert({
      level: "warning",
      code: `folio.push.rejected:${order.orderNo}`,
      message: `订单 ${order.orderNo} 推送开票被 Folio 拒绝（${outcome.error}），需人工处理`,
    }).catch((error) => console.warn("[kaimi-folio] ops alert failed", sanitizeLog(error)));
    return;
  }
  await setPush(orderId, { folioPushStatus: "pending", folioPushError: outcome.error });
  // 密钥不对时每一单都会撞上，同一单只在第一次出现时提醒
  if (outcome.kind === "unauthorized" && order.folioPushError !== outcome.error) {
    await recordOpsAlert({
      level: "warning",
      code: "folio.push.unauthorized",
      message: `推送开票到 Folio 被拒签（订单 ${order.orderNo}）：${outcome.error}`,
    }).catch((error) => console.warn("[kaimi-folio] ops alert failed", sanitizeLog(error)));
  }
  throw new Error(outcome.error);
}

/** 推单重试用尽。 */
export async function markFolioPushExhausted(orderId: number, lastError: string) {
  const [row] = await db
    .update(storeOrders)
    .set({
      folioPushStatus: "failed",
      folioPushError: lastError.slice(0, 300),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(storeOrders.id, orderId), eq(storeOrders.folioPushStatus, "pending")))
    .returning({ orderNo: storeOrders.orderNo });
  if (!row) return;
  await recordOpsAlert({
    level: "warning",
    code: `folio.push.failed:${row.orderNo}`,
    message: `订单 ${row.orderNo} 推送开票到 Folio 重试用尽（${lastError.slice(0, 200)}），请到订单详情补推`,
  }).catch((error) => console.warn("[kaimi-folio] ops alert failed", sanitizeLog(error)));
}

/** 补推：只对已付款、申请了开票、还没进 Folio（空 / rejected / failed）的单。 */
export const FOLIO_REPUSH_STATUSES = ["", "rejected", "failed"] as const;

export async function enqueueFolioPush(orderId: number) {
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(storeOrders)
      .set({ folioPushStatus: "pending", folioPushError: "", updatedAt: now })
      .where(
        and(
          eq(storeOrders.id, orderId),
          eq(storeOrders.invoiceRequested, true),
          eq(storeOrders.payStatus, "paid"),
          inArray(storeOrders.folioPushStatus, [...FOLIO_REPUSH_STATUSES]),
        ),
      )
      .returning({ id: storeOrders.id });
    if (!claimed) return false;
    // 付款时那条任务的 dedupe key 已经用过，补推带时间戳另起一条
    await tx.insert(backgroundJobs).values({
      type: "folio_push_invoice",
      dedupeKey: `folio_push_invoice:${orderId}:${Date.now()}`,
      payloadJson: JSON.stringify({ orderId }),
      runAfter: now,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  });
}

/** 退款后推给 Folio 的条件：申请了开票、推送过或可能推送过（被拒绝的 Folio 那边没有票）。 */
export const FOLIO_REFUND_PUSH_STATUSES = ["pushed", "pending", "failed"] as const;

export async function enqueueFolioRefund(orderId: number) {
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
    columns: { invoiceRequested: true, folioPushStatus: true, payStatus: true },
  });
  if (!order?.invoiceRequested || order.payStatus !== "refunded") return false;
  if (!(FOLIO_REFUND_PUSH_STATUSES as readonly string[]).includes(order.folioPushStatus)) return false;
  const now = new Date().toISOString();
  await db
    .insert(backgroundJobs)
    .values({
      type: "folio_refund_event",
      dedupeKey: `folio_refund_event:${orderId}`,
      payloadJson: JSON.stringify({ orderId }),
      runAfter: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: backgroundJobs.dedupeKey });
  return true;
}

/** 后台任务 folio_refund_event：未开具的 Folio 作废，已开具的红冲，红冲完成后会回调 invoice.reddened。 */
export async function pushRefundToFolio(orderId: number) {
  const order = await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, orderId) });
  if (!order || order.payStatus !== "refunded") return;
  if (order.folioRefundAction) return;
  const config = await readFolioConfig();
  if (!config.enabled) {
    await recordOpsAlert({
      level: "warning",
      code: `folio.refund.disabled:${order.orderNo}`,
      message: `订单 ${order.orderNo} 已退款，但 Folio 对接已关闭，没有通知 Folio。请到 Folio 手工作废或红冲`,
    }).catch((error) => console.warn("[kaimi-folio] ops alert failed", sanitizeLog(error)));
    return;
  }
  const result = await folioFetch(config, "POST", FOLIO_REFUND_PATH, {
    order_no: order.orderNo,
    is_full_refund: true,
  });
  const outcome = classifyFolioRefund(result.httpStatus, result.envelope);
  if (!outcome.ok) throw new Error(outcome.error);
  await setPush(orderId, { folioRefundAction: outcome.action.slice(0, 40) });
}

/** 退款推送重试用尽：Folio 那边的票没作废 / 红冲，要人工处理。 */
export async function markFolioRefundExhausted(orderId: number, lastError: string) {
  const order = await db.query.storeOrders.findFirst({
    where: eq(storeOrders.id, orderId),
    columns: { orderNo: true },
  });
  if (!order) return;
  await recordOpsAlert({
    level: "warning",
    code: `folio.refund.failed:${order.orderNo}`,
    message: `订单 ${order.orderNo} 退款推送 Folio 重试用尽（${lastError.slice(0, 200)}），请到 Folio 手工作废或红冲`,
  }).catch((error) => console.warn("[kaimi-folio] ops alert failed", sanitizeLog(error)));
}
