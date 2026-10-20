import { and, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, folioInvoiceEvents, storeOrders } from "@/db/schema";
import { dispatchNotifyText } from "@/lib/notify";
import { agentNotifyStaleBefore } from "@/lib/notify-retry";
import {
  formatAgentInvoiceNoticeHtml,
  formatAgentInvoiceNoticeText,
} from "@/lib/folio/agent-notice-core";
import type { FolioNoticeKind } from "@/lib/folio/core";

export type AgentInvoiceNoticeResult = { status: string; error: string };

async function finish(eventRowId: number, values: Partial<typeof folioInvoiceEvents.$inferInsert>) {
  await db
    .update(folioInvoiceEvents)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(folioInvoiceEvents.id, eventRowId));
}

function emailStatusOf(payloadJson: string) {
  try {
    const value = JSON.parse(payloadJson) as { email_status?: unknown };
    return typeof value.email_status === "string" ? value.email_status : "";
  } catch {
    return "";
  }
}

/**
 * 后台任务 notify_agent_invoice：用代理绑定的 Telegram 发开票通知。步骤同 deliverAgentStorePaid。
 * 没绑定、关了通知记 skipped，不重试；Telegram 发送失败记 failed 并抛错，交给后台任务退避重试。
 * force（后台补发）可以重新占用 sent / skipped 的行。
 */
export async function deliverAgentInvoiceNotice(
  eventRowId: number,
  options: { force?: boolean } = {},
): Promise<AgentInvoiceNoticeResult> {
  const nowMs = Date.now();
  const staleSending = and(
    eq(folioInvoiceEvents.agentNotifyStatus, "sending"),
    lt(folioInvoiceEvents.updatedAt, agentNotifyStaleBefore(nowMs)),
  );
  const claimable = options.force
    ? or(ne(folioInvoiceEvents.agentNotifyStatus, "sending"), staleSending)
    : or(inArray(folioInvoiceEvents.agentNotifyStatus, ["pending", "failed"]), staleSending);
  const [event] = await db
    .update(folioInvoiceEvents)
    .set({ agentNotifyStatus: "sending", updatedAt: new Date(nowMs).toISOString() })
    .where(and(eq(folioInvoiceEvents.id, eventRowId), ne(folioInvoiceEvents.noticeKind, ""), claimable))
    .returning();
  if (!event) return { status: "", error: "这条通知正在发送或已处理" };

  const order = await db.query.storeOrders.findFirst({ where: eq(storeOrders.id, event.orderId) });
  const agent = order
    ? await db.query.agents.findFirst({
        where: eq(agents.id, order.agentId),
        columns: { telegramChatId: true, telegramNotifyEnabled: true, invoiceNotifyEnabled: true },
      })
    : undefined;
  const skipReason = !order
    ? "订单不存在"
    : !agent?.telegramChatId
      ? "代理还没绑定 Telegram"
      : agent.telegramNotifyEnabled === false
        ? "代理关闭了 Telegram 通知"
        : agent.invoiceNotifyEnabled === false
          ? "代理关闭了开票完成通知"
          : "";
  if (skipReason || !order || !agent) {
    await finish(event.id, { agentNotifyStatus: "skipped", agentNotifyError: skipReason });
    return { status: "skipped", error: skipReason };
  }

  const notice = {
    kind: event.noticeKind as FolioNoticeKind,
    orderNo: order.orderNo,
    productName: order.productNameSnapshot,
    quantity: order.quantity,
    issuedAt: event.kprq,
    email: order.invoiceEmail,
    emailStatus: emailStatusOf(event.payloadJson),
    redReasonCode: event.redReasonCode,
  };
  let error = "";
  try {
    const result = await dispatchNotifyText(
      formatAgentInvoiceNoticeText(notice),
      { audience: "agent", orderNo: order.orderNo, event: event.event },
      "invoice.agent",
      { telegramChatId: agent.telegramChatId, webhookUrl: "" },
      formatAgentInvoiceNoticeHtml(notice),
    );
    if (result.telegram.ok) {
      await finish(event.id, {
        agentNotifyStatus: "sent",
        agentNotifyError: "",
        agentNotifiedAt: new Date().toISOString(),
      });
      return { status: "sent", error: "" };
    }
    error = result.telegram.error || "未配置 Telegram 机器人";
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "发送失败";
  }
  await db
    .update(folioInvoiceEvents)
    .set({
      agentNotifyStatus: "failed",
      agentNotifyError: error.slice(0, 300),
      agentNotifyAttempts: sql`${folioInvoiceEvents.agentNotifyAttempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(folioInvoiceEvents.id, event.id));
  throw new Error(error);
}

/** 后台补发：最近一条要通知代理的事件，忽略之前的 sent / skipped。 */
export async function resendLatestAgentInvoiceNotice(orderId: number): Promise<AgentInvoiceNoticeResult> {
  const latest = await db.query.folioInvoiceEvents.findFirst({
    where: and(eq(folioInvoiceEvents.orderId, orderId), ne(folioInvoiceEvents.noticeKind, "")),
    orderBy: [desc(folioInvoiceEvents.id)],
    columns: { id: true },
  });
  if (!latest) return { status: "", error: "这单还没有开票通知可以补发" };
  try {
    return await deliverAgentInvoiceNotice(latest.id, { force: true });
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "发送失败" };
  }
}
