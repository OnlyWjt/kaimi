// 邀请返券的统计和查看：代理汇总、邀请人列表/详情、作废券、管理员停用/恢复和总览。
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentReferralCodes,
  agentReferralCoupons,
  agentReferralSettings,
  agentReferrals,
  agents,
  storeOrders,
} from "@/db/schema";
import { publicShopName } from "@/lib/agent-names";
import { writeAuditLog } from "@/lib/audit";
import {
  beijingMonthStartIso,
  describeReferralRewards,
  maskReferralEmail,
  parseReferralRewards,
} from "@/lib/referral-core";
import { type Actor, ReferralError, nowIso, planDisplayNames, referralEmailHash, safeDecrypt } from "@/lib/referrals-shared";

/* —————————————————— 代理 / 管理员查看 —————————————————— */

export async function referralSummary(agentId: number | null, range: "month" | "all") {
  const since = range === "month" ? beijingMonthStartIso(new Date()) : "";
  const agentFilter = (column: typeof agentReferrals.agentId | typeof agentReferralCoupons.agentId) =>
    agentId ? eq(column, agentId) : undefined;
  const [referralRows, couponRows] = await Promise.all([
    db
      .select({
        status: agentReferrals.status,
        n: sql<number>`count(*)`,
        amount: sql<number>`coalesce(sum(${agentReferrals.orderAmountCents}), 0)`,
      })
      .from(agentReferrals)
      .where(and(agentFilter(agentReferrals.agentId), since ? gte(agentReferrals.createdAt, since) : undefined))
      .groupBy(agentReferrals.status),
    db
      .select({
        status: agentReferralCoupons.status,
        n: sql<number>`count(*)`,
        discount: sql<number>`coalesce(sum(${agentReferralCoupons.usedDiscountCents}), 0)`,
      })
      .from(agentReferralCoupons)
      .where(
        and(agentFilter(agentReferralCoupons.agentId), since ? gte(agentReferralCoupons.createdAt, since) : undefined),
      )
      .groupBy(agentReferralCoupons.status),
  ]);
  const ref = (status: string) => referralRows.find((row) => row.status === status);
  const cou = (status: string) => couponRows.find((row) => row.status === status);
  const invitedRows = referralRows.filter((row) => row.status !== "void");
  return {
    invitedCount: invitedRows.reduce((sum, row) => sum + Number(row.n), 0),
    invitedAmountCents: invitedRows.reduce((sum, row) => sum + Number(row.amount), 0),
    coolingCount: Number(ref("cooling")?.n) || 0,
    cappedCount: Number(ref("capped")?.n) || 0,
    voidCount: Number(ref("void")?.n) || 0,
    issuedCount: couponRows.reduce((sum, row) => sum + Number(row.n), 0),
    usedCount: Number(cou("used")?.n) || 0,
    expiredCount: Number(cou("expired")?.n) || 0,
    revokedCount: Number(cou("revoked")?.n) || 0,
    discountCents: Number(cou("used")?.discount) || 0,
  };
}

export async function listReferralInviters(
  agentId: number,
  input: { q?: string; page?: number; pageSize?: number },
) {
  const page = Math.max(1, Math.trunc(input.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize || 20)));
  const q = (input.q || "").trim();
  let filterIds: number[] | null = null;
  if (q) {
    // 邮箱是加密存的，按 hash 精确查；也可以直接搜邀请码或券码
    const upper = q.toUpperCase();
    const byCode = await db
      .select({ id: agentReferralCodes.id })
      .from(agentReferralCodes)
      .where(
        and(
          eq(agentReferralCodes.agentId, agentId),
          or(eq(agentReferralCodes.code, upper), eq(agentReferralCodes.ownerEmailHash, referralEmailHash(q))),
        ),
      );
    const byCoupon = await db
      .select({ id: agentReferralCoupons.codeId })
      .from(agentReferralCoupons)
      .where(and(eq(agentReferralCoupons.agentId, agentId), eq(agentReferralCoupons.code, upper)));
    filterIds = [...new Set([...byCode, ...byCoupon].map((row) => row.id))];
    if (!filterIds.length) return { list: [], total: 0, page, pageSize };
  }
  // 只列有过邀请的邀请人；没邀请过人的买家太多，列出来没意义
  const where = and(
    eq(agentReferralCodes.agentId, agentId),
    filterIds ? inArray(agentReferralCodes.id, filterIds) : undefined,
    filterIds ? undefined : sql`exists (select 1 from agent_referrals r where r.code_id = ${agentReferralCodes.id})`,
  );
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(agentReferralCodes).where(where);
  const codes = await db
    .select()
    .from(agentReferralCodes)
    .where(where)
    .orderBy(desc(agentReferralCodes.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const ids = codes.map((code) => code.id);
  const [refStats, couponStats] = ids.length
    ? await Promise.all([
        db
          .select({ codeId: agentReferrals.codeId, status: agentReferrals.status, n: sql<number>`count(*)` })
          .from(agentReferrals)
          .where(inArray(agentReferrals.codeId, ids))
          .groupBy(agentReferrals.codeId, agentReferrals.status),
        db
          .select({
            codeId: agentReferralCoupons.codeId,
            status: agentReferralCoupons.status,
            n: sql<number>`count(*)`,
            discount: sql<number>`coalesce(sum(${agentReferralCoupons.usedDiscountCents}), 0)`,
          })
          .from(agentReferralCoupons)
          .where(inArray(agentReferralCoupons.codeId, ids))
          .groupBy(agentReferralCoupons.codeId, agentReferralCoupons.status),
      ])
    : [[], []];
  return {
    list: codes.map((code) => {
      const refs = refStats.filter((row) => row.codeId === code.id);
      const cps = couponStats.filter((row) => row.codeId === code.id);
      const refCount = (status: string) => Number(refs.find((row) => row.status === status)?.n) || 0;
      return {
        codeId: code.id,
        code: code.code,
        email: safeDecrypt(code.ownerEmailEncrypted),
        createdAt: code.createdAt,
        rewardedCount: refCount("rewarded"),
        coolingCount: refCount("cooling"),
        cappedCount: refCount("capped"),
        voidCount: refCount("void"),
        couponCount: cps.reduce((sum, row) => sum + Number(row.n), 0),
        usedCount: Number(cps.find((row) => row.status === "used")?.n) || 0,
        discountCents: Number(cps.find((row) => row.status === "used")?.discount) || 0,
      };
    }),
    total: Number(total) || 0,
    page,
    pageSize,
  };
}

export async function getReferralInviter(agentId: number, codeId: number) {
  const [code] = await db
    .select()
    .from(agentReferralCodes)
    .where(and(eq(agentReferralCodes.id, codeId), eq(agentReferralCodes.agentId, agentId)))
    .limit(1);
  if (!code) throw new ReferralError("邀请人不存在", 404);
  const [referrals, coupons] = await Promise.all([
    db
      .select({
        id: agentReferrals.id,
        status: agentReferrals.status,
        voidReason: agentReferrals.voidReason,
        qualifyAt: agentReferrals.qualifyAt,
        orderAmountCents: agentReferrals.orderAmountCents,
        inviteeEmailEncrypted: agentReferrals.inviteeEmailEncrypted,
        createdAt: agentReferrals.createdAt,
        orderNo: storeOrders.orderNo,
        couponId: agentReferrals.couponId,
      })
      .from(agentReferrals)
      .innerJoin(storeOrders, eq(storeOrders.id, agentReferrals.storeOrderId))
      .where(eq(agentReferrals.codeId, code.id))
      .orderBy(desc(agentReferrals.id)),
    db
      .select({
        id: agentReferralCoupons.id,
        code: agentReferralCoupons.code,
        status: agentReferralCoupons.status,
        rewardsJson: agentReferralCoupons.rewardsJson,
        expiresAt: agentReferralCoupons.expiresAt,
        usedDiscountCents: agentReferralCoupons.usedDiscountCents,
        revokedReason: agentReferralCoupons.revokedReason,
        createdAt: agentReferralCoupons.createdAt,
        usedOrderNo: storeOrders.orderNo,
      })
      .from(agentReferralCoupons)
      .leftJoin(storeOrders, eq(storeOrders.id, agentReferralCoupons.usedOrderId))
      .where(eq(agentReferralCoupons.codeId, code.id))
      .orderBy(desc(agentReferralCoupons.id)),
  ]);
  const names = await planDisplayNames(
    agentId,
    coupons.flatMap((coupon) => Object.keys(parseReferralRewards(coupon.rewardsJson))),
  );
  const now = Date.now();
  return {
    codeId: code.id,
    code: code.code,
    email: safeDecrypt(code.ownerEmailEncrypted),
    createdAt: code.createdAt,
    referrals: referrals.map(({ inviteeEmailEncrypted, ...row }) => ({
      ...row,
      inviteeEmail: safeDecrypt(inviteeEmailEncrypted),
    })),
    coupons: coupons.map(({ rewardsJson, ...row }) => ({
      ...row,
      status: row.status === "unused" && Date.parse(row.expiresAt) <= now ? "expired" : row.status,
      description: describeReferralRewards(
        Object.entries(parseReferralRewards(rewardsJson)).map(([planKey, amountCents]) => ({
          planName: names.get(planKey) || planKey,
          amountCents,
        })),
      ),
    })),
  };
}

/** 停用一张没用掉的券。agentId 传了就只能停自己店的。 */
export async function revokeReferralCoupon(
  input: { couponId: number; reason: string; agentId?: number },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (!reason) throw new ReferralError("请填写停用原因");
  const [row] = await db
    .update(agentReferralCoupons)
    .set({ status: "revoked", revokedReason: reason.slice(0, 200), revokedBy: actor.id, updatedAt: nowIso() })
    .where(
      and(
        eq(agentReferralCoupons.id, input.couponId),
        input.agentId ? eq(agentReferralCoupons.agentId, input.agentId) : undefined,
        eq(agentReferralCoupons.status, "unused"),
      ),
    )
    .returning({ id: agentReferralCoupons.id, agentId: agentReferralCoupons.agentId });
  if (!row) throw new ReferralError("只有未使用的券可以停用", 409);
  await writeAuditLog({
    actor,
    action: actor.role === "agent" ? "agent.referral.coupon.revoke" : "admin.referral.coupon.revoke",
    targetType: "agent_referral_coupon",
    targetId: row.id,
    metadata: { agentId: row.agentId, reason },
  });
}

export async function adminDisableReferral(agentId: number, actor: Actor) {
  const now = nowIso();
  const [row] = await db
    .update(agentReferralSettings)
    .set({ enabled: false, disabledByAdminAt: now, updatedAt: now })
    .where(and(eq(agentReferralSettings.agentId, agentId), eq(agentReferralSettings.enabled, true)))
    .returning({ agentId: agentReferralSettings.agentId });
  if (!row) throw new ReferralError("这个代理没开邀请有礼", 409);
  await writeAuditLog({ actor, action: "admin.referral.disable", targetType: "agent", targetId: agentId });
}

/** 解除平台关闭：代理可以自己再打开。不替代理开启，面额要代理自己定。 */
export async function adminRestoreReferral(agentId: number, actor: Actor) {
  const [row] = await db
    .update(agentReferralSettings)
    .set({ disabledByAdminAt: null, updatedAt: nowIso() })
    .where(and(eq(agentReferralSettings.agentId, agentId), isNotNull(agentReferralSettings.disabledByAdminAt)))
    .returning({ agentId: agentReferralSettings.agentId });
  if (!row) throw new ReferralError("这个代理的邀请有礼没有被平台关闭", 409);
  await writeAuditLog({ actor, action: "admin.referral.restore", targetType: "agent", targetId: agentId });
}

/** 管理端：每个开过活动的代理一行，外加需要人工看一眼的邀请人。 */
export async function adminReferralOverview() {
  const [settingsRows, total, month] = await Promise.all([
    db.select().from(agentReferralSettings).where(isNotNull(agentReferralSettings.firstEnabledAt)),
    referralSummary(null, "all"),
    referralSummary(null, "month"),
  ]);
  const agentIds = settingsRows.map((row) => row.agentId);
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, displayName: agents.displayName, shopName: agents.shopName })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const perAgent = await Promise.all(
    settingsRows.map(async (row) => {
      const agent = agentRows.find((item) => item.id === row.agentId);
      return {
        agentId: row.agentId,
        name: agent ? publicShopName(agent) : String(row.agentId),
        enabled: row.enabled,
        disabledByAdmin: Boolean(row.disabledByAdminAt),
        month: await referralSummary(row.agentId, "month"),
        total: await referralSummary(row.agentId, "all"),
      };
    }),
  );
  // 本月触顶、或被邀请订单作废多的邀请人
  const monthStart = beijingMonthStartIso(new Date());
  const flagged = await db
    .select({
      codeId: agentReferrals.codeId,
      agentId: agentReferrals.agentId,
      capped: sql<number>`sum(case when ${agentReferrals.status} = 'capped' then 1 else 0 end)`,
      voided: sql<number>`sum(case when ${agentReferrals.status} = 'void' then 1 else 0 end)`,
      n: sql<number>`count(*)`,
    })
    .from(agentReferrals)
    .where(gte(agentReferrals.createdAt, monthStart))
    .groupBy(agentReferrals.codeId, agentReferrals.agentId)
    .having(
      sql`sum(case when ${agentReferrals.status} = 'capped' then 1 else 0 end) > 0 or sum(case when ${agentReferrals.status} = 'void' then 1 else 0 end) >= 2`,
    )
    .limit(50);
  const flaggedCodes = flagged.length
    ? await db
        .select()
        .from(agentReferralCodes)
        .where(inArray(agentReferralCodes.id, flagged.map((row) => row.codeId)))
    : [];
  return {
    total,
    month,
    agents: perAgent,
    flagged: flagged.map((row) => {
      const code = flaggedCodes.find((item) => item.id === row.codeId);
      return {
        agentId: row.agentId,
        agentName: perAgent.find((item) => item.agentId === row.agentId)?.name || String(row.agentId),
        codeId: row.codeId,
        code: code?.code || "",
        email: code ? maskReferralEmail(safeDecrypt(code.ownerEmailEncrypted)) : "",
        monthCount: Number(row.n) || 0,
        cappedCount: Number(row.capped) || 0,
        voidCount: Number(row.voided) || 0,
      };
    }),
  };
}
