import { and, asc, eq, sql } from "drizzle-orm";
import { db, client } from "@/db";
import { cdkPool } from "@/db/schema";
import { bootDb } from "@/lib/config";
import {
  previewRedeemableCdk,
  summarizePreview,
} from "@/lib/cardplatform/redeem";

export function normalizeCdkCode(code: string) {
  return code.trim().toUpperCase();
}

export async function findCdkByCode(code: string) {
  const normalized = normalizeCdkCode(code);
  if (!normalized) return undefined;
  const exact = await db.query.cdkPool.findFirst({ where: eq(cdkPool.code, normalized) });
  if (exact) return exact;
  const rows = await db
    .select()
    .from(cdkPool)
    .where(sql`upper(trim(${cdkPool.code})) = ${normalized}`)
    .limit(1);
  return rows[0];
}

export async function reserveCodes(planKey: string, quantity: number, orderId: number) {
  if (quantity < 1) throw new Error("quantity must be >= 1");

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(cdkPool)
      .where(and(eq(cdkPool.status, "unused"), eq(cdkPool.planKey, planKey)))
      .orderBy(asc(cdkPool.id))
      .limit(quantity);

    if (rows.length < quantity) {
      throw new Error(`库存不足：需要 ${quantity}，可用 ${rows.length}`);
    }

    const now = new Date().toISOString();
    for (const row of rows) {
      const updated = await tx
        .update(cdkPool)
        .set({
          status: "locked",
          orderId,
          lockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, "unused")))
        .returning({ id: cdkPool.id });

      if (!updated.length) {
        throw new Error("库存抢占失败，请重试");
      }
    }

    return rows.map((r) => ({ id: r.id, code: r.code, planKey: r.planKey }));
  });
}

export async function markCodesSold(codeIds: number[]) {
  const now = new Date().toISOString();
  for (const id of codeIds) {
    await db
      .update(cdkPool)
      .set({ status: "sold", soldAt: now, updatedAt: now })
      .where(and(eq(cdkPool.id, id), eq(cdkPool.status, "locked")));
  }
}

export async function markCodeUsed(code: string) {
  const now = new Date().toISOString();
  const normalized = normalizeCdkCode(code);
  await client.execute({
    sql: `UPDATE cdk_pool SET status = 'used', used_at = ?, updated_at = ?
           WHERE upper(trim(code)) = ? AND status IN ('locked', 'unused', 'sold')`,
    args: [now, now, normalized],
  });
}

export async function releaseLockedCode(code: string) {
  const now = new Date().toISOString();
  const row = await findCdkByCode(code);
  const restore = row?.soldAt ? "sold" : "unused";
  if (!row) return;
  await db
    .update(cdkPool)
    .set({
      status: restore,
      orderId: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, "locked")));
}

export async function lockCodeForRedeem(code: string, orderId: number) {
  await bootDb();
  const row = await findCdkByCode(code);
  if (!row) throw new Error("卡密不存在");
  if (row.status === "used") throw new Error("该卡密已使用");
  if (row.status === "locked") throw new Error("该卡密占用中，请稍后再试或查询订单进度");
  if (row.status === "disabled") throw new Error("该卡密已禁用");
  if (row.status !== "unused" && row.status !== "sold") {
    throw new Error(`卡密状态不可兑换：${row.status}`);
  }

  const now = new Date().toISOString();
  const updated = await db
    .update(cdkPool)
    .set({
      status: "locked",
      orderId,
      lockedAt: now,
      updatedAt: now,
    })
    .where(and(eq(cdkPool.id, row.id), eq(cdkPool.status, row.status)))
    .returning();

  if (!updated.length) throw new Error("卡密抢占失败，请重试");
  return { id: row.id, code: row.code, planKey: row.planKey };
}

export async function validateCodeForRedeem(code: string) {
  await bootDb();
  const trimmed = code.trim();
  if (!trimmed || trimmed.length < 6) {
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

export async function countUnused(planKey?: string) {
  await bootDb();
  if (planKey) {
    const rows = await db
      .select({ c: sql<number>`count(*)` })
      .from(cdkPool)
      .where(and(eq(cdkPool.status, "unused"), eq(cdkPool.planKey, planKey)));
    return Number(rows[0]?.c ?? 0);
  }
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(cdkPool)
    .where(eq(cdkPool.status, "unused"));
  return Number(rows[0]?.c ?? 0);
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

export async function voidCode(id: number) {
  const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, id) });
  if (!row) throw new Error("卡密不存在");
  if (row.status === "used") return row;
  if (row.status === "disabled") throw new Error("已禁用的卡密请先启用再核销，或保持禁用");
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cdkPool)
    .set({ status: "used", usedAt: now, updatedAt: now })
    .where(eq(cdkPool.id, id))
    .returning();
  return updated;
}

export async function disableCode(id: number) {
  const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, id) });
  if (!row) throw new Error("卡密不存在");
  if (row.status === "used") throw new Error("已核销卡密不能禁用");
  if (row.status === "locked") throw new Error("占用中的卡密不能禁用，请等待开通结束");
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cdkPool)
    .set({ status: "disabled", updatedAt: now })
    .where(eq(cdkPool.id, id))
    .returning();
  return updated;
}

export async function enableCode(id: number) {
  const row = await db.query.cdkPool.findFirst({ where: eq(cdkPool.id, id) });
  if (!row) throw new Error("卡密不存在");
  if (row.status !== "disabled") throw new Error("仅已禁用卡密可启用");
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cdkPool)
    .set({
      status: "unused",
      orderId: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(eq(cdkPool.id, id))
    .returning();
  return updated;
}
