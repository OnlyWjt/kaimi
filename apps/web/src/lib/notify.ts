import { getSetting } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { maskRequestId, sanitizeLog } from "@/lib/log";
import { loadRedeemNotifyContext } from "@/lib/notify-commerce";
import {
  formatNotifyText,
  notifyYuanFields,
  type NotifyPayload,
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

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export async function resolveNotifyChannels(overrides: NotifyChannelOverrides = {}) {
  const webhookUrl = (overrides.webhookUrl ?? (await getSetting("notify_webhook_url", ""))).trim();
  const telegramToken = (overrides.telegramToken ?? (await readTelegramToken())).trim();
  const telegramChatId = (overrides.telegramChatId ?? (await getSetting("telegram_chat_id", ""))).trim();
  return { webhookUrl, telegramToken, telegramChatId };
}

export async function dispatchNotify(
  payload: NotifyPayload,
  overrides: NotifyChannelOverrides = {},
  event = "order.terminal",
): Promise<NotifyDispatchResult> {
  const maskedRequestId = maskRequestId(payload.requestId);
  const full = { ...payload, requestId: maskedRequestId };
  const text = formatNotifyText(full);
  const channels = await resolveNotifyChannels(overrides);
  const result: NotifyDispatchResult = {
    text,
    webhook: { attempted: false, ok: false, error: "" },
    telegram: { attempted: false, ok: false, error: "" },
  };

  if (channels.webhookUrl) {
    result.webhook.attempted = true;
    try {
      await postJson(channels.webhookUrl, {
        event,
        ...full,
        ...notifyYuanFields(full),
        text,
      });
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
        text,
      });
      result.telegram.ok = true;
    } catch (err) {
      result.telegram.error = err instanceof Error ? err.message : "telegram failed";
      console.warn("[kaimi-notify] telegram failed", sanitizeLog(err));
    }
  }

  return result;
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
