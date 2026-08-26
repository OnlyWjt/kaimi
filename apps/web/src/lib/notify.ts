import { getSetting } from "@/lib/config";

type NotifyPayload = {
  orderNo: string;
  status: string;
  message: string;
  requestId?: string | null;
  plan?: string;
};

export async function notifyOrderTerminal(payload: NotifyPayload) {
  const text = [
    `[Kaimi] 订单 ${payload.orderNo} → ${payload.status}`,
    payload.plan ? `套餐 ${payload.plan}` : "",
    payload.requestId ? `request_id ${payload.requestId}` : "",
    payload.message || "",
  ]
    .filter(Boolean)
    .join("\n");

  const hook = (await getSetting("notify_webhook_url", "")).trim();
  if (hook) {
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "order.terminal",
          ...payload,
          text,
        }),
      });
    } catch (err) {
      console.warn("[kaimi-notify] webhook failed", err);
    }
  }

  const token = (await getSetting("telegram_bot_token", "")).trim();
  const chatId = (await getSetting("telegram_chat_id", "")).trim();
  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (err) {
      console.warn("[kaimi-notify] telegram failed", err);
    }
  }
}
