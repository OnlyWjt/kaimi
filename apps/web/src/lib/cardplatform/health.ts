import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { accountCardBlocklist, accountCardFailEvents } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/config";
import {
  CARD_FAIL_VERDICTS,
  defaultCardHealthPolicy,
  evaluateCardFailVerdict,
  type CardHealthPolicy,
} from "./health-logic";

export {
  CARD_FAIL_VERDICTS,
  defaultCardHealthPolicy,
  evaluateCardFailVerdict,
} from "./health-logic";
export type { CardHealthPolicy } from "./health-logic";

function healthKey(accountId: number) {
  return accountId > 0 ? `card_health_policy_${accountId}` : "card_health_policy";
}

export async function loadCardHealthPolicy(accountId: number) {
  const scoped = await getSetting(healthKey(accountId));
  const raw = scoped.trim()
    ? scoped
    : accountId > 0
      ? await getSetting("card_health_policy")
      : "";
  if (!raw.trim()) return defaultCardHealthPolicy();
  try {
    const parsed = JSON.parse(raw) as Partial<CardHealthPolicy>;
    const policy = { ...defaultCardHealthPolicy(), ...parsed };
    if (policy.failThreshold < 1) policy.failThreshold = 2;
    return policy;
  } catch {
    return defaultCardHealthPolicy();
  }
}

export async function saveCardHealthPolicy(
  accountId: number,
  input: CardHealthPolicy,
) {
  const policy = {
    ...defaultCardHealthPolicy(),
    ...input,
    failThreshold: input.failThreshold < 1 ? 2 : input.failThreshold,
  };
  await setSetting(healthKey(accountId), JSON.stringify(policy));
  return policy;
}

function normalizeEmail(email: string) {
  const value = email.trim().toLowerCase();
  return value || "unknown";
}

export async function listActiveBlockedCardIds(accountId: number) {
  if (accountId <= 0) return [];
  const rows = await db
    .select()
    .from(accountCardBlocklist)
    .where(
      and(
        eq(accountCardBlocklist.accountId, accountId),
        isNull(accountCardBlocklist.unblockedAt),
      ),
    );
  return rows.map((row) => row.cardId);
}

export async function listActiveBlocklist(accountId: number) {
  return db
    .select()
    .from(accountCardBlocklist)
    .where(
      and(
        eq(accountCardBlocklist.accountId, accountId),
        isNull(accountCardBlocklist.unblockedAt),
      ),
    )
    .orderBy(desc(accountCardBlocklist.blockedAt));
}

export async function unblockCard(accountId: number, cardId: number) {
  const now = new Date().toISOString();
  await db
    .update(accountCardBlocklist)
    .set({ unblockedAt: now })
    .where(
      and(
        eq(accountCardBlocklist.accountId, accountId),
        eq(accountCardBlocklist.cardId, cardId),
        isNull(accountCardBlocklist.unblockedAt),
      ),
    );
}

async function cardFailStats(accountId: number, cardId: number) {
  const rows = await db
    .select()
    .from(accountCardFailEvents)
    .where(
      and(
        eq(accountCardFailEvents.accountId, accountId),
        eq(accountCardFailEvents.cardId, cardId),
      ),
    );
  const emails = new Set<string>();
  for (const row of rows) {
    const email = row.accountEmailNorm.trim().toLowerCase();
    if (email && email !== "unknown") emails.add(email);
  }
  return {
    failCount: rows.length,
    distinctEmails: emails.size,
  };
}

export async function observeCardOrderOutcome(input: {
  accountId: number;
  cardId: number;
  cardLastFour?: string;
  orderId?: number;
  cdkCode?: string;
  accountEmail?: string;
  emailSource?: string;
  errorCode?: string;
  status: string;
}) {
  if (input.cardId <= 0) return { verdict: "no_card" };
  const policy = await loadCardHealthPolicy(input.accountId);
  if (!policy.enabled) return { verdict: "disabled" };
  if (input.accountId <= 0) return { verdict: "no_platform_account" };

  const status = input.status.trim().toLowerCase();
  if (status === "completed" || status === "success") {
    return { verdict: "success" };
  }
  if (!["failed_precharge", "declined", "failed"].includes(status)) {
    return { verdict: "ignored_status" };
  }

  const email = normalizeEmail(input.accountEmail || "");
  const now = new Date().toISOString();
  let inserted = false;
  try {
    await db.insert(accountCardFailEvents).values({
      accountId: input.accountId,
      cardId: input.cardId,
      cardLastFour: (input.cardLastFour || "").trim(),
      orderId: input.orderId || 0,
      cdkCode: (input.cdkCode || "").trim(),
      accountEmailNorm: email,
      emailSource:
        input.emailSource?.trim() || (email === "unknown" ? "unknown" : "provided"),
      errorCode: (input.errorCode || "").trim(),
      orderStatus: status,
      createdAt: now,
    });
    inserted = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/UNIQUE|unique/i.test(message)) throw error;
  }

  const stats = await cardFailStats(input.accountId, input.cardId);
  const [blocked] = await db
    .select()
    .from(accountCardBlocklist)
    .where(
      and(
        eq(accountCardBlocklist.accountId, input.accountId),
        eq(accountCardBlocklist.cardId, input.cardId),
        isNull(accountCardBlocklist.unblockedAt),
      ),
    )
    .limit(1);
  if (blocked) {
    return {
      verdict: CARD_FAIL_VERDICTS.alreadyBlocked,
      blocked: true,
      ...stats,
    };
  }

  const verdict = evaluateCardFailVerdict(
    stats.failCount,
    stats.distinctEmails,
    policy.failThreshold,
    policy.requireKnownEmail,
  );
  if (inserted) {
    await db
      .update(accountCardFailEvents)
      .set({ verdict })
      .where(
        and(
          eq(accountCardFailEvents.accountId, input.accountId),
          eq(accountCardFailEvents.cardId, input.cardId),
          eq(accountCardFailEvents.orderId, input.orderId || 0),
        ),
      );
  }
  if (verdict !== CARD_FAIL_VERDICTS.cardSuspect) {
    return { verdict, blocked: false, ...stats };
  }

  await db
    .insert(accountCardBlocklist)
    .values({
      accountId: input.accountId,
      cardId: input.cardId,
      cardLastFour: (input.cardLastFour || "").trim(),
      reason: "multi_email_fail",
      distinctEmails: stats.distinctEmails,
      failCount: stats.failCount,
      freezeStatus: "skipped",
      blockedAt: now,
      notes: "不同邮箱在该卡上失败≥阈值，本站判定为卡问题",
    })
    .onConflictDoUpdate({
      target: [accountCardBlocklist.accountId, accountCardBlocklist.cardId],
      set: {
        reason: "multi_email_fail",
        distinctEmails: stats.distinctEmails,
        failCount: stats.failCount,
        freezeStatus: "skipped",
        unblockedAt: null,
        blockedAt: now,
        notes: "不同邮箱在该卡上失败≥阈值，本站判定为卡问题",
      },
    });
  return { verdict, blocked: true, eventInserted: inserted, ...stats };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function anyToInt(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function anyToString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export async function observeFromWebhookPayload(
  payload: Record<string, unknown>,
  accountId: number,
) {
  const eventType = anyToString(payload.event || payload.type)
    .trim()
    .toLowerCase();
  if (!eventType.startsWith("gpt_direct.")) return;
  let status = anyToString(payload.status).trim().toLowerCase();
  if (!status) {
    if (eventType.includes("failed")) status = "failed_precharge";
    else if (eventType.includes("completed")) status = "completed";
    else if (eventType.includes("cancelled")) status = "cancelled";
  }
  const cardId = anyToInt(payload.card_id);
  if (!cardId) return;
  let last4 = anyToString(payload.card_last_four);
  const cardNumber = anyToString(payload.card_number);
  if (!last4 && cardNumber.length >= 4) last4 = cardNumber.slice(-4);
  await observeCardOrderOutcome({
    accountId,
    cardId,
    cardLastFour: last4,
    orderId: anyToInt(payload.order_id),
    accountEmail: anyToString(payload.account_email),
    errorCode: anyToString(payload.error_code || payload.last_error_code),
    status,
  });
}

export async function observeFromPublicResult(
  payload: Record<string, unknown>,
  accountId: number,
  cdkCode = "",
) {
  const order = asRecord(payload.order);
  const source = Object.keys(order).length > 0 ? order : payload;
  const status = anyToString(source.status).trim().toLowerCase();
  if (!["failed_precharge", "declined", "failed", "completed"].includes(status)) {
    return;
  }
  const cardId = anyToInt(source.card_id);
  if (!cardId) return;
  await observeCardOrderOutcome({
    accountId,
    cardId,
    cardLastFour: anyToString(source.card_last_four),
    orderId: anyToInt(source.id || source.order_id),
    cdkCode,
    accountEmail: anyToString(source.account_email),
    status,
  });
}
