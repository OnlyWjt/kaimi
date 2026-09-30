import { and, desc, eq, gte, inArray, isNull, like, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentDrawAccess,
  agentDrawApplications,
  agentDrawBills,
  agentDrawItems,
  agentDrawOrders,
  agentPlanPrices,
  agents,
  issuedCdks,
  platformPlans,
} from "@/db/schema";
import {
  CDK_USE_LABEL,
  DRAW_DEFAULT_CREDIT_CENTS,
  DRAW_DEFAULT_MAX_PER_DRAW,
  DRAW_ISSUING_LEASE_MS,
  DRAW_ITEM_LABEL,
  DRAW_MAX_SETTLE_ITEMS,
  DRAW_RECOVER_MAX_ATTEMPTS,
  beijingDayStartIso,
  billRevertOpen,
  buildDrawStatementText,
  computeDrawCredit,
  creditWarnCrossed,
  drawCreditError,
  drawDailyLimitError,
  drawNoTailMatches,
  drawPaymentMethodLabel,
  drawOrderStatusFromIssued,
  drawQuantityError,
  drawSettingsError,
  newDrawLinkToken,
  normalizeDrawPaymentMethod,
  parseAllowedPlanKeys,
  planAllowed,
  resolveDrawUnitPrice,
  summarizeDrawItems,
  toCsv,
  type DrawPlanSummary,
} from "@/lib/agent-draw-core";
import { publicShopName } from "@/lib/agent-names";
import { writeAuditLog } from "@/lib/audit";
import type { UserRole } from "@/lib/auth";
import { CardplatformError } from "@/lib/cardplatform/client";
import {
  getCardplatformClientById,
  getDefaultCardplatformAccount,
} from "@/lib/cardplatform/config";
import {
  accountSupportsPaymentCountry,
  isRegionIssueError,
  issueTargetFromSnapshot,
} from "@/lib/cardplatform/issue-target";
import { issuePrefFromAccount } from "@/lib/cardplatform/policy";
import { planNameWithRegion } from "@/lib/cardplatform/regions";
import { getSetting } from "@/lib/config";
import { decryptSecret, encryptSecret, hashLookupValue, maskCode } from "@/lib/crypto";
import { issueIdempotencyKey } from "@/lib/fulfillment/issue-keys";
import { newOrderNo } from "@/lib/ids";
import { notifyDrawAlert, notifyDrawApply, notifyDrawCreated } from "@/lib/notify";

export class DrawError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Actor = { id: number; role: UserRole };

function nowIso() {
  return new Date().toISOString();
}

async function unsettledByAgent() {
  const rows = await db
    .select({
      agentId: agentDrawItems.agentId,
      count: sql<number>`count(*)`,
      amountCents: sql<number>`coalesce(sum(${agentDrawItems.amountCents}), 0)`,
    })
    .from(agentDrawItems)
    .where(eq(agentDrawItems.status, "unsettled"))
    .groupBy(agentDrawItems.agentId);
  return new Map(rows.map((row) => [row.agentId, row]));
}

export async function drawLedgerOverview() {
  const unsettled = await unsettledByAgent();
  let amountCents = 0;
  let count = 0;
  for (const row of unsettled.values()) {
    amountCents += Number(row.amountCents) || 0;
    count += Number(row.count) || 0;
  }
  const pending = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentDrawApplications)
    .where(eq(agentDrawApplications.status, "pending"));
  const access = await db.select().from(agentDrawAccess);
  return {
    pendingApplications: Number(pending[0]?.count) || 0,
    approvedAgents: access.filter((row) => row.status === "approved").length,
    unsettledCents: amountCents,
    unsettledCount: count,
  };
}

export async function listDrawLedgerAgents() {
  const unsettled = await unsettledByAgent();
  const accessRows = await db.select().from(agentDrawAccess);
  const agentIds = [
    ...new Set([...accessRows.map((row) => row.agentId), ...unsettled.keys()]),
  ];
  if (agentIds.length === 0) return [];
  const agentRows = await db
    .select({
      id: agents.id,
      displayName: agents.displayName,
      shopName: agents.shopName,
      status: agents.status,
    })
    .from(agents)
    .where(inArray(agents.id, agentIds));
  const accessByAgent = new Map(accessRows.map((row) => [row.agentId, row]));
  return agentRows
    .map((agent) => {
      const access = accessByAgent.get(agent.id);
      const open = unsettled.get(agent.id);
      return {
        agentId: agent.id,
        name: publicShopName(agent),
        agentStatus: agent.status,
        drawStatus: access?.status || "none",
        creditLimitCents: access?.creditLimitCents || 0,
        unsettledCount: Number(open?.count) || 0,
        unsettledCents: Number(open?.amountCents) || 0,
        maxPerDraw: access?.maxPerDraw ?? DRAW_DEFAULT_MAX_PER_DRAW,
        dailyLimitCount: access?.dailyLimitCount ?? 0,
        notifyEachDraw: access?.notifyEachDraw ?? true,
      };
    })
    .sort((a, b) => {
      const ratio = (row: { creditLimitCents: number; unsettledCents: number }) =>
        row.creditLimitCents > 0 ? row.unsettledCents / row.creditLimitCents : row.unsettledCents > 0 ? 1 : 0;
      return ratio(b) - ratio(a) || b.unsettledCents - a.unsettledCents || a.name.localeCompare(b.name, "zh");
    });
}

export async function listUnsettledDrawItems(agentId: number) {
  const rows = await db
    .select({
      id: agentDrawItems.id,
      createdAt: agentDrawItems.createdAt,
      planKey: agentDrawItems.planKey,
      amountCents: agentDrawItems.amountCents,
      upstreamCostCents: agentDrawItems.upstreamCostCents,
      codeEncrypted: issuedCdks.codeEncrypted,
      cdkStatus: issuedCdks.status,
      paymentCountry: issuedCdks.paymentCountry,
      drawNo: agentDrawOrders.drawNo,
      planName: agentDrawOrders.planNameSnapshot,
    })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .innerJoin(agentDrawOrders, eq(agentDrawOrders.id, agentDrawItems.drawOrderId))
    .where(and(eq(agentDrawItems.agentId, agentId), eq(agentDrawItems.status, "unsettled")))
    .orderBy(desc(agentDrawItems.id))
    .limit(DRAW_MAX_SETTLE_ITEMS);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    planKey: row.planKey,
    planName: row.planName,
    amountCents: row.amountCents,
    upstreamCostCents: row.upstreamCostCents,
    cdkStatus: row.cdkStatus,
    paymentCountry: row.paymentCountry,
    drawNo: row.drawNo,
    codeMasked: maskCode(decryptSecret(row.codeEncrypted)),
  }));
}

export async function settleDrawItems(
  input: {
    agentId: number;
    itemIds: number[];
    expectedAmountCents: number;
    paymentMethod: string;
    paymentReference: string;
    notes: string;
  },
  actor: Actor,
) {
  if (!normalizeDrawPaymentMethod(input.paymentMethod)) throw new DrawError("请选择收款方式");
  const itemIds = [...new Set(input.itemIds)];
  if (itemIds.length === 0) throw new DrawError("请先勾选要结算的卡密");
  if (itemIds.length > DRAW_MAX_SETTLE_ITEMS) {
    throw new DrawError(`一次最多结算 ${DRAW_MAX_SETTLE_ITEMS} 张`);
  }
  const now = nowIso();
  const bill = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(agentDrawItems)
      .where(and(eq(agentDrawItems.agentId, input.agentId), inArray(agentDrawItems.id, itemIds)));
    if (rows.length !== itemIds.length || rows.some((row) => row.status !== "unsettled")) {
      throw new DrawError("有卡密状态已变化，请刷新后再结", 409);
    }
    const amountCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    if (amountCents !== input.expectedAmountCents) {
      throw new DrawError("金额对不上，请刷新后再结", 409);
    }
    const times = rows.map((row) => row.createdAt).sort();
    const orders = await tx
      .select({
        id: agentDrawOrders.id,
        planKey: agentDrawOrders.planKeySnapshot,
        planName: agentDrawOrders.planNameSnapshot,
      })
      .from(agentDrawOrders)
      .where(inArray(agentDrawOrders.id, [...new Set(rows.map((row) => row.drawOrderId))]));
    const nameByOrder = new Map(orders.map((order) => [order.id, order]));
    const summary = summarizeDrawItems(
      rows.map((row) => ({
        planKey: row.planKey,
        planName: nameByOrder.get(row.drawOrderId)?.planName || row.planKey,
        amountCents: row.amountCents,
      })),
    );
    const [created] = await tx
      .insert(agentDrawBills)
      .values({
        billNo: newOrderNo("DB"),
        agentId: input.agentId,
        itemCount: rows.length,
        amountCents,
        firstItemAt: times[0] || now,
        lastItemAt: times[times.length - 1] || now,
        summaryJson: JSON.stringify(summary),
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        notes: input.notes,
        createdBy: actor.id,
        createdAt: now,
      })
      .returning();
    if (!created) throw new DrawError("结算单创建失败");
    await tx
      .update(agentDrawItems)
      .set({ status: "settled", billId: created.id, settledAt: now, updatedAt: now })
      .where(
        and(
          eq(agentDrawItems.agentId, input.agentId),
          eq(agentDrawItems.status, "unsettled"),
          inArray(agentDrawItems.id, itemIds),
        ),
      );
    await tx
      .update(agentDrawAccess)
      .set({ creditWarnedAt: null, updatedAt: now })
      .where(eq(agentDrawAccess.agentId, input.agentId));
    return created;
  });
  await writeAuditLog({
    actor,
    action: "admin.draw.bill.create",
    targetType: "agent_draw_bill",
    targetId: bill.id,
    metadata: { agentId: input.agentId, itemCount: bill.itemCount, amountCents: bill.amountCents },
  });
  return bill;
}

export async function grantDrawAccess(
  input: { agentId: number; creditLimitCents?: number; maxPerDraw?: number; adminNote?: string },
  actor: Actor,
) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, input.agentId) });
  if (!agent) throw new DrawError("代理不存在", 404);
  const existing = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, input.agentId),
  });
  const now = nowIso();
  const credit = input.creditLimitCents ?? existing?.creditLimitCents ?? DRAW_DEFAULT_CREDIT_CENTS;
  const maxPerDraw = input.maxPerDraw ?? existing?.maxPerDraw ?? DRAW_DEFAULT_MAX_PER_DRAW;
  if (existing) {
    await db
      .update(agentDrawAccess)
      .set({
        status: "approved",
        linkToken: existing.linkToken || newDrawLinkToken(),
        creditLimitCents: credit,
        maxPerDraw,
        adminNote: input.adminNote ?? existing.adminNote,
        approvedAt: now,
        approvedBy: actor.id,
        updatedAt: now,
      })
      .where(eq(agentDrawAccess.agentId, input.agentId));
  } else {
    await db.insert(agentDrawAccess).values({
      agentId: input.agentId,
      status: "approved",
      linkToken: newDrawLinkToken(),
      creditLimitCents: credit,
      maxPerDraw,
      approvedAt: now,
      approvedBy: actor.id,
      adminNote: input.adminNote || "",
      updatedAt: now,
    });
  }
  await db
    .update(agentDrawApplications)
    .set({
      status: "approved",
      reviewedBy: actor.id,
      reviewedAt: now,
    })
    .where(and(eq(agentDrawApplications.agentId, input.agentId), eq(agentDrawApplications.status, "pending")));
  await writeAuditLog({
    actor,
    action: "admin.draw.grant",
    targetType: "agent",
    targetId: input.agentId,
    metadata: { creditLimitCents: credit },
  });
}

/** 只改信用额度，不动开通状态和专属链接。 */
export async function updateDrawCredit(
  input: { agentId: number; creditLimitCents: number },
  actor: Actor,
) {
  const creditLimitCents = Math.trunc(input.creditLimitCents);
  if (!Number.isSafeInteger(creditLimitCents) || creditLimitCents <= 0) {
    throw new DrawError("请填写大于 0 的额度");
  }
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, input.agentId),
  });
  if (!access || (access.status !== "approved" && access.status !== "suspended")) {
    throw new DrawError("这个代理还没开通提卡");
  }
  const now = nowIso();
  await db
    .update(agentDrawAccess)
    .set({ creditLimitCents, updatedAt: now })
    .where(eq(agentDrawAccess.agentId, input.agentId));
  await writeAuditLog({
    actor,
    action: "admin.draw.credit",
    targetType: "agent",
    targetId: input.agentId,
    metadata: { fromCents: access.creditLimitCents, creditLimitCents },
  });
  const { unsettledCents } = await exposureFor(input.agentId);
  return {
    creditLimitCents,
    warning:
      unsettledCents > creditLimitCents
        ? "未结算金额已经高于新额度，这个代理要先结算一部分才能再提"
        : "",
  };
}

export async function rejectDrawApplication(
  input: { applicationId: number; reason: string },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (!reason) throw new DrawError("请填写拒绝原因");
  const application = await db.query.agentDrawApplications.findFirst({
    where: eq(agentDrawApplications.id, input.applicationId),
  });
  if (!application || application.status !== "pending") throw new DrawError("这条申请已经处理过", 409);
  const now = nowIso();
  await db
    .update(agentDrawApplications)
    .set({ status: "rejected", reviewNote: reason, reviewedBy: actor.id, reviewedAt: now })
    .where(eq(agentDrawApplications.id, application.id));
  await db
    .insert(agentDrawAccess)
    .values({
      agentId: application.agentId,
      status: "rejected",
      rejectReason: reason,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentDrawAccess.agentId,
      set: { status: "rejected", rejectReason: reason, updatedAt: now },
    });
  await writeAuditLog({
    actor,
    action: "admin.draw.reject",
    targetType: "agent_draw_application",
    targetId: application.id,
  });
}

export async function listStuckDrawOrders(agentId: number) {
  return db
    .select({
      id: agentDrawOrders.id,
      drawNo: agentDrawOrders.drawNo,
      status: agentDrawOrders.status,
      quantity: agentDrawOrders.quantity,
      issuedCount: agentDrawOrders.issuedCount,
      unitPriceCents: agentDrawOrders.unitPriceCents,
      planName: agentDrawOrders.planNameSnapshot,
      lastErrorMessage: agentDrawOrders.lastErrorMessage,
      attempts: agentDrawOrders.attempts,
      createdAt: agentDrawOrders.createdAt,
    })
    .from(agentDrawOrders)
    .where(
      and(eq(agentDrawOrders.agentId, agentId), inArray(agentDrawOrders.status, ["issuing", "unknown"])),
    )
    .orderBy(desc(agentDrawOrders.id));
}

/** 先向卡台取回过、并且账上确实没有卡时，管理员核对单号后四位再释放额度。 */
export async function markDrawOrderFailed(orderId: number, confirmSuffix: string, actor: Actor) {
  const order = await db.query.agentDrawOrders.findFirst({
    where: eq(agentDrawOrders.id, orderId),
  });
  if (!order || (order.status !== "issuing" && order.status !== "unknown")) {
    throw new DrawError("这单不用处理");
  }
  if (order.attempts < 2) throw new DrawError("请先向卡台取回一次");
  if (
    order.status === "issuing" &&
    Date.now() - Date.parse(order.updatedAt) < DRAW_ISSUING_LEASE_MS
  ) {
    throw new DrawError("这单正在向卡台取回，请稍候再确认", 409);
  }
  if (!drawNoTailMatches(order.drawNo, confirmSuffix)) throw new DrawError("提卡单号后四位不对");
  const now = nowIso();
  await db.transaction(async (tx) => {
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)` })
      .from(agentDrawItems)
      .where(eq(agentDrawItems.drawOrderId, order.id));
    if ((Number(total) || 0) > 0 || order.issuedCount > 0) {
      throw new DrawError("这单已经出了卡，不能当成没出");
    }
    const [updated] = await tx
      .update(agentDrawOrders)
      .set({
        status: "failed",
        lastErrorMessage: order.lastErrorMessage || "管理员确认未出卡",
        updatedAt: now,
      })
      .where(
        and(
          eq(agentDrawOrders.id, order.id),
          inArray(agentDrawOrders.status, ["issuing", "unknown"]),
          eq(agentDrawOrders.issuedCount, 0),
        ),
      )
      .returning();
    if (!updated) throw new DrawError("这单状态已变化，请刷新", 409);
  });
  await writeAuditLog({
    actor,
    action: "admin.draw.order.mark_failed",
    targetType: "agent_draw_order",
    targetId: order.id,
    metadata: { drawNo: order.drawNo },
  });
}

export async function listPendingDrawApplications() {
  const rows = await db
    .select({
      id: agentDrawApplications.id,
      agentId: agentDrawApplications.agentId,
      contact: agentDrawApplications.contact,
      expectedMonthly: agentDrawApplications.expectedMonthly,
      note: agentDrawApplications.note,
      createdAt: agentDrawApplications.createdAt,
      displayName: agents.displayName,
      shopName: agents.shopName,
    })
    .from(agentDrawApplications)
    .innerJoin(agents, eq(agents.id, agentDrawApplications.agentId))
    .where(eq(agentDrawApplications.status, "pending"))
    .orderBy(desc(agentDrawApplications.id));
  return rows.map((row) => ({
    ...row,
    name: publicShopName(row),
  }));
}

async function exposureFor(agentId: number) {
  const [{ unsettledCents }] = await db
    .select({
      unsettledCents: sql<number>`coalesce(sum(${agentDrawItems.amountCents}), 0)`,
    })
    .from(agentDrawItems)
    .where(and(eq(agentDrawItems.agentId, agentId), eq(agentDrawItems.status, "unsettled")));
  const inflight = await db
    .select({
      quantity: agentDrawOrders.quantity,
      issuedCount: agentDrawOrders.issuedCount,
      unitPriceCents: agentDrawOrders.unitPriceCents,
    })
    .from(agentDrawOrders)
    .where(
      and(eq(agentDrawOrders.agentId, agentId), inArray(agentDrawOrders.status, ["issuing", "unknown"])),
    );
  return { unsettledCents: Number(unsettledCents) || 0, inflight };
}

export async function getAgentDrawState(agentId: number) {
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
  });
  const application = await db.query.agentDrawApplications.findFirst({
    where: eq(agentDrawApplications.agentId, agentId),
    orderBy: [desc(agentDrawApplications.id)],
  });
  const notice = await getSetting("draw_agent_notice", "");
  const status = access?.status || "none";
  const rejectReason = access?.rejectReason || application?.reviewNote || "";
  const applicationView = application
    ? {
        contact: application.contact,
        expectedMonthly: application.expectedMonthly,
        note: application.note,
        status: application.status,
        createdAt: application.createdAt,
      }
    : null;
  if ((status !== "approved" && status !== "suspended") || !access) {
    return {
      status,
      notice,
      rejectReason,
      canDraw: false,
      application: applicationView,
    };
  }
  const { unsettledCents, inflight } = await exposureFor(agentId);
  const credit = computeDrawCredit({
    limitCents: access.creditLimitCents,
    unsettledCents,
    inflight,
  });
  const todayStart = beijingDayStartIso(new Date());
  const [{ todayCount }] = await db
    .select({ todayCount: sql<number>`count(*)` })
    .from(agentDrawItems)
    .where(
      and(
        eq(agentDrawItems.agentId, agentId),
        gte(agentDrawItems.createdAt, todayStart),
        ne(agentDrawItems.status, "void"),
      ),
    );
  const allowed = parseAllowedPlanKeys(access.allowedPlanKeysJson);
  const plans = await db
    .select({
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      basePlanKey: platformPlans.basePlanKey,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      upstreamPlanKey: platformPlans.upstreamPlanKey,
      cardplatformSellable: platformPlans.cardplatformSellable,
      fulfillmentKind: platformPlans.fulfillmentKind,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      drawPriceCents: agentPlanPrices.drawPriceCents,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, agentId),
        eq(platformPlans.enabled, true),
        eq(platformPlans.cardplatformSellable, true),
        eq(platformPlans.fulfillmentKind, "cardplatform"),
      ),
    );
  const drawable = plans.flatMap((plan) => {
    if (!planAllowed(allowed, plan.planKey)) return [];
    const price = resolveDrawUnitPrice(plan);
    if (!price) return [];
    return [
      {
        planKey: plan.planKey,
        name: planNameWithRegion(plan.name, plan.regionCapable, plan.paymentCountry, plan.regionLabel),
        unitPriceCents: price.unitPriceCents,
        paymentCountry: plan.paymentCountry,
        regionCapable: plan.regionCapable,
      },
    ];
  });
  const ledger = await agentLedgerSummary(agentId);
  return {
    status,
    notice,
    canDraw: status === "approved",
    credit,
    summary: ledger.summary,
    statementText: ledger.statementText,
    limits: {
      maxPerDraw: access.maxPerDraw,
      dailyLimit: access.dailyLimitCount,
      todayCount: Number(todayCount) || 0,
    },
    plans: status === "approved" ? drawable : [],
    application: null,
  };
}

export async function applyForDraw(
  agentId: number,
  input: { contact: string; expectedMonthly: string; note: string },
) {
  const contact = input.contact.trim();
  if (!contact) throw new DrawError("请填写联系方式");
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
  });
  if (access?.status === "approved") throw new DrawError("你已经开通了自助提卡");
  if (access?.status === "suspended") throw new DrawError("平台已暂停你的提卡，请联系平台", 403);
  if (access?.status === "pending") throw new DrawError("申请已提交，请等平台联系");
  const pending = await db.query.agentDrawApplications.findFirst({
    where: and(eq(agentDrawApplications.agentId, agentId), eq(agentDrawApplications.status, "pending")),
  });
  if (pending) throw new DrawError("申请已提交，请等平台联系");
  const now = nowIso();
  const [created] = await db
    .insert(agentDrawApplications)
    .values({
      agentId,
      contact,
      expectedMonthly: input.expectedMonthly,
      note: input.note.trim(),
      createdAt: now,
    })
    .returning();
  await db
    .insert(agentDrawAccess)
    .values({ agentId, status: "pending", updatedAt: now })
    .onConflictDoUpdate({
      target: agentDrawAccess.agentId,
      set: { status: "pending", updatedAt: now },
    });
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (agent && created) {
    await notifyDrawApply({
      kind: "apply",
      agentName: publicShopName(agent),
      username: "",
      agentId,
      shopUrl: "",
      contact,
      expectedMonthlyLabel: input.expectedMonthly,
      note: input.note.trim(),
      paidOrderCount: 0,
      recentPaidOrderCount: 0,
      appliedAt: now,
      adminUrl: "/admin#draw",
    }).catch(() => null);
  }
  return created;
}

export async function createDrawOrder(
  agentId: number,
  input: { requestId: string; planKey: string; quantity: number; regionConfirmed?: boolean },
) {
  if ((await getSetting("draw_enabled", "1")) !== "1") {
    throw new DrawError("平台暂时关闭了自助提卡", 403);
  }
  const requestId = input.requestId.trim();
  if (!requestId) throw new DrawError("缺少请求编号");
  const existing = await db.query.agentDrawOrders.findFirst({
    where: and(eq(agentDrawOrders.agentId, agentId), eq(agentDrawOrders.requestId, requestId)),
  });
  if (existing) {
    const stale = Date.now() - Date.parse(existing.updatedAt) >= DRAW_ISSUING_LEASE_MS;
    if (existing.status === "unknown" || (existing.status === "issuing" && stale)) {
      await issueDrawOrder(existing.id, "retry");
    }
    return presentDrawOrder(existing.id);
  }

  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
  });
  if (access?.status === "suspended") {
    throw new DrawError("平台已暂停你的提卡，如有疑问请联系平台", 403);
  }
  if (!access || access.status !== "approved") throw new DrawError("还没有提卡权限", 403);
  const quantityError = drawQuantityError(input.quantity, access.maxPerDraw);
  if (quantityError) throw new DrawError(quantityError);

  const [offer] = await db
    .select({
      planId: platformPlans.id,
      planKey: platformPlans.planKey,
      name: platformPlans.name,
      basePlanKey: platformPlans.basePlanKey,
      upstreamPlanKey: platformPlans.upstreamPlanKey,
      paymentCountry: platformPlans.paymentCountry,
      regionLabel: platformPlans.regionLabel,
      regionCapable: platformPlans.regionCapable,
      globalCostPriceCents: platformPlans.globalCostPriceCents,
      upstreamCostCents: platformPlans.upstreamCostCents,
      costOverrideCents: agentPlanPrices.costOverrideCents,
      drawPriceCents: agentPlanPrices.drawPriceCents,
    })
    .from(agentPlanPrices)
    .innerJoin(platformPlans, eq(platformPlans.id, agentPlanPrices.planId))
    .where(
      and(
        eq(agentPlanPrices.agentId, agentId),
        eq(platformPlans.planKey, input.planKey),
        eq(platformPlans.enabled, true),
        eq(platformPlans.cardplatformSellable, true),
      ),
    )
    .limit(1);
  if (!offer) throw new DrawError("这个套餐现在不能提");
  if (!planAllowed(parseAllowedPlanKeys(access.allowedPlanKeysJson), offer.planKey)) {
    throw new DrawError("这个套餐不在你的可提范围里");
  }
  const price = resolveDrawUnitPrice(offer);
  if (!price) throw new DrawError("该套餐未配置价格，暂不能提卡", 409);

  const account = await getDefaultCardplatformAccount();
  if (!account) throw new DrawError("卡台未就绪", 503);
  if (offer.paymentCountry && !accountSupportsPaymentCountry(account)) {
    throw new DrawError("当前卡台不支持这个付款地区，请先提菲区", 409);
  }

  const { unsettledCents, inflight } = await exposureFor(agentId);
  const freshIssuing = await db.query.agentDrawOrders.findFirst({
    where: and(eq(agentDrawOrders.agentId, agentId), eq(agentDrawOrders.status, "issuing")),
  });
  if (freshIssuing && Date.now() - Date.parse(freshIssuing.updatedAt) < DRAW_ISSUING_LEASE_MS) {
    throw new DrawError("上一笔还在出卡，请稍候", 409);
  }
  const credit = computeDrawCredit({
    limitCents: access.creditLimitCents,
    unsettledCents,
    inflight,
  });
  const amount = price.unitPriceCents * input.quantity;
  const creditError = drawCreditError(credit, amount);
  if (creditError) throw new DrawError(creditError, 409);
  const todayStart = beijingDayStartIso(new Date());
  const [{ todayCount }] = await db
    .select({ todayCount: sql<number>`count(*)` })
    .from(agentDrawItems)
    .where(
      and(
        eq(agentDrawItems.agentId, agentId),
        gte(agentDrawItems.createdAt, todayStart),
        ne(agentDrawItems.status, "void"),
      ),
    );
  const dailyError = drawDailyLimitError({
    dailyLimitCount: access.dailyLimitCount,
    todayCount: Number(todayCount) || 0,
    quantity: input.quantity,
  });
  if (dailyError) throw new DrawError(dailyError, 409);

  const now = nowIso();
  const drawNo = newOrderNo("DR");
  const [order] = await db
    .insert(agentDrawOrders)
    .values({
      drawNo,
      agentId,
      requestId,
      planId: offer.planId,
      planKeySnapshot: offer.planKey,
      planNameSnapshot: planNameWithRegion(
        offer.name,
        offer.regionCapable,
        offer.paymentCountry,
        offer.regionLabel,
      ),
      quantity: input.quantity,
      unitPriceCents: price.unitPriceCents,
      priceSource: price.source,
      upstreamCostUnitCents: offer.upstreamCostCents,
      cardplatformAccountId: account.id,
      idempotencyKey: `draw:${drawNo}`,
      status: "issuing",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!order) throw new DrawError("提卡单创建失败");
  await issueDrawOrder(order.id, "initial");
  return presentDrawOrder(order.id);
}

/**
 * initial：刚建的单；retry：代理重点或管理员取回，结果未知的随时可取、出卡中的要等租约过期；
 * job：定时任务，两种都要等租约过期。领到后一律改回 issuing，同一时刻只有一个请求打卡台。
 */
async function issueDrawOrder(orderId: number, mode: "initial" | "retry" | "job") {
  const now = nowIso();
  const staleBefore = new Date(Date.now() - DRAW_ISSUING_LEASE_MS).toISOString();
  const stale = lte(agentDrawOrders.updatedAt, staleBefore);
  const claimable =
    mode === "initial"
      ? eq(agentDrawOrders.status, "issuing")
      : mode === "retry"
        ? or(
            eq(agentDrawOrders.status, "unknown"),
            and(eq(agentDrawOrders.status, "issuing"), stale),
          )
        : and(inArray(agentDrawOrders.status, ["issuing", "unknown"]), stale);
  const [order] = await db
    .update(agentDrawOrders)
    .set({
      status: "issuing",
      updatedAt: now,
      attempts: sql`${agentDrawOrders.attempts} + 1`,
    })
    .where(and(eq(agentDrawOrders.id, orderId), claimable))
    .returning();
  if (!order) return false;
  const plan = await db.query.platformPlans.findFirst({
    where: eq(platformPlans.id, order.planId),
  });
  const target = issueTargetFromSnapshot({
    planKeySnapshot: order.planKeySnapshot,
    upstreamPlanKeySnapshot: plan?.upstreamPlanKey || plan?.planKey || order.planKeySnapshot,
    paymentCountrySnapshot: plan?.paymentCountry || "",
  });
  try {
    const { client, account } = await getCardplatformClientById(order.cardplatformAccountId);
    if (target.paymentCountry && !accountSupportsPaymentCountry(account)) {
      throw new CardplatformError({
        message: "卡台账户不支持付款地区",
        errorCode: "CARDPLATFORM_REGION_UNSUPPORTED",
      });
    }
    const pref = await issuePrefFromAccount(account.id);
    const cdks = await client.issueMany(
      target.plan,
      order.quantity,
      issueIdempotencyKey(order.idempotencyKey, 0, 0),
      {
        ...(pref
          ? { issuer: pref.issuer, segmentType: pref.segmentType, segmentKey: pref.segmentKey }
          : {}),
        ...(target.paymentCountry ? { paymentCountry: target.paymentCountry } : {}),
      },
    );
    const writtenAt = nowIso();
    let inserted = 0;
    await db.transaction(async (tx) => {
      for (const cdk of cdks) {
        const codeHash = hashLookupValue(cdk.code.toUpperCase());
        const [issued] = await tx
          .insert(issuedCdks)
          .values({
            orderId: 0,
            agentId: order.agentId,
            planKey: order.planKeySnapshot,
            paymentCountry: target.paymentCountry,
            codeEncrypted: encryptSecret(cdk.code),
            codeHash,
            codePrefix: cdk.codePrefix || (cdk.code.length >= 14 ? cdk.code.slice(0, 14) : ""),
            cardplatformAccountId: account.id,
            upstreamRef: String(cdk.id || ""),
            upstreamFeeMinor: cdk.feeAmountMinor,
            status: "unused",
            source: "draw",
            drawOrderId: order.id,
            issuedAt: writtenAt,
            updatedAt: writtenAt,
          })
          .onConflictDoNothing({ target: issuedCdks.codeHash })
          .returning();
        if (!issued) continue;
        await tx.insert(agentDrawItems).values({
          drawOrderId: order.id,
          issuedCdkId: issued.id,
          agentId: order.agentId,
          planKey: order.planKeySnapshot,
          amountCents: order.unitPriceCents,
          upstreamCostCents: order.upstreamCostUnitCents,
          createdAt: writtenAt,
          updatedAt: writtenAt,
        });
        inserted += 1;
      }
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)` })
        .from(agentDrawItems)
        .where(eq(agentDrawItems.drawOrderId, order.id));
      const issuedCount = Number(total) || 0;
      const status = drawOrderStatusFromIssued(issuedCount, order.quantity);
      await tx
        .update(agentDrawOrders)
        .set({
          status,
          issuedCount,
          deliveredAt: issuedCount > 0 ? writtenAt : null,
          lastErrorCode: "",
          lastErrorMessage: "",
          updatedAt: writtenAt,
        })
        .where(eq(agentDrawOrders.id, order.id));
    });
    if (inserted > 0) {
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, order.agentId) });
      const access = await db.query.agentDrawAccess.findFirst({
        where: eq(agentDrawAccess.agentId, order.agentId),
      });
      if (access?.notifyEachDraw !== false) {
      const { unsettledCents, inflight } = await exposureFor(order.agentId);
      const credit = computeDrawCredit({
        limitCents: access?.creditLimitCents || 0,
        unsettledCents,
        inflight,
      });
      await notifyDrawCreated({
        drawNo: order.drawNo,
        agentName: agent ? publicShopName(agent) : String(order.agentId),
        planName: order.planNameSnapshot,
        quantity: order.quantity,
        issuedCount: inserted,
        unitPriceCents: order.unitPriceCents,
        amountCents: order.unitPriceCents * inserted,
        exposureCents: credit.exposureCents,
        limitCents: credit.limitCents,
        upstreamCostUnitCents: order.upstreamCostUnitCents,
      }).catch(() => null);
      }
      await maybeWarnCredit(order.agentId).catch(() => null);
    }
    return true;
  } catch (error) {
    const cardError =
      error instanceof CardplatformError
        ? error
        : new CardplatformError({ message: error instanceof Error ? error.message : "提卡失败" });
    const unknown = cardError.outcomeUnknown && !isRegionIssueError(cardError);
    await db
      .update(agentDrawOrders)
      .set({
        status: unknown ? "unknown" : "failed",
        lastErrorCode: isRegionIssueError(cardError)
          ? "CARDPLATFORM_REGION_UNAVAILABLE"
          : cardError.errorCode,
        lastErrorMessage: cardError.message.slice(0, 500),
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(agentDrawOrders.id, order.id),
          inArray(agentDrawOrders.status, ["issuing", "unknown"]),
        ),
      );
    return true;
  }
}

async function presentDrawOrder(orderId: number) {
  const order = await db.query.agentDrawOrders.findFirst({
    where: eq(agentDrawOrders.id, orderId),
  });
  if (!order) throw new DrawError("提卡单不存在", 404);
  const cards = await db
    .select({ codeEncrypted: issuedCdks.codeEncrypted })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .where(and(eq(agentDrawItems.drawOrderId, order.id), ne(agentDrawItems.status, "void")));
  const { unsettledCents, inflight } = await exposureFor(order.agentId);
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, order.agentId),
  });
  const credit = computeDrawCredit({
    limitCents: access?.creditLimitCents || 0,
    unsettledCents,
    inflight,
  });
  return {
    drawNo: order.drawNo,
    status: order.status,
    planName: order.planNameSnapshot,
    quantity: order.quantity,
    issuedCount: order.issuedCount,
    unitPriceCents: order.unitPriceCents,
    amountCents: order.unitPriceCents * order.issuedCount,
    codes: cards.map((card) => decryptSecret(card.codeEncrypted)),
    message:
      order.status === "unknown" || order.status === "issuing"
        ? order.lastErrorMessage || "卡台还没返回结果，没有重复扣费。再点一次会取回同一笔。"
        : order.lastErrorMessage,
    credit,
  };
}

async function maybeWarnCredit(agentId: number) {
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
  });
  if (!access || access.creditWarnedAt) return;
  const { unsettledCents, inflight } = await exposureFor(agentId);
  const credit = computeDrawCredit({
    limitCents: access.creditLimitCents,
    unsettledCents,
    inflight,
  });
  if (
    !creditWarnCrossed({
      limitCents: credit.limitCents,
      exposureCents: credit.exposureCents,
      alreadyWarned: false,
    })
  ) {
    return;
  }
  const now = nowIso();
  const [claimed] = await db
    .update(agentDrawAccess)
    .set({ creditWarnedAt: now, updatedAt: now })
    .where(and(eq(agentDrawAccess.agentId, agentId), isNull(agentDrawAccess.creditWarnedAt)))
    .returning();
  if (!claimed) return;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  await notifyDrawAlert({
    kind: "credit_warning",
    agentName: agent ? publicShopName(agent) : String(agentId),
    exposureCents: credit.exposureCents,
    limitCents: credit.limitCents,
    adminUrl: "/admin#draw",
  }).catch(() => null);
}

async function agentLedgerSummary(agentId: number) {
  const rows = await db
    .select({
      createdAt: agentDrawItems.createdAt,
      planKey: agentDrawItems.planKey,
      amountCents: agentDrawItems.amountCents,
      planName: agentDrawOrders.planNameSnapshot,
    })
    .from(agentDrawItems)
    .innerJoin(agentDrawOrders, eq(agentDrawOrders.id, agentDrawItems.drawOrderId))
    .where(and(eq(agentDrawItems.agentId, agentId), eq(agentDrawItems.status, "unsettled")));
  const [{ voidCount }] = await db
    .select({ voidCount: sql<number>`count(*)` })
    .from(agentDrawItems)
    .where(and(eq(agentDrawItems.agentId, agentId), eq(agentDrawItems.status, "void")));
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  const summary = summarizeDrawItems(rows);
  return {
    summary: {
      count: rows.length,
      amountCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
      groups: summary,
    },
    statementText: buildDrawStatementText({
      shopName: agent ? publicShopName(agent) : String(agentId),
      items: rows,
      voidCount: Number(voidCount) || 0,
    }),
  };
}

function parseSummary(raw: string): DrawPlanSummary[] {
  try {
    const parsed = JSON.parse(raw) as DrawPlanSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function listAgentUnsettledItems(agentId: number) {
  const rows = await listUnsettledDrawItems(agentId);
  return rows.map(({ upstreamCostCents: _cost, ...row }) => row);
}

export async function listAgentDrawOrders(agentId: number) {
  return db
    .select({
      drawNo: agentDrawOrders.drawNo,
      status: agentDrawOrders.status,
      planName: agentDrawOrders.planNameSnapshot,
      quantity: agentDrawOrders.quantity,
      issuedCount: agentDrawOrders.issuedCount,
      unitPriceCents: agentDrawOrders.unitPriceCents,
      createdAt: agentDrawOrders.createdAt,
      lastErrorMessage: agentDrawOrders.lastErrorMessage,
    })
    .from(agentDrawOrders)
    .where(eq(agentDrawOrders.agentId, agentId))
    .orderBy(desc(agentDrawOrders.id))
    .limit(100);
}

export async function getAgentDrawOrderCodes(agentId: number, drawNo: string, actor: Actor) {
  const order = await db.query.agentDrawOrders.findFirst({
    where: and(eq(agentDrawOrders.agentId, agentId), eq(agentDrawOrders.drawNo, drawNo)),
  });
  if (!order) throw new DrawError("提卡单不存在", 404);
  const cards = await db
    .select({ codeEncrypted: issuedCdks.codeEncrypted })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .where(and(eq(agentDrawItems.drawOrderId, order.id), ne(agentDrawItems.status, "void")));
  await writeAuditLog({
    actor,
    action: "agent.draw.codes.view",
    targetType: "agent_draw_order",
    targetId: order.id,
    metadata: { drawNo: order.drawNo, count: cards.length },
  });
  return {
    drawNo: order.drawNo,
    status: order.status,
    planName: order.planNameSnapshot,
    createdAt: order.createdAt,
    codes: cards.map((card) => decryptSecret(card.codeEncrypted)),
  };
}

export type DrawBillQuery = {
  agentId?: number;
  query?: string;
  paymentMethod?: string;
  status?: string;
};

function billQueryWhere(input: DrawBillQuery) {
  const query = (input.query || "").trim().replace(/[%_]/g, "");
  const status = input.status === "settled" || input.status === "reverted" ? input.status : "";
  const method = normalizeDrawPaymentMethod(input.paymentMethod || "");
  return and(
    input.agentId && input.agentId > 0 ? eq(agentDrawBills.agentId, input.agentId) : undefined,
    method ? eq(agentDrawBills.paymentMethod, method) : undefined,
    status ? eq(agentDrawBills.status, status) : undefined,
    query
      ? or(
          like(agentDrawBills.billNo, `%${query}%`),
          like(agentDrawBills.paymentReference, `%${query}%`),
          like(agentDrawBills.notes, `%${query}%`),
          like(agents.displayName, `%${query}%`),
          like(agents.shopName, `%${query}%`),
        )
      : undefined,
  );
}

export async function listDrawBills(filter: DrawBillQuery | number = {}) {
  const input: DrawBillQuery = typeof filter === "number" ? { agentId: filter } : filter;
  const rows = await db
    .select({
      id: agentDrawBills.id,
      billNo: agentDrawBills.billNo,
      agentId: agentDrawBills.agentId,
      itemCount: agentDrawBills.itemCount,
      amountCents: agentDrawBills.amountCents,
      paymentMethod: agentDrawBills.paymentMethod,
      paymentReference: agentDrawBills.paymentReference,
      notes: agentDrawBills.notes,
      status: agentDrawBills.status,
      createdAt: agentDrawBills.createdAt,
      revertReason: agentDrawBills.revertReason,
      displayName: agents.displayName,
      shopName: agents.shopName,
    })
    .from(agentDrawBills)
    .innerJoin(agents, eq(agents.id, agentDrawBills.agentId))
    .where(billQueryWhere(input))
    .orderBy(desc(agentDrawBills.id))
    .limit(200);
  return rows.map((row) => ({
    id: row.id,
    billNo: row.billNo,
    agentId: row.agentId,
    name: publicShopName(row),
    itemCount: row.itemCount,
    amountCents: row.amountCents,
    paymentMethod: row.paymentMethod,
    paymentMethodLabel: drawPaymentMethodLabel(row.paymentMethod),
    paymentReference: row.paymentReference,
    notes: row.notes,
    status: row.status,
    createdAt: row.createdAt,
    revertReason: row.revertReason,
    canRevert: row.status === "settled" && billRevertOpen(row.createdAt),
  }));
}

async function billItems(billId: number, agentId?: number) {
  return db
    .select({
      id: agentDrawItems.id,
      createdAt: agentDrawItems.createdAt,
      amountCents: agentDrawItems.amountCents,
      status: agentDrawItems.status,
      planName: agentDrawOrders.planNameSnapshot,
      drawNo: agentDrawOrders.drawNo,
      paymentCountry: issuedCdks.paymentCountry,
      cdkStatus: issuedCdks.status,
      codeEncrypted: issuedCdks.codeEncrypted,
    })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .innerJoin(agentDrawOrders, eq(agentDrawOrders.id, agentDrawItems.drawOrderId))
    .where(
      and(
        eq(agentDrawItems.billId, billId),
        agentId ? eq(agentDrawItems.agentId, agentId) : undefined,
      ),
    )
    .orderBy(desc(agentDrawItems.id));
}

export async function getDrawBill(billId: number) {
  const [bill] = await db
    .select()
    .from(agentDrawBills)
    .where(eq(agentDrawBills.id, billId))
    .limit(1);
  if (!bill) throw new DrawError("账单不存在", 404);
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, bill.agentId) });
  const items = await billItems(bill.id);
  return {
    id: bill.id,
    billNo: bill.billNo,
    agentId: bill.agentId,
    name: agent ? publicShopName(agent) : String(bill.agentId),
    itemCount: bill.itemCount,
    amountCents: bill.amountCents,
    paymentMethod: bill.paymentMethod,
    paymentMethodLabel: drawPaymentMethodLabel(bill.paymentMethod),
    paymentReference: bill.paymentReference,
    notes: bill.notes,
    status: bill.status,
    createdAt: bill.createdAt,
    revertReason: bill.revertReason,
    canRevert: bill.status === "settled" && billRevertOpen(bill.createdAt),
    summary: parseSummary(bill.summaryJson),
    items: items.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      amountCents: item.amountCents,
      status: item.status,
      planName: item.planName,
      drawNo: item.drawNo,
      paymentCountry: item.paymentCountry,
      cdkStatus: item.cdkStatus,
      codeMasked: maskCode(decryptSecret(item.codeEncrypted)),
    })),
  };
}

export async function listAgentBills(agentId: number) {
  const bills = await listDrawBills(agentId);
  return bills.map(({ notes: _notes, paymentReference: _ref, ...bill }) => bill);
}

export async function getAgentBill(agentId: number, billNo: string) {
  const bill = await db.query.agentDrawBills.findFirst({
    where: and(eq(agentDrawBills.agentId, agentId), eq(agentDrawBills.billNo, billNo)),
  });
  if (!bill) throw new DrawError("账单不存在", 404);
  const items = await billItems(bill.id, agentId);
  return {
    billNo: bill.billNo,
    itemCount: bill.itemCount,
    amountCents: bill.amountCents,
    paymentMethodLabel: drawPaymentMethodLabel(bill.paymentMethod),
    status: bill.status,
    createdAt: bill.createdAt,
    summary: parseSummary(bill.summaryJson),
    items: items.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      amountCents: item.amountCents,
      planName: item.planName,
      drawNo: item.drawNo,
      paymentCountry: item.paymentCountry,
      cdkStatus: item.cdkStatus,
      codeMasked: maskCode(decryptSecret(item.codeEncrypted)),
    })),
  };
}

export async function revertDrawBill(input: { billId: number; reason: string }, actor: Actor) {
  const reason = input.reason.trim();
  if (!reason) throw new DrawError("请填写撤销原因");
  const now = nowIso();
  const bill = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(agentDrawBills)
      .where(eq(agentDrawBills.id, input.billId))
      .limit(1);
    if (!current || current.status !== "settled") throw new DrawError("这张账单不能撤销", 409);
    if (!billRevertOpen(current.createdAt)) throw new DrawError("超过 7 天，不能撤销");
    const [updated] = await tx
      .update(agentDrawBills)
      .set({
        status: "reverted",
        revertedAt: now,
        revertedBy: actor.id,
        revertReason: reason,
      })
      .where(and(eq(agentDrawBills.id, current.id), eq(agentDrawBills.status, "settled")))
      .returning();
    if (!updated) throw new DrawError("这张账单不能撤销", 409);
    await tx
      .update(agentDrawItems)
      .set({ status: "unsettled", billId: null, settledAt: null, updatedAt: now })
      .where(and(eq(agentDrawItems.billId, current.id), eq(agentDrawItems.status, "settled")));
    return updated;
  });
  await writeAuditLog({
    actor,
    action: "admin.draw.bill.revert",
    targetType: "agent_draw_bill",
    targetId: bill.id,
    metadata: { agentId: bill.agentId, reason },
  });
  await maybeWarnCredit(bill.agentId);
  return bill;
}

async function refundDrawCardUpstream(cdk: {
  cardplatformAccountId: number;
  upstreamRef: string;
}) {
  const upstreamId = Number(cdk.upstreamRef);
  if (!Number.isSafeInteger(upstreamId) || upstreamId <= 0) {
    throw new DrawError("卡密缺少卡台引用，无法在卡台删卡。可以改选「只在本系统作废」", 409);
  }
  try {
    const { client } = await getCardplatformClientById(cdk.cardplatformAccountId, {
      allowDisabled: true,
    });
    try {
      await client.deleteCdkAndRefund(upstreamId);
    } catch (error) {
      if (error instanceof CardplatformError && error.httpStatus === 404) {
        return;
      }
      if (error instanceof CardplatformError && error.httpStatus === 405) {
        await client.disableCdk(upstreamId);
        return;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof DrawError) throw error;
    throw new DrawError(
      error instanceof Error ? `卡台处理失败，本地账没有改：${error.message}` : "卡台处理失败，本地账没有改",
      502,
    );
  }
}

export async function voidDrawItem(
  input: { itemId: number; mode: "upstream" | "local"; reason: string },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (!reason) throw new DrawError("请填写作废原因");
  if (input.mode !== "upstream" && input.mode !== "local") throw new DrawError("请选择处理方式");
  const [row] = await db
    .select({
      id: agentDrawItems.id,
      agentId: agentDrawItems.agentId,
      status: agentDrawItems.status,
      issuedCdkId: agentDrawItems.issuedCdkId,
      cdkStatus: issuedCdks.status,
      cardplatformAccountId: issuedCdks.cardplatformAccountId,
      upstreamRef: issuedCdks.upstreamRef,
    })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .where(eq(agentDrawItems.id, input.itemId))
    .limit(1);
  if (!row || row.status !== "unsettled") throw new DrawError("只有未结算的卡可以作废");
  if (row.cdkStatus !== "unused") throw new DrawError("这张卡已经使用或正在兑换，不能作废");
  if (input.mode === "upstream") await refundDrawCardUpstream(row);
  const now = nowIso();
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agentDrawItems)
      .set({
        status: "void",
        voidReason: reason,
        voidedAt: now,
        voidedBy: actor.id,
        updatedAt: now,
      })
      .where(and(eq(agentDrawItems.id, row.id), eq(agentDrawItems.status, "unsettled")))
      .returning();
    if (!updated) throw new DrawError("这张卡状态已变化，请刷新", 409);
    await tx
      .update(issuedCdks)
      .set({ status: "disabled", updatedAt: now })
      .where(and(eq(issuedCdks.id, row.issuedCdkId), eq(issuedCdks.status, "unused")));
  });
  await writeAuditLog({
    actor,
    action: "admin.draw.item.void",
    targetType: "agent_draw_item",
    targetId: row.id,
    metadata: { agentId: row.agentId, mode: input.mode, reason },
  });
}

export async function recoverDrawOrder(orderId: number, actor: Actor) {
  const order = await db.query.agentDrawOrders.findFirst({
    where: eq(agentDrawOrders.id, orderId),
  });
  if (!order || (order.status !== "issuing" && order.status !== "unknown")) {
    throw new DrawError("这单不用取回");
  }
  const claimed = await issueDrawOrder(order.id, "retry");
  if (!claimed) throw new DrawError("这单正在处理，请稍候", 409);
  await writeAuditLog({
    actor,
    action: "admin.draw.order.recover",
    targetType: "agent_draw_order",
    targetId: order.id,
    metadata: { drawNo: order.drawNo },
  });
  return presentDrawOrder(order.id);
}

export async function recoverStuckDrawOrders(limit = 10) {
  const staleBefore = new Date(Date.now() - DRAW_ISSUING_LEASE_MS).toISOString();
  const due = await db
    .select({ id: agentDrawOrders.id })
    .from(agentDrawOrders)
    .where(
      and(
        inArray(agentDrawOrders.status, ["issuing", "unknown"]),
        lte(agentDrawOrders.updatedAt, staleBefore),
        lt(agentDrawOrders.attempts, DRAW_RECOVER_MAX_ATTEMPTS),
      ),
    )
    .orderBy(agentDrawOrders.id)
    .limit(limit);
  let checked = 0;
  for (const row of due) {
    const claimed = await issueDrawOrder(row.id, "job");
    if (claimed) checked += 1;
  }
  const exhausted = await db
    .select({
      id: agentDrawOrders.id,
      drawNo: agentDrawOrders.drawNo,
      agentId: agentDrawOrders.agentId,
      planName: agentDrawOrders.planNameSnapshot,
      quantity: agentDrawOrders.quantity,
    })
    .from(agentDrawOrders)
    .where(
      and(
        inArray(agentDrawOrders.status, ["issuing", "unknown"]),
        gte(agentDrawOrders.attempts, DRAW_RECOVER_MAX_ATTEMPTS),
        ne(agentDrawOrders.lastErrorCode, "DRAW_RECOVER_NOTIFIED"),
      ),
    )
    .limit(10);
  let alerted = 0;
  for (const order of exhausted) {
    const [claimed] = await db
      .update(agentDrawOrders)
      .set({ lastErrorCode: "DRAW_RECOVER_NOTIFIED", updatedAt: nowIso() })
      .where(
        and(
          eq(agentDrawOrders.id, order.id),
          inArray(agentDrawOrders.status, ["issuing", "unknown"]),
          ne(agentDrawOrders.lastErrorCode, "DRAW_RECOVER_NOTIFIED"),
        ),
      )
      .returning();
    if (!claimed) continue;
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, order.agentId) });
    await notifyDrawAlert({
      kind: "recover_failed",
      agentName: agent ? publicShopName(agent) : String(order.agentId),
      drawNo: order.drawNo,
      planName: order.planName,
      quantity: order.quantity,
      adminUrl: "/admin#draw",
    }).catch(() => null);
    alerted += 1;
  }
  return { checked, alerted };
}

export async function suspendDrawAccess(agentId: number, actor: Actor) {
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
  });
  if (!access || access.status !== "approved") throw new DrawError("只有已开通的代理可以暂停");
  const now = nowIso();
  await db
    .update(agentDrawAccess)
    .set({ status: "suspended", suspendedAt: now, updatedAt: now })
    .where(and(eq(agentDrawAccess.agentId, agentId), eq(agentDrawAccess.status, "approved")));
  await writeAuditLog({
    actor,
    action: "admin.draw.suspend",
    targetType: "agent",
    targetId: agentId,
  });
}

export async function resumeDrawAccess(agentId: number, actor: Actor) {
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, agentId),
  });
  if (!access || access.status !== "suspended") throw new DrawError("这个代理没有暂停");
  const now = nowIso();
  await db
    .update(agentDrawAccess)
    .set({ status: "approved", updatedAt: now })
    .where(and(eq(agentDrawAccess.agentId, agentId), eq(agentDrawAccess.status, "suspended")));
  await writeAuditLog({
    actor,
    action: "admin.draw.resume",
    targetType: "agent",
    targetId: agentId,
  });
}

export async function updateDrawSettings(
  input: {
    agentId: number;
    creditLimitCents: number;
    maxPerDraw: number;
    dailyLimitCount: number;
    notifyEachDraw: boolean;
  },
  actor: Actor,
) {
  const settingsError = drawSettingsError(input);
  if (settingsError) throw new DrawError(settingsError);
  const credit = await updateDrawCredit(
    { agentId: input.agentId, creditLimitCents: input.creditLimitCents },
    actor,
  );
  const access = await db.query.agentDrawAccess.findFirst({
    where: eq(agentDrawAccess.agentId, input.agentId),
  });
  if (!access || (access.status !== "approved" && access.status !== "suspended")) {
    throw new DrawError("这个代理还没开通提卡");
  }
  await db
    .update(agentDrawAccess)
    .set({
      maxPerDraw: input.maxPerDraw,
      dailyLimitCount: input.dailyLimitCount,
      notifyEachDraw: input.notifyEachDraw,
      updatedAt: nowIso(),
    })
    .where(eq(agentDrawAccess.agentId, input.agentId));
  await writeAuditLog({
    actor,
    action: "admin.draw.settings",
    targetType: "agent",
    targetId: input.agentId,
    metadata: {
      maxPerDraw: input.maxPerDraw,
      dailyLimitCount: input.dailyLimitCount,
      notifyEachDraw: input.notifyEachDraw,
    },
  });
  return credit;
}

export async function drawLedgerCsv(kind: "items" | "bills", agentId = 0, billQuery?: DrawBillQuery) {
  if (kind === "bills") {
    const bills = await listDrawBills({ ...billQuery, agentId: billQuery?.agentId || agentId });
    return toCsv(
      ["账单号", "代理", "结算时间", "张数", "金额", "方式", "流水号", "状态", "备注"],
      bills.map((bill) => [
        bill.billNo,
        bill.name,
        bill.createdAt,
        bill.itemCount,
        (bill.amountCents / 100).toFixed(2),
        bill.paymentMethodLabel,
        bill.paymentReference,
        bill.status === "reverted" ? "已撤销" : "已结算",
        bill.notes,
      ]),
    );
  }
  const rows = await db
    .select({
      createdAt: agentDrawItems.createdAt,
      amountCents: agentDrawItems.amountCents,
      status: agentDrawItems.status,
      planName: agentDrawOrders.planNameSnapshot,
      drawNo: agentDrawOrders.drawNo,
      paymentCountry: issuedCdks.paymentCountry,
      cdkStatus: issuedCdks.status,
      codeEncrypted: issuedCdks.codeEncrypted,
      billId: agentDrawItems.billId,
      displayName: agents.displayName,
      shopName: agents.shopName,
    })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .innerJoin(agentDrawOrders, eq(agentDrawOrders.id, agentDrawItems.drawOrderId))
    .innerJoin(agents, eq(agents.id, agentDrawItems.agentId))
    .where(agentId > 0 ? eq(agentDrawItems.agentId, agentId) : undefined)
    .orderBy(desc(agentDrawItems.id))
    .limit(DRAW_MAX_SETTLE_ITEMS);
  const billIds = [...new Set(rows.map((row) => row.billId).filter((id): id is number => Boolean(id)))];
  const billRows = billIds.length
    ? await db
        .select({ id: agentDrawBills.id, billNo: agentDrawBills.billNo })
        .from(agentDrawBills)
        .where(inArray(agentDrawBills.id, billIds))
    : [];
  const billNoById = new Map(billRows.map((row) => [row.id, row.billNo]));
  return toCsv(
    ["时间", "提卡单", "代理", "套餐", "付款地区", "卡密", "使用状态", "单价", "状态", "账单号"],
    rows.map((row) => [
      row.createdAt,
      row.drawNo,
      publicShopName(row),
      row.planName,
      row.paymentCountry || "菲区",
      maskCode(decryptSecret(row.codeEncrypted)),
      CDK_USE_LABEL[row.cdkStatus] || row.cdkStatus,
      (row.amountCents / 100).toFixed(2),
      DRAW_ITEM_LABEL[row.status] || row.status,
      row.billId ? billNoById.get(row.billId) || "" : "",
    ]),
  );
}
