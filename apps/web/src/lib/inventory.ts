import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool } from "@/db/schema";
import { bootDb } from "@/lib/config";
import {
  previewRedeemableCdk,
  summarizePreview,
} from "@/lib/cardplatform/redeem";
import { decryptSecret, hashLookupValue } from "@/lib/crypto";
import { REDEEM_CODE_MIN_LENGTH } from "@/lib/redeem-code";

/**
 * cdk_pool 是旧的内部发卡库存，已经没有任何地方往里写。存量卡密还得能被认出来
 * （兑换时算「本站卡」），兑换结束后能标记已用或释放。卡密是密文，按 code_hash 查。
 */

export function normalizeCdkCode(code: string) {
  return code.trim().toUpperCase();
}

type PoolRow = typeof cdkPool.$inferSelect;

/** 解出明文；迁移前的老行 code_encrypted 还是空的，code 列本身就是明文。 */
export function poolCode(row: Pick<PoolRow, "code" | "codeEncrypted">) {
  return row.codeEncrypted ? decryptSecret(row.codeEncrypted) : row.code;
}

export async function findCdkByCode(code: string) {
  const normalized = normalizeCdkCode(code);
  if (!normalized) return undefined;
  const row = await db.query.cdkPool.findFirst({
    where: eq(cdkPool.codeHash, hashLookupValue(normalized)),
  });
  if (!row) return undefined;
  const plain = poolCode(row);
  return normalizeCdkCode(plain) === normalized ? { ...row, code: plain } : undefined;
}

/** 按订单把库存卡密的明文取出来，后台订单列表展示和旧售码订单查询用。 */
export async function poolCodesByOrderIds(orderIds: number[]) {
  if (!orderIds.length) return [];
  const rows = await db
    .select({ orderId: cdkPool.orderId, code: cdkPool.code, codeEncrypted: cdkPool.codeEncrypted })
    .from(cdkPool)
    .where(inArray(cdkPool.orderId, orderIds));
  return rows.map((row) => ({ orderId: row.orderId, code: poolCode(row) }));
}

export async function markCodeUsed(code: string) {
  const row = await findCdkByCode(code);
  if (!row) return;
  const now = new Date().toISOString();
  await db
    .update(cdkPool)
    .set({ status: "used", usedAt: now, updatedAt: now })
    .where(and(eq(cdkPool.id, row.id), inArray(cdkPool.status, ["locked", "unused", "sold"])));
}

export async function releaseLockedCode(code: string) {
  const row = await findCdkByCode(code);
  if (!row) return;
  await db
    .update(cdkPool)
    .set({
      status: row.soldAt ? "sold" : "unused",
      orderId: null,
      lockedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, "locked")));
}

export async function validateCodeForRedeem(code: string) {
  await bootDb();
  const trimmed = code.trim();
  if (!trimmed || trimmed.length < REDEEM_CODE_MIN_LENGTH) {
    throw new Error("请输入完整卡密");
  }
  try {
    const previewed = await previewRedeemableCdk(trimmed);
    return summarizePreview(previewed);
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "卡密校验失败",
    };
  }
}

export async function countByStatus() {
  await bootDb();
  const rows = await db
    .select({
      status: cdkPool.status,
      c: sql<number>`count(*)`,
    })
    .from(cdkPool)
    .groupBy(cdkPool.status);
  const map: Record<string, number> = {
    unused: 0,
    locked: 0,
    sold: 0,
    used: 0,
    disabled: 0,
  };
  for (const r of rows) {
    map[r.status] = Number(r.c ?? 0);
  }
  return map;
}
