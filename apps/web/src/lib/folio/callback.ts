import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, folioInvoiceEvents, storeOrders } from "@/db/schema";
import { planFolioCallback, type FolioCallbackBody } from "@/lib/folio/core";

export type FolioCallbackResult =
  | { kind: "missing" }
  | { kind: "duplicate" }
  | { kind: "accepted"; applied: boolean; eventRowId: number; noticeKind: string };

/**
 * C 回调：一个事务里去重、记事件、按版本号回写订单、需要时入队代理通知。
 * 版本号不比订单上新的只留记录，不回写也不通知。
 */
export async function applyFolioCallback(body: FolioCallbackBody, rawBody: string): Promise<FolioCallbackResult> {
  return db.transaction(async (tx): Promise<FolioCallbackResult> => {
    const order = await tx.query.storeOrders.findFirst({
      where: eq(storeOrders.orderNo, body.orderNo),
      columns: { id: true, invoiceSyncVersion: true },
    });
    if (!order) return { kind: "missing" };
    const plan = planFolioCallback(order.invoiceSyncVersion, body);
    const now = new Date().toISOString();
    const [event] = await tx
      .insert(folioInvoiceEvents)
      .values({
        orderId: order.id,
        eventId: body.eventId.slice(0, 200),
        event: body.event.slice(0, 64),
        version: body.version,
        folioInvoiceId: body.invoiceId.slice(0, 64),
        previousInvoiceId: body.previousInvoiceId.slice(0, 64),
        status: body.status.slice(0, 32),
        fphm: body.fphm.slice(0, 64),
        kprq: body.kprq.slice(0, 32),
        redReasonCode: body.redReasonCode.slice(0, 8),
        applied: plan.applied,
        noticeKind: plan.noticeKind,
        agentNotifyStatus: plan.noticeKind ? "pending" : "",
        payloadJson: rawBody.slice(0, 8000),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: folioInvoiceEvents.eventId })
      .returning({ id: folioInvoiceEvents.id });
    if (!event) return { kind: "duplicate" };
    if (plan.patch) {
      await tx
        .update(storeOrders)
        .set({ ...plan.patch, updatedAt: now })
        .where(and(eq(storeOrders.id, order.id), lt(storeOrders.invoiceSyncVersion, body.version)));
    }
    if (plan.noticeKind) {
      await tx
        .insert(backgroundJobs)
        .values({
          type: "notify_agent_invoice",
          dedupeKey: `notify_agent_invoice:${event.id}`,
          payloadJson: JSON.stringify({ eventId: event.id }),
          runAfter: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: backgroundJobs.dedupeKey });
    }
    return { kind: "accepted", applied: plan.applied, eventRowId: event.id, noticeKind: plan.noticeKind };
  });
}
