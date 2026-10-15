import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { finishedAccounts, issuedCdks, storeOrders } from "@/db/schema";
import { encryptSecret, hashLookupValue } from "@/lib/crypto";
import {
  FINISHED_GPT_PLAN_KEY,
  type FinishedAccountParts,
  parseFinishedAccountLines,
} from "@/lib/finished-account-core";

type DbLike = Pick<typeof db, "query" | "insert" | "update" | "select">;

export async function countUnusedFinishedAccounts(
  planKey = FINISHED_GPT_PLAN_KEY,
  conn: DbLike = db,
) {
  const [{ unused }] = await conn
    .select({ unused: sql<number>`count(*)` })
    .from(finishedAccounts)
    .where(
      and(
        eq(finishedAccounts.planKey, planKey),
        eq(finishedAccounts.status, "unused"),
      ),
    );
  return Number(unused || 0);
}

/**
 * 已经下单、还没分到号的店铺订单要占掉的成品号数量。
 * 号要到发货时才分配，下单时只看 unused 的话，最后一个号能被几个人同时买下，
 * 付了款的后来者只能等退款。未付款的单最多挂 30 分钟就会被关掉，占用随之释放。
 */
export async function countPendingStoreAccountClaims(planKey: string, conn: DbLike = db) {
  const [{ pending }] = await conn
    .select({ pending: sql<number>`coalesce(sum(${storeOrders.quantity}), 0)` })
    .from(storeOrders)
    .where(
      and(
        eq(storeOrders.planKeySnapshot, planKey),
        or(
          eq(storeOrders.payStatus, "unpaid"),
          and(
            inArray(storeOrders.payStatus, ["paid", "manual"]),
            inArray(storeOrders.fulfillStatus, ["pending", "issuing"]),
          ),
        ),
      ),
    );
  return Number(pending || 0);
}

export async function unusedFinishedAccountCounts(planKeys: string[]) {
  const keys = [...new Set(planKeys.filter(Boolean))];
  const counts = new Map<string, number>();
  if (!keys.length) return counts;
  const rows = await db
    .select({
      planKey: finishedAccounts.planKey,
      unused: sql<number>`count(*)`,
    })
    .from(finishedAccounts)
    .where(
      and(
        inArray(finishedAccounts.planKey, keys),
        eq(finishedAccounts.status, "unused"),
      ),
    )
    .groupBy(finishedAccounts.planKey);
  for (const row of rows) {
    counts.set(row.planKey, Number(row.unused || 0));
  }
  return counts;
}

export async function importFinishedAccounts(input: {
  text: string;
  planKey?: string;
}) {
  const planKey = input.planKey || FINISHED_GPT_PLAN_KEY;
  const { accepted, rejected } = parseFinishedAccountLines(input.text);
  const existing = accepted.length
    ? await db.query.finishedAccounts.findMany({
        where: inArray(
          finishedAccounts.email,
          accepted.map((row) => row.email),
        ),
        columns: { email: true },
      })
    : [];
  const taken = new Set(existing.map((row) => row.email));
  const fresh = accepted.filter((row) => !taken.has(row.email));
  const skipped = accepted
    .filter((row) => taken.has(row.email))
    .map((row) => ({ email: row.email, reason: "库里已有这个邮箱" }));
  const now = new Date().toISOString();
  if (fresh.length) {
    await db.insert(finishedAccounts).values(
      fresh.map((row) => ({
        planKey,
        email: row.email,
        gptPasswordEncrypted: encryptSecret(row.gptPassword),
        mailboxPasswordEncrypted: encryptSecret(row.mailboxPassword),
        sessionEncrypted: encryptSecret(row.session),
        status: "unused" as const,
        importedAt: now,
        updatedAt: now,
      })),
    );
  }
  return {
    imported: fresh.length,
    skipped,
    rejected,
  };
}

export async function allocateFinishedAccounts(
  conn: DbLike,
  input: {
    planKey: string;
    orderId: number;
    quantity: number;
  },
) {
  const quantity = Math.max(0, input.quantity);
  if (quantity <= 0) return [];
  const candidates = await conn.query.finishedAccounts.findMany({
    where: and(
      eq(finishedAccounts.planKey, input.planKey),
      eq(finishedAccounts.status, "unused"),
    ),
    orderBy: [asc(finishedAccounts.id)],
    limit: quantity,
  });
  const claimed: Array<typeof finishedAccounts.$inferSelect> = [];
  const now = new Date().toISOString();
  for (const row of candidates) {
    const [updated] = await conn
      .update(finishedAccounts)
      .set({
        status: "sold",
        storeOrderId: input.orderId,
        soldAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(finishedAccounts.id, row.id),
          eq(finishedAccounts.status, "unused"),
        ),
      )
      .returning();
    if (updated) claimed.push(updated);
  }
  return claimed;
}

/**
 * 提卡领号。邮箱已经在 issued_cdks 里出现过（管理员手工补发过）的号跳过，
 * 继续往后领；够不够数由调用方判断，不够就整个事务回滚。
 */
export async function claimFinishedAccountsForDraw(
  conn: DbLike,
  input: { planKey: string; drawOrderId: number; quantity: number; now: string },
) {
  const claimed: Array<typeof finishedAccounts.$inferSelect> = [];
  const conflicted: number[] = [];
  let afterId = 0;
  while (claimed.length < input.quantity) {
    const candidates = await conn
      .select()
      .from(finishedAccounts)
      .where(
        and(
          eq(finishedAccounts.planKey, input.planKey),
          eq(finishedAccounts.status, "unused"),
          gt(finishedAccounts.id, afterId),
        ),
      )
      .orderBy(asc(finishedAccounts.id))
      .limit(input.quantity - claimed.length);
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1].id;
    const hashOf = new Map(candidates.map((row) => [row.id, hashLookupValue(row.email)]));
    const taken = new Set(
      (
        await conn
          .select({ codeHash: issuedCdks.codeHash })
          .from(issuedCdks)
          .where(inArray(issuedCdks.codeHash, [...hashOf.values()]))
      ).map((row) => row.codeHash),
    );
    for (const row of candidates) {
      if (taken.has(hashOf.get(row.id) || "")) {
        conflicted.push(row.id);
        continue;
      }
      const [updated] = await conn
        .update(finishedAccounts)
        .set({
          status: "sold",
          drawOrderId: input.drawOrderId,
          soldAt: input.now,
          updatedAt: input.now,
        })
        .where(and(eq(finishedAccounts.id, row.id), eq(finishedAccounts.status, "unused")))
        .returning();
      if (updated) claimed.push(updated);
    }
  }
  return { claimed, conflicted };
}

export function decryptFinishedAccount(
  row: typeof finishedAccounts.$inferSelect,
  decrypt: (value: string) => string,
): FinishedAccountParts {
  return {
    email: row.email,
    gptPassword: decrypt(row.gptPasswordEncrypted),
    mailboxPassword: decrypt(row.mailboxPasswordEncrypted),
    session: decrypt(row.sessionEncrypted),
  };
}
