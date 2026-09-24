import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { apiIdempotency, redeemGuardBlocks, redeemGuardEvents } from "@/db/schema";
import { writeAuditLog } from "@/lib/audit";
import { findIssuedCdkByCode } from "@/lib/cardplatform/issued-redemption";
import { bootDb, getSetting } from "@/lib/config";
import { findCdkByCode } from "@/lib/inventory";
import { RedeemRejectedError } from "@/lib/redeem-guard-core";
import { rateLimitResponse } from "@/lib/rate-limit";
import {
  AGENT_BATCH_CODES_PER_HOUR,
  ANON_BATCH_CODES_PER_HOUR,
  decideBlock,
  normalizeGuardEmail,
  retryAfterSeconds,
  sumFailureWeight,
  type GuardOutcome,
} from "@/lib/redeem-guard-core";

function isoMinutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function outcomesSince(subjectType: string, subject: string, sinceIso: string) {
  if (!subject) return [];
  const rows = await db
    .select({ outcome: redeemGuardEvents.outcome })
    .from(redeemGuardEvents)
    .where(
      and(
        eq(redeemGuardEvents.subjectType, subjectType),
        eq(redeemGuardEvents.subject, subject),
        gte(redeemGuardEvents.createdAt, sinceIso),
      ),
    );
  return rows.map((row) => row.outcome);
}

async function activeBlock(subjectType: string, subject: string) {
  if (!subject) return null;
  const now = new Date().toISOString();
  const rows = await db
    .select()
    .from(redeemGuardBlocks)
    .where(
      and(
        eq(redeemGuardBlocks.subjectType, subjectType),
        eq(redeemGuardBlocks.subject, subject),
        isNull(redeemGuardBlocks.releasedAt),
      ),
    );
  return rows.find((row) => row.blockedUntil > now) ?? null;
}

/** 卡不在本站已发卡、也不在旧卡池时，直接拒绝，调用方不要再打卡台。 */
export async function assertRedeemCodeKnown(code: string) {
  await bootDb();
  const issued = await findIssuedCdkByCode(code);
  if (issued) {
    if (issued.status === "used") throw new RedeemRejectedError("used_code");
    if (issued.status === "disabled") throw new RedeemRejectedError("disabled_code");
    return issued;
  }
  const pooled = await findCdkByCode(code).catch(() => null);
  const allowUnknown = (await getSetting("redeem_allow_unknown_code", "false")) === "true";
  if (!pooled && !allowUnknown) throw new RedeemRejectedError("unknown_code");
  return null;
}

export async function redeemBlockResponse(input: { ip: string; email?: string }) {
  await bootDb();
  const email = normalizeGuardEmail(input.email || "");
  const hit =
    (await activeBlock("ip", input.ip)) || (await activeBlock("email", email));
  if (!hit) return null;
  return rateLimitResponse(retryAfterSeconds(hit.blockedUntil));
}

export async function recordRedeemFailure(input: {
  ip: string;
  email?: string;
  outcome: GuardOutcome;
  route: string;
}) {
  await bootDb();
  const email = normalizeGuardEmail(input.email || "");
  const now = new Date().toISOString();
  const rows = [
    { subjectType: "ip", subject: input.ip },
    ...(email ? [{ subjectType: "email", subject: email }] : []),
  ];
  if (rows.some((row) => row.subject)) {
    await db.insert(redeemGuardEvents).values(
      rows
        .filter((row) => row.subject)
        .map((row) => ({
          subjectType: row.subjectType,
          subject: row.subject,
          outcome: input.outcome,
          route: input.route,
          clientIp: input.ip,
          createdAt: now,
        })),
    );
  }

  const [ip10, ip24, email1h, unknownMinute] = await Promise.all([
    outcomesSince("ip", input.ip, isoMinutesAgo(10)),
    outcomesSince("ip", input.ip, isoMinutesAgo(24 * 60)),
    outcomesSince("email", email, isoMinutesAgo(60)),
    outcomesSince("global", "unknown_code", isoMinutesAgo(1)),
  ]);
  if (input.outcome === "unknown_code") {
    await db.insert(redeemGuardEvents).values({
      subjectType: "global",
      subject: "unknown_code",
      outcome: "unknown_code",
      route: input.route,
      clientIp: input.ip,
      createdAt: now,
    });
    if (unknownMinute.length + 1 === 60) {
      await writeAuditLog({
        action: "redeem_guard_spike",
        targetType: "redeem",
        metadata: { ip: input.ip, email, route: input.route },
        ip: input.ip,
      }).catch(() => undefined);
      console.warn("[kaimi-guard] 1 分钟内未知卡密达到 60 次");
    }
  }

  const decision = decideBlock({
    ip: input.ip,
    email,
    ipWeight10m: sumFailureWeight(ip10),
    ipWeight24h: sumFailureWeight(ip24),
    emailWeight1h: sumFailureWeight(email1h),
  });
  if (!decision) return;
  if (await activeBlock(decision.subjectType, decision.subject)) return;
  const blockedUntil = new Date(Date.now() + decision.minutes * 60_000).toISOString();
  await db.insert(redeemGuardBlocks).values({
    subjectType: decision.subjectType,
    subject: decision.subject,
    reason: decision.reason,
    blockedUntil,
    createdAt: now,
  });
}

async function batchBudgetUsed(input: {
  ip: string;
  agentId?: number;
  anonymous: boolean;
}) {
  const since = isoMinutesAgo(60);
  const subjectType = input.anonymous ? "ip" : "agent";
  const subject = input.anonymous ? input.ip : String(input.agentId || "");
  const limit = input.anonymous ? ANON_BATCH_CODES_PER_HOUR : AGENT_BATCH_CODES_PER_HOUR;
  const used = subject
    ? (
        await db
          .select({ outcome: redeemGuardEvents.outcome })
          .from(redeemGuardEvents)
          .where(
            and(
              eq(redeemGuardEvents.subjectType, subjectType),
              eq(redeemGuardEvents.subject, subject),
              eq(redeemGuardEvents.route, "batch-budget"),
              gte(redeemGuardEvents.createdAt, since),
            ),
          )
      ).length
    : 0;
  return { subjectType, subject, limit, used };
}

/** 只读检查，校验接口不扣额度。 */
export async function checkBatchCodeBudget(input: {
  ip: string;
  agentId?: number;
  incoming: number;
  anonymous: boolean;
}) {
  await bootDb();
  const { used, limit } = await batchBudgetUsed(input);
  if (used + input.incoming > limit) return rateLimitResponse(3600);
  return null;
}

export async function assertBatchCodeBudget(input: {
  ip: string;
  agentId?: number;
  incoming: number;
  anonymous: boolean;
}) {
  await bootDb();
  const { subjectType, subject, limit, used } = await batchBudgetUsed(input);
  if (used + input.incoming > limit) {
    return rateLimitResponse(3600);
  }
  if (subject && input.incoming > 0) {
    const now = new Date().toISOString();
    await db.insert(redeemGuardEvents).values(
      Array.from({ length: input.incoming }, () => ({
        subjectType,
        subject,
        outcome: "ok" as const,
        route: "batch-budget",
        clientIp: input.ip,
        createdAt: now,
      })),
    );
  }
  return null;
}

export async function pruneRedeemGuard() {
  await bootDb();
  const now = Date.now();
  await db
    .delete(redeemGuardEvents)
    .where(lt(redeemGuardEvents.createdAt, new Date(now - 30 * 86400_000).toISOString()));
  await db
    .delete(apiIdempotency)
    .where(lt(apiIdempotency.createdAt, new Date(now - 24 * 3600_000).toISOString()));
  await db
    .delete(redeemGuardBlocks)
    .where(lt(redeemGuardBlocks.blockedUntil, new Date(now - 7 * 86400_000).toISOString()));
}

export async function listRedeemBlocks() {
  await bootDb();
  return db
    .select()
    .from(redeemGuardBlocks)
    .where(isNull(redeemGuardBlocks.releasedAt))
    .orderBy(desc(redeemGuardBlocks.id));
}

export async function releaseRedeemBlock(id: number, actorIp = "") {
  await bootDb();
  const now = new Date().toISOString();
  await db
    .update(redeemGuardBlocks)
    .set({ releasedAt: now })
    .where(and(eq(redeemGuardBlocks.id, id), isNull(redeemGuardBlocks.releasedAt)));
  await writeAuditLog({
    action: "redeem_guard_release",
    targetType: "redeem_guard_block",
    targetId: id,
    ip: actorIp,
  });
}
