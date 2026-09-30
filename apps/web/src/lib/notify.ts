import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, storeOrders } from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { getSetting } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { maskRequestId, sanitizeLog } from "@/lib/log";
import { loadRedeemNotifyContext } from "@/lib/notify-commerce";
import {
  formatDrawAlertTelegramHtml,
  formatDrawAlertText,
  formatDrawApplyTelegramHtml,
  formatDrawApplyText,
  formatDrawCreatedTelegramHtml,
  formatDrawCreatedText,
  formatNotifyText,
  formatStorePaidTelegramHtml,
  formatStorePaidText,
  notifyYuanFields,
  type DrawAlertNotifyPayload,
  type DrawApplyNotifyPayload,
  type DrawCreatedNotifyPayload,
  type NotifyPayload,
  type StorePaidNotifyPayload,
} from "@/lib/notify-core";

export type { NotifyPayload } from "@/lib/notify-core";
export { SAMPLE_NOTIFY_PAYLOAD, formatNotifyText } from "@/lib/notify-core";

export type NotifyChannelOverrides = {
  webhookUrl?: string;
  telegramToken?: string;
  telegramChatId?: string;
};

export type NotifyDispatchResult = {
  text: string;
  webhook: { attempted: boolean; ok: boolean; error: string };
  telegram: { attempted: boolean; ok: boolean; error: string };
};

const FETCH_MS = 8000;

async function readTelegramToken() {
  const raw = (await getSetting("telegram_bot_token", "")).trim();
  if (!raw) return "";
  try {
    return decryptSecret(raw).trim();
  } catch (err) {
    console.warn("[kaimi-notify] telegram token decrypt failed", sanitizeLog(err));
    return "";
  }
}

function usableWebhookUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^https?:\/\/(www\.)?example\.com(\/|$)/i.test(trimmed)) return "";
  return trimmed;
}

function telegramErrorMessage(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err || "");
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|AbortError|undici/i.test(raw)) {
    return "服务器连不上 api.telegram.org，国内机器常见。Chat ID 请填 chat.id，不要填 update_id";
  }
  return raw || "telegram failed";
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { description?: string } | null;
    throw new Error(data?.description || `HTTP ${res.status}`);
  }
}

export async function resolveNotifyChannels(overrides: NotifyChannelOverrides = {}) {
  const webhookUrl = usableWebhookUrl(
    overrides.webhookUrl ?? (await getSetting("notify_webhook_url", "")),
  );
  const telegramToken = (overrides.telegramToken ?? (await readTelegramToken())).trim();
  const telegramChatId = (overrides.telegramChatId ?? (await getSetting("telegram_chat_id", ""))).trim();
  return { webhookUrl, telegramToken, telegramChatId };
}

async function sendNotifyChannels(
  text: string,
  webhookBody: Record<string, unknown>,
  overrides: NotifyChannelOverrides = {},
  telegramHtml?: string,
): Promise<NotifyDispatchResult> {
  const channels = await resolveNotifyChannels(overrides);
  const result: NotifyDispatchResult = {
    text,
    webhook: { attempted: false, ok: false, error: "" },
    telegram: { attempted: false, ok: false, error: "" },
  };

  if (channels.webhookUrl) {
    result.webhook.attempted = true;
    try {
      await postJson(channels.webhookUrl, webhookBody);
      result.webhook.ok = true;
    } catch (err) {
      result.webhook.error = err instanceof Error ? err.message : "webhook failed";
      console.warn("[kaimi-notify] webhook failed", sanitizeLog(err));
    }
  }

  if (channels.telegramToken && channels.telegramChatId) {
    result.telegram.attempted = true;
    try {
      await postJson(`https://api.telegram.org/bot${channels.telegramToken}/sendMessage`, {
        chat_id: channels.telegramChatId,
        text: telegramHtml || text,
        ...(telegramHtml ? { parse_mode: "HTML" } : {}),
      });
      result.telegram.ok = true;
    } catch (err) {
      result.telegram.error = telegramErrorMessage(err);
      console.warn("[kaimi-notify] telegram failed", sanitizeLog(err));
    }
  }

  return result;
}

export async function dispatchNotify(
  payload: NotifyPayload,
  overrides: NotifyChannelOverrides = {},
  event = "order.terminal",
): Promise<NotifyDispatchResult> {
  const maskedRequestId = maskRequestId(payload.requestId);
  const full = { ...payload, requestId: maskedRequestId };
  const text = formatNotifyText(full);
  return sendNotifyChannels(
    text,
    {
      event,
      ...full,
      ...notifyYuanFields(full),
      text,
    },
    overrides,
  );
}

export async function dispatchNotifyText(
  text: string,
  extra: Record<string, unknown> = {},
  event = "invoice.paid",
  overrides: NotifyChannelOverrides = {},
  telegramHtml?: string,
): Promise<NotifyDispatchResult> {
  return sendNotifyChannels(
    text,
    {
      event,
      text,
      ...extra,
    },
    overrides,
    telegramHtml,
  );
}

export async function notifyStoreInvoicePaid(order: {
  id?: number;
  orderNo: string;
  agentId: number;
  customerEmail?: string;
  paymentChannel?: string;
  productNameSnapshot?: string;
  quantity?: number;
  listGoodsCents?: number;
  couponCodeSnapshot?: string;
  couponDiscountCents?: number;
  invoiceSurchargeCents?: number;
  agentCostTotalCents?: number;
  agentFeeCents?: number;
  agentEarningCents?: number;
  upstreamCostTotalCents?: number | null;
  platformProfitCents?: number | null;
  invoiceRequested?: boolean;
  invoiceTitle: string;
  invoiceTaxNo?: string;
  invoiceNote: string;
  invoiceEmail: string;
  invoiceAmountCents: number;
  grossCents: number;
  invoiceNotifyStatus?: string | null;
}, options?: { force?: boolean }) {
  if (!options?.force && order.invoiceNotifyStatus === "sent") {
    return {
      text: "",
      webhook: { attempted: false, ok: false, error: "" },
      telegram: { attempted: false, ok: false, error: "" },
    };
  }
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, order.agentId),
    columns: { displayName: true, shopName: true, currentSlug: true },
  });
  const goodsCents = Math.max(0, order.grossCents - (order.invoiceSurchargeCents || 0));
  const payload: StorePaidNotifyPayload = {
    orderNo: order.orderNo,
    agentName: agent ? publicShopName(agent) || agent.currentSlug : "",
    buyerEmail: order.customerEmail || order.invoiceEmail,
    amountCents: order.grossCents,
    paymentChannel: order.paymentChannel,
    productName: order.productNameSnapshot,
    quantity: order.quantity,
    listGoodsCents: order.listGoodsCents && order.listGoodsCents > 0 ? order.listGoodsCents : goodsCents,
    couponCode: order.couponCodeSnapshot || undefined,
    couponDiscountCents: order.couponDiscountCents || undefined,
    goodsCents,
    agentCostTotalCents: order.agentCostTotalCents,
    agentFeeCents: order.agentFeeCents,
    agentEarningCents: order.agentEarningCents,
    upstreamCostTotalCents: order.upstreamCostTotalCents,
    platformProfitCents: order.platformProfitCents,
    invoice: order.invoiceRequested
      ? {
          title: order.invoiceTitle,
          taxNo: order.invoiceTaxNo || "",
          note: order.invoiceNote,
          amountCents: order.invoiceAmountCents || order.grossCents,
          email: order.invoiceEmail || order.customerEmail || "",
        }
      : null,
  };
  const text = formatStorePaidText(payload);
  const result = await dispatchNotifyText(
    text,
    { ...payload, invoiceRequested: true },
    order.invoiceRequested ? "invoice.paid" : "store.paid",
    {},
    formatStorePaidTelegramHtml(payload),
  );
  const status =
    result.telegram.ok || result.webhook.ok
      ? "sent"
      : result.telegram.attempted || result.webhook.attempted
        ? "failed"
        : "unsent";
  const error =
    result.telegram.error ||
    result.webhook.error ||
    (status === "unsent" ? "未配置 Telegram 或 Webhook" : "");
  const now = new Date().toISOString();
  await db
    .update(storeOrders)
    .set({
      invoiceNotifyStatus: status,
      invoiceNotifyError: error,
      invoiceNotifiedAt: now,
      updatedAt: now,
    })
    .where(
      order.id
        ? eq(storeOrders.id, order.id)
        : eq(storeOrders.orderNo, order.orderNo),
    );
  return result;
}

function notifyOutcome(result: NotifyDispatchResult) {
  const status =
    result.telegram.ok || result.webhook.ok
      ? "sent"
      : result.telegram.attempted || result.webhook.attempted
        ? "failed"
        : "unsent";
  const error =
    status === "sent"
      ? ""
      : result.telegram.error ||
        result.webhook.error ||
        (status === "unsent" ? "未配置 Telegram 或 Webhook" : "");
  return { status, error };
}

export async function notifyDrawApply(payload: DrawApplyNotifyPayload) {
  const result = await dispatchNotifyText(
    formatDrawApplyText(payload),
    { ...payload },
    payload.kind === "remind" ? "draw.remind" : "draw.apply",
    {},
    formatDrawApplyTelegramHtml(payload),
  );
  return notifyOutcome(result);
}

export async function notifyDrawCreated(payload: DrawCreatedNotifyPayload) {
  const result = await dispatchNotifyText(
    formatDrawCreatedText(payload),
    { ...payload },
    "draw.created",
    {},
    formatDrawCreatedTelegramHtml(payload),
  );
  return notifyOutcome(result);
}

export async function notifyDrawAlert(payload: DrawAlertNotifyPayload) {
  const result = await dispatchNotifyText(
    formatDrawAlertText(payload),
    { ...payload },
    "draw.alert",
    {},
    formatDrawAlertTelegramHtml(payload),
  );
  return notifyOutcome(result);
}

export async function notifyOrderTerminal(payload: NotifyPayload) {
  const extra =
    payload.orderNo && payload.orderNo !== "OPS"
      ? await loadRedeemNotifyContext(payload.orderNo).catch((err) => {
          console.warn("[kaimi-notify] commerce context skipped", sanitizeLog(err));
          return {};
        })
      : {};
  await dispatchNotify({ ...extra, ...payload });
}

export async function notifyOpsAlert(message: string) {
  await notifyOrderTerminal({
    orderNo: "OPS",
    status: "alert",
    message,
  });
}

/** 卡台拒绝了某个付款地区。同步停售由发卡流程触发，这里只发告警。 */
export async function notifyRegionIssueRejected(input: {
  orderNo: string;
  planLabel: string;
  message: string;
}) {
  const text = [
    "[Kaimi] 地区发码被卡台拒绝",
    `套餐：${input.planLabel}`,
    `订单：${input.orderNo}`,
    `卡台返回：${input.message}`,
    "已自动触发套餐同步，该地区将在同步后停售。",
  ].join("\n");
  await dispatchNotifyText(
    text,
    { orderNo: input.orderNo, plan: input.planLabel },
    "region.rejected",
  );
}
