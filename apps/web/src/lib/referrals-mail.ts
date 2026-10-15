// 邀请券的到账邮件、失败重发、到期提醒和过期作废。
import { and, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentReferralCodes,
  agentReferralCoupons,
  agents,
} from "@/db/schema";
import { formatBeijingDateTime } from "@/lib/datetime";
import { getPublicBaseUrl } from "@/lib/public-url";
import {
  maskReferralEmail,
  parseReferralRewards,
} from "@/lib/referral-core";
import { describeRewards, nowIso, planDisplayNames, safeDecrypt } from "@/lib/referrals-shared";

const MAIL_ATTEMPTS = 5;
const MAIL_SENDING_STALE_MS = 2 * 60_000;
const REMIND_BEFORE_MS = 3 * 86_400_000;
/** 有效期太短的券不发到期提醒，免得刚到账就提醒要过期。 */
const REMIND_MIN_VALID_MS = 4 * 86_400_000;

async function couponMailContext(couponId: number) {
  const coupon = await db.query.agentReferralCoupons.findFirst({
    where: eq(agentReferralCoupons.id, couponId),
  });
  if (!coupon) return null;
  const [code, agent] = await Promise.all([
    db.query.agentReferralCodes.findFirst({ where: eq(agentReferralCodes.id, coupon.codeId) }),
    db.query.agents.findFirst({ where: eq(agents.id, coupon.agentId), columns: { currentSlug: true } }),
  ]);
  const rewards = parseReferralRewards(coupon.rewardsJson);
  const names = await planDisplayNames(coupon.agentId, Object.keys(rewards));
  const origin = await getPublicBaseUrl();
  const email = code ? safeDecrypt(code.ownerEmailEncrypted) : "";
  return {
    coupon,
    email,
    description: describeRewards(rewards, names),
    shopUrl: origin && agent?.currentSlug ? `${origin}/s/${agent.currentSlug}` : "",
  };
}

function couponUseLines(ctx: NonNullable<Awaited<ReturnType<typeof couponMailContext>>>) {
  return [
    `券码 ${ctx.coupon.code}`,
    `可用于：${ctx.description}`,
    `有效期至 ${formatBeijingDateTime(ctx.coupon.expiresAt)}（北京时间）`,
    "",
    `下次在本店下单时，在「优惠券」里填券码。下单邮箱要用这个邮箱（${maskReferralEmail(ctx.email)}），别的邮箱用不了。`,
    ...(ctx.shopUrl ? [ctx.shopUrl] : []),
  ];
}

/** 得券通知邮件。认领 notice_status，并发和重试都只发一次。 */
export async function sendReferralCouponNotice(couponId: number) {
  const now = nowIso();
  const stale = new Date(Date.now() - MAIL_SENDING_STALE_MS).toISOString();
  const [claimed] = await db
    .update(agentReferralCoupons)
    .set({ noticeStatus: "sending", updatedAt: now })
    .where(
      and(
        eq(agentReferralCoupons.id, couponId),
        lt(agentReferralCoupons.noticeAttempts, MAIL_ATTEMPTS),
        or(
          inArray(agentReferralCoupons.noticeStatus, ["pending", "failed"]),
          and(eq(agentReferralCoupons.noticeStatus, "sending"), lt(agentReferralCoupons.updatedAt, stale)),
        ),
      ),
    )
    .returning({ id: agentReferralCoupons.id });
  if (!claimed) return;
  const finish = (status: string, error = "", countAttempt = false) =>
    db
      .update(agentReferralCoupons)
      .set({
        noticeStatus: status,
        noticeError: error.slice(0, 300),
        ...(countAttempt ? { noticeAttempts: sql`${agentReferralCoupons.noticeAttempts} + 1` } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(agentReferralCoupons.id, couponId));
  try {
    const ctx = await couponMailContext(couponId);
    if (!ctx || ctx.coupon.status !== "unused") {
      await finish("skipped", "券已不可用");
      return;
    }
    const { sendShopMail } = await import("@/lib/mail");
    const result = await sendShopMail({
      agentId: ctx.coupon.agentId,
      to: ctx.email,
      subject: (shop) => `${shop} 邀请券到账`,
      lines: () => ["你邀请的好友在本店下单成功，送你一张邀请券：", "", ...couponUseLines(ctx)],
    });
    await finish(result.sent ? "sent" : "skipped", result.sent ? "" : result.reason);
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : "发信失败", true);
    throw error;
  }
}

/** 定时补发失败的得券邮件。只补发券后 3 天内的，过久就不打扰了。 */
export async function retryReferralCouponNotices(limit = 10) {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const rows = await db
    .select({ id: agentReferralCoupons.id })
    .from(agentReferralCoupons)
    .where(
      and(
        inArray(agentReferralCoupons.noticeStatus, ["pending", "failed", "sending"]),
        lt(agentReferralCoupons.noticeAttempts, MAIL_ATTEMPTS),
        gte(agentReferralCoupons.createdAt, since),
      ),
    )
    .limit(limit);
  let sent = 0;
  for (const row of rows) {
    try {
      await sendReferralCouponNotice(row.id);
      sent += 1;
    } catch {
      /* 已记 failed，下一轮再试 */
    }
  }
  return sent;
}

/** 到期前 3 天提醒还没用的券，每张只提醒一次。 */
export async function sendReferralCouponReminders(now = new Date(), limit = 20) {
  const nowIsoValue = now.toISOString();
  const soon = new Date(now.getTime() + REMIND_BEFORE_MS).toISOString();
  const stale = new Date(now.getTime() - MAIL_SENDING_STALE_MS).toISOString();
  const candidates = await db
    .select({
      id: agentReferralCoupons.id,
      createdAt: agentReferralCoupons.createdAt,
      expiresAt: agentReferralCoupons.expiresAt,
    })
    .from(agentReferralCoupons)
    .where(
      and(
        eq(agentReferralCoupons.status, "unused"),
        gt(agentReferralCoupons.expiresAt, nowIsoValue),
        lte(agentReferralCoupons.expiresAt, soon),
        inArray(agentReferralCoupons.remindStatus, ["", "failed", "sending"]),
        lt(agentReferralCoupons.remindAttempts, 3),
      ),
    )
    .limit(limit);
  let sent = 0;
  for (const row of candidates) {
    if (Date.parse(row.expiresAt) - Date.parse(row.createdAt) < REMIND_MIN_VALID_MS) {
      await db
        .update(agentReferralCoupons)
        .set({ remindStatus: "skipped" })
        .where(and(eq(agentReferralCoupons.id, row.id), eq(agentReferralCoupons.remindStatus, "")));
      continue;
    }
    const [claimed] = await db
      .update(agentReferralCoupons)
      .set({ remindStatus: "sending", updatedAt: nowIso() })
      .where(
        and(
          eq(agentReferralCoupons.id, row.id),
          eq(agentReferralCoupons.status, "unused"),
          or(
            inArray(agentReferralCoupons.remindStatus, ["", "failed"]),
            and(eq(agentReferralCoupons.remindStatus, "sending"), lt(agentReferralCoupons.updatedAt, stale)),
          ),
        ),
      )
      .returning({ id: agentReferralCoupons.id });
    if (!claimed) continue;
    try {
      const ctx = await couponMailContext(row.id);
      if (!ctx) continue;
      const { sendShopMail } = await import("@/lib/mail");
      const result = await sendShopMail({
        agentId: ctx.coupon.agentId,
        to: ctx.email,
        subject: (shop) => `${shop} 邀请券快到期了`,
        lines: () => ["你在本店的邀请券还没用，3 天内就要到期了：", "", ...couponUseLines(ctx)],
      });
      await db
        .update(agentReferralCoupons)
        .set({ remindStatus: result.sent ? "sent" : "skipped" })
        .where(eq(agentReferralCoupons.id, row.id));
      if (result.sent) sent += 1;
    } catch (error) {
      console.warn(`[referral] 到期提醒失败：${error instanceof Error ? error.message : error}`);
      await db
        .update(agentReferralCoupons)
        .set({ remindStatus: "failed", remindAttempts: sql`${agentReferralCoupons.remindAttempts} + 1` })
        .where(eq(agentReferralCoupons.id, row.id));
    }
  }
  return sent;
}

export async function expireReferralCoupons(now = new Date()) {
  const rows = await db
    .update(agentReferralCoupons)
    .set({ status: "expired", updatedAt: now.toISOString() })
    .where(and(eq(agentReferralCoupons.status, "unused"), lte(agentReferralCoupons.expiresAt, now.toISOString())))
    .returning({ id: agentReferralCoupons.id });
  return rows.length;
}

/** sync-scheduler 每分钟调一次。 */
