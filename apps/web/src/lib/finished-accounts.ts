import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { finishedAccounts } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
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
