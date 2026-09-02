import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import {
  cardplatformProtocolLabel,
  normalizeCardplatformProtocol,
} from "./protocol";
import { accountWebhookPublicUrl } from "./urls";

export async function listCardplatformAccounts() {
  return db.query.cardplatformAccounts.findMany({
    orderBy: [
      desc(cardplatformAccounts.isDefault),
      asc(cardplatformAccounts.priority),
      desc(cardplatformAccounts.id),
    ],
  });
}

export function presentCardplatformAccount(
  row: typeof cardplatformAccounts.$inferSelect,
  origin: string,
) {
  const key = decryptSecret(row.apiKeyEncrypted);
  const secret = decryptSecret(row.webhookSecretEncrypted);
  return {
    id: row.id,
    name: row.name,
    protocol: normalizeCardplatformProtocol(row.protocol),
    protocolLabel: cardplatformProtocolLabel(row.protocol),
    siteBase: row.siteBase,
    enabled: row.enabled,
    isDefault: row.isDefault,
    priority: row.priority,
    webhookPath: row.webhookPath,
    webhookUrl: origin
      ? accountWebhookPublicUrl(origin, row.webhookPath, row.id)
      : "",
    apiKeyConfigured: Boolean(key),
    apiKeyHint: key ? `${key.slice(0, 3)}…${key.slice(-3)}` : "",
    webhookSecretConfigured: Boolean(secret),
    webhookSecretHint: secret ? `****${secret.slice(-4)}` : "",
    lastHealthAt: row.lastHealthAt,
    lastError: row.lastError,
    lastOkAt: row.lastOkAt,
    lastErrorAt: row.lastErrorAt,
    lastPlansSyncAt: row.lastPlansSyncAt,
    lastProductsSyncAt: row.lastProductsSyncAt,
  };
}

export async function getCardplatformAccountOrThrow(id: number) {
  const account = await db.query.cardplatformAccounts.findFirst({
    where: eq(cardplatformAccounts.id, id),
  });
  if (!account) throw new Error("卡台账户不存在");
  return account;
}

export function normalizeSiteBase(siteBase: string) {
  return siteBase
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/openapi(?:\/v1)?$/i, "");
}
