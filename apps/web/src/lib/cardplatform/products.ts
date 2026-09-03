import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accountCardProductCache,
  cardplatformAccounts,
} from "@/db/schema";
import { CardplatformClient } from "./client";
import { getCardplatformClientById } from "./config";

export type SyncedCardProduct = {
  productCode: string;
  issuer: string;
  bin: string;
  network: string;
  issuingArea: string;
  scene: string;
  cardGroup: string;
  description: string;
  binHeads: string;
  enabled: boolean;
  suspendedAt: string;
};

function overlayDetails(
  items: SyncedCardProduct[],
  extras: Awaited<ReturnType<CardplatformClient["getProducts"]>>,
) {
  const byCode = new Map(
    extras.map((item) => [item.product_code.trim().toUpperCase(), item]),
  );
  return items.map((item) => {
    const extra = byCode.get(item.productCode.trim().toUpperCase());
    if (!extra) return item;
    return {
      ...item,
      bin: item.bin || extra.bin,
      issuer: item.issuer || extra.issuer,
      network: item.network || extra.network,
      issuingArea: item.issuingArea || extra.issuing_area,
      scene: item.scene || extra.scene,
      cardGroup: item.cardGroup || extra.card_group,
      description: item.description || extra.description,
      binHeads:
        item.binHeads ||
        (extra.bin_heads.length ? JSON.stringify(extra.bin_heads) : ""),
    };
  });
}

export async function fetchProductsForCache(client: CardplatformClient) {
  try {
    const direct = await client.getDirectCardProducts();
    if (direct.length > 0) {
      const loose: SyncedCardProduct[] = [];
      const strict: SyncedCardProduct[] = [];
      let strictOnline = 0;
      for (const item of direct) {
        const code = item.product_code.trim();
        if (!code) continue;
        const suspendedAt = item.suspended
          ? item.suspend_reason?.trim() || "suspended"
          : "";
        const base: SyncedCardProduct = {
          productCode: code,
          issuer: item.issuer,
          bin: item.bin,
          network: "",
          issuingArea: "",
          scene: "",
          cardGroup: "",
          description: item.label,
          binHeads: "",
          enabled: item.enabled && !item.suspended,
          suspendedAt,
        };
        const strictItem = {
          ...base,
          enabled: base.enabled && (item.usable || item.channel_open),
        };
        loose.push(base);
        strict.push(strictItem);
        if (strictItem.enabled) strictOnline += 1;
      }
      const chosen = strictOnline > 0 ? strict : loose;
      try {
        return overlayDetails(chosen, await client.getProducts());
      } catch {
        return chosen;
      }
    }
  } catch {
    /* fall through to /products */
  }
  const products = await client.getProducts();
  return products
    .filter((item) => item.product_code.trim())
    .map((item) => ({
      productCode: item.product_code.trim(),
      issuer: item.issuer,
      bin: item.bin,
      network: item.network,
      issuingArea: item.issuing_area,
      scene: item.scene,
      cardGroup: item.card_group,
      description: item.description,
      binHeads: item.bin_heads.length ? JSON.stringify(item.bin_heads) : "",
      enabled: item.enabled !== false && !item.suspended_at,
      suspendedAt: item.suspended_at,
    }));
}

export async function syncAccountProducts(accountId: number) {
  const { client } = await getCardplatformClientById(accountId, {
    allowDisabled: true,
  });
  const items = await fetchProductsForCache(client);
  const now = new Date().toISOString();
  const present = new Set(items.map((item) => item.productCode));
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .insert(accountCardProductCache)
        .values({
          accountId,
          productCode: item.productCode,
          issuer: item.issuer,
          bin: item.bin,
          network: item.network,
          issuingArea: item.issuingArea,
          scene: item.scene,
          cardGroup: item.cardGroup,
          description: item.description,
          binHeads: item.binHeads,
          enabled: item.enabled,
          suspendedAt: item.suspendedAt,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            accountCardProductCache.accountId,
            accountCardProductCache.productCode,
          ],
          set: {
            issuer: item.issuer,
            bin: item.bin,
            network: item.network,
            issuingArea: item.issuingArea,
            scene: item.scene,
            cardGroup: item.cardGroup,
            description: item.description,
            binHeads: item.binHeads,
            enabled: item.enabled,
            suspendedAt: item.suspendedAt,
            syncedAt: now,
          },
        });
    }
    const existing = await tx
      .select()
      .from(accountCardProductCache)
      .where(eq(accountCardProductCache.accountId, accountId));
    for (const row of existing) {
      if (present.has(row.productCode)) continue;
      await tx
        .update(accountCardProductCache)
        .set({ enabled: false, syncedAt: now })
        .where(
          and(
            eq(accountCardProductCache.accountId, accountId),
            eq(accountCardProductCache.productCode, row.productCode),
          ),
        );
    }
    await tx
      .update(cardplatformAccounts)
      .set({
        lastProductsSyncAt: now,
        lastHealthAt: now,
        lastOkAt: now,
        lastError: "",
        updatedAt: now,
      })
      .where(eq(cardplatformAccounts.id, accountId));
  });
  return {
    count: items.length,
    online: items.filter((item) => item.enabled && !item.suspendedAt).length,
    syncedAt: now,
  };
}

export async function syncEnabledAccountProducts() {
  const accounts = await db.query.cardplatformAccounts.findMany({
    where: eq(cardplatformAccounts.enabled, true),
  });
  const results = [];
  for (const account of accounts) {
    try {
      results.push({
        accountId: account.id,
        ...(await syncAccountProducts(account.id)),
      });
    } catch (error) {
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(cardplatformAccounts)
        .set({
          lastError: message.slice(0, 500),
          lastErrorAt: now,
          updatedAt: now,
        })
        .where(eq(cardplatformAccounts.id, account.id));
      results.push({
        accountId: account.id,
        error: message,
      });
    }
  }
  return results;
}
