import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { cardplatformAccounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { CardplatformClient, type CardplatformConfig } from "./client";

export function envCardplatformConfig(): CardplatformConfig | null {
  const siteBase = (
    process.env.CARD_API_BASE ||
    process.env.KAIMI_CARDPLATFORM_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/openapi(?:\/v1)?$/i, "");
  const apiKey = (
    process.env.CARD_API_KEY ||
    process.env.KAIMI_CARDPLATFORM_API_KEY ||
    ""
  ).trim();
  if (!siteBase || !apiKey) return null;
  return { siteBase, apiKey };
}

export async function getDefaultCardplatformAccount() {
  const preferred = await db.query.cardplatformAccounts.findFirst({
    where: and(
      eq(cardplatformAccounts.enabled, true),
      eq(cardplatformAccounts.isDefault, true),
    ),
    orderBy: [asc(cardplatformAccounts.priority), desc(cardplatformAccounts.id)],
  });
  return (
    preferred ??
    (await db.query.cardplatformAccounts.findMany({
      where: eq(cardplatformAccounts.enabled, true),
      orderBy: [
        asc(cardplatformAccounts.priority),
        desc(cardplatformAccounts.id),
      ],
    }).then((rows) => rows[0]))
  );
}

export async function getDefaultCardplatformClient() {
  const account = await getDefaultCardplatformAccount();
  if (account) {
    return {
      account,
      client: new CardplatformClient({
        siteBase: account.siteBase,
        apiKey: decryptSecret(account.apiKeyEncrypted),
      }),
    };
  }
  const env = envCardplatformConfig();
  if (!env) throw new Error("卡台账户未配置");
  return {
    account: {
      id: 0,
      siteBase: env.siteBase,
      enabled: true,
    },
    client: new CardplatformClient(env),
  };
}

export async function getCardplatformClientById(
  id: number,
  options?: { allowDisabled?: boolean },
) {
  if (id === 0) {
    const env = envCardplatformConfig();
    if (!env) throw new Error("卡台账户未配置");
    return {
      account: { id: 0, siteBase: env.siteBase, enabled: true },
      client: new CardplatformClient(env),
    };
  }
  const account = await db.query.cardplatformAccounts.findFirst({
    where: options?.allowDisabled
      ? eq(cardplatformAccounts.id, id)
      : and(
          eq(cardplatformAccounts.id, id),
          eq(cardplatformAccounts.enabled, true),
        ),
  });
  if (!account) throw new Error("订单绑定的卡台账户不可用");
  return {
    account,
    client: new CardplatformClient({
      siteBase: account.siteBase,
      apiKey: decryptSecret(account.apiKeyEncrypted),
    }),
  };
}
