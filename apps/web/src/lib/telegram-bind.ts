import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { agentTelegramBindCodes, agents } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { sanitizeLog } from "@/lib/log";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60 * 1000;

async function telegramToken() {
  const raw = (await getSetting("telegram_bot_token", "")).trim();
  if (!raw) return "";
  try {
    return decryptSecret(raw).trim();
  } catch {
    return "";
  }
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function rememberPollError(message: string) {
  const current = (await getSetting("telegram_bind_poll_error", "")).trim();
  if (current === message) return;
  await setSetting("telegram_bind_poll_error", message);
}

async function botUsername(token: string) {
  const hash = tokenHash(token);
  const [cached, cachedHash] = await Promise.all([
    getSetting("telegram_bot_username", ""),
    getSetting("telegram_bot_username_token_hash", ""),
  ]);
  if (cached.trim() && cachedHash === hash) return cached.trim();
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: { username?: string };
  } | null;
  const username = data?.result?.username || "";
  if (username) {
    await setSetting("telegram_bot_username", username);
    await setSetting("telegram_bot_username_token_hash", hash);
  }
  return username;
}

export async function issueAgentBindCode(agentId: number) {
  const token = await telegramToken();
  if (!token) throw new Error("管理员还没配置 Telegram 机器人");
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await db.delete(agentTelegramBindCodes).where(eq(agentTelegramBindCodes.agentId, agentId));
  await db.insert(agentTelegramBindCodes).values({ agentId, code, expiresAt });
  return { code, expiresAt, botUsername: await botUsername(token) };
}

export async function unbindAgentTelegram(agentId: number) {
  await db.delete(agentTelegramBindCodes).where(eq(agentTelegramBindCodes.agentId, agentId));
  await db
    .update(agents)
    .set({
      telegramChatId: "",
      telegramUsername: "",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, agentId));
}

type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat?: { id?: number }; from?: { username?: string } };
};

export async function pollTelegramBinds() {
  const token = await telegramToken();
  if (!token) {
    await rememberPollError("");
    return { handled: 0 };
  }
  const offset = Number(await getSetting("telegram_update_offset", "0")) || 0;
  let res: Response;
  try {
    res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`,
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "getUpdates failed";
    await rememberPollError(message);
    console.warn("[kaimi-notify] getUpdates", sanitizeLog(message));
    return { handled: 0 };
  }
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    result?: TelegramUpdate[];
  } | null;
  if (!data?.ok) {
    const message = data?.description || `HTTP ${res.status}`;
    await rememberPollError(message);
    console.warn("[kaimi-notify] getUpdates", sanitizeLog(message));
    return { handled: 0 };
  }
  await rememberPollError("");
  let next = offset;
  let handled = 0;
  for (const update of data.result || []) {
    next = update.update_id + 1;
    const text = (update.message?.text || "").trim();
    const chatId = update.message?.chat?.id;
    const match = text.match(/^\/bind(?:@\w+)?\s+([A-Za-z0-9]{6,16})$/i);
    if (!match || chatId == null) continue;
    const reply = await claimBindCode(
      match[1].toUpperCase(),
      String(chatId),
      update.message?.from?.username || "",
    );
    handled += 1;
    await sendTelegram(token, String(chatId), reply);
  }
  if (next !== offset) await setSetting("telegram_update_offset", String(next));
  return { handled };
}

async function claimBindCode(code: string, chatId: string, username: string) {
  const now = new Date().toISOString();
  const row = await db.query.agentTelegramBindCodes.findFirst({
    where: eq(agentTelegramBindCodes.code, code),
  });
  if (!row || row.expiresAt <= now) {
    if (row) await db.delete(agentTelegramBindCodes).where(eq(agentTelegramBindCodes.id, row.id));
    return "绑定码无效或已过期。请回代理后台重新生成。";
  }
  const taken = await db.query.agents.findFirst({
    where: and(eq(agents.telegramChatId, chatId), ne(agents.id, row.agentId)),
    columns: { id: true },
  });
  if (taken) return "这个 Telegram 已经绑在别的店铺上。";
    await db
    .update(agents)
    .set({
      telegramChatId: chatId,
      telegramUsername: username.replace(/^@/, ""),
      updatedAt: now,
    })
    .where(eq(agents.id, row.agentId));
  await db.delete(agentTelegramBindCodes).where(eq(agentTelegramBindCodes.agentId, row.agentId));
  return "已绑定。之后这个店铺有人付款，通知会发到这里。";
}

async function sendTelegram(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined);
}

export async function readBindPollError() {
  return (await getSetting("telegram_bind_poll_error", "")).trim();
}

export async function listAgentTelegramBindings() {
  const rows = await db.query.agents.findMany({
    columns: {
      id: true,
      displayName: true,
      shopName: true,
      telegramChatId: true,
      telegramUsername: true,
      telegramNotifyEnabled: true,
    },
  });
  return rows
    .filter((row) => row.telegramChatId)
    .map((row) => ({
      id: row.id,
      name: (row.shopName || "").trim() || row.displayName,
      username: row.telegramUsername,
      enabled: row.telegramNotifyEnabled,
    }));
}
