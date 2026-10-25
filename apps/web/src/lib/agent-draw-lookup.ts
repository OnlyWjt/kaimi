import { and, desc, eq, inArray, isNotNull, like, or } from "drizzle-orm";
import { db } from "@/db";
import {
  agentDrawBills,
  agentDrawItems,
  agentDrawOrders,
  agentReconciliationBatches,
  agentReconciliationClaims,
  agents,
  issuedCdks,
  users,
} from "@/db/schema";
import { maskedDrawCode } from "@/lib/agent-draw-shared";
import { hashLookupValue } from "@/lib/crypto";

const LIMIT = 10;

export type DrawLookupItem = {
  id: number;
  codeMasked: string;
  /** 这张就是按卡密搜中的那张。 */
  matched: boolean;
  amountCents: number;
  cdkStatus: string;
  manualUsed: boolean;
  /** unsettled | settled | void */
  status: string;
  voidReason: string;
  /** 代理自己作废的（不是管理员替他作废） */
  voidedByAgent: boolean;
  /** 进了哪个对账批次 / 旧结算单，没有就是空串。 */
  settleRef: string;
  /** 对账批次还没结清。 */
  settlePending: boolean;
};

export type DrawLookupOrder = {
  drawNo: string;
  agentId: number;
  shopName: string;
  realName: string;
  username: string;
  planName: string;
  quantity: number;
  issuedCount: number;
  unitPriceCents: number;
  status: string;
  fulfillmentKind: string;
  lastErrorMessage: string;
  createdAt: string;
  items: DrawLookupItem[];
};

/**
 * 超管按提卡单号或卡密找提卡单。单号支持只粘一段；卡密按 HMAC 查找键精确匹配，
 * 成品号的查找键是邮箱，所以邮箱也能搜。
 */
export async function lookupDrawOrders(input: string): Promise<DrawLookupOrder[]> {
  const q = input.trim();
  if (q.length < 4) return [];

  const hashes = [...new Set([q, q.toUpperCase(), q.toLowerCase()].map(hashLookupValue))];
  const byCode = await db
    .select({ id: issuedCdks.id, drawOrderId: issuedCdks.drawOrderId })
    .from(issuedCdks)
    .where(and(inArray(issuedCdks.codeHash, hashes), isNotNull(issuedCdks.drawOrderId)));
  const matchedCdkIds = new Set(byCode.map((row) => row.id));

  const orderRows = await db
    .select({
      id: agentDrawOrders.id,
      drawNo: agentDrawOrders.drawNo,
      agentId: agentDrawOrders.agentId,
      planName: agentDrawOrders.planNameSnapshot,
      quantity: agentDrawOrders.quantity,
      issuedCount: agentDrawOrders.issuedCount,
      unitPriceCents: agentDrawOrders.unitPriceCents,
      status: agentDrawOrders.status,
      fulfillmentKind: agentDrawOrders.fulfillmentKind,
      lastErrorMessage: agentDrawOrders.lastErrorMessage,
      createdAt: agentDrawOrders.createdAt,
      shopName: agents.shopName,
      displayName: agents.displayName,
      realName: agents.realName,
      settlementName: agents.settlementName,
      username: users.username,
    })
    .from(agentDrawOrders)
    .leftJoin(agents, eq(agents.id, agentDrawOrders.agentId))
    .leftJoin(users, eq(users.agentId, agentDrawOrders.agentId))
    .where(
      or(
        like(agentDrawOrders.drawNo, `%${q.toUpperCase()}%`),
        byCode.length
          ? inArray(
              agentDrawOrders.id,
              byCode.map((row) => Number(row.drawOrderId)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(agentDrawOrders.id))
    .limit(LIMIT);
  if (!orderRows.length) return [];

  const items = await db
    .select({
      id: agentDrawItems.id,
      drawOrderId: agentDrawItems.drawOrderId,
      issuedCdkId: agentDrawItems.issuedCdkId,
      amountCents: agentDrawItems.amountCents,
      status: agentDrawItems.status,
      billId: agentDrawItems.billId,
      voidReason: agentDrawItems.voidReason,
      voidedByRole: users.role,
      manualUsedAt: agentDrawItems.manualUsedAt,
      codeEncrypted: issuedCdks.codeEncrypted,
      cdkStatus: issuedCdks.status,
    })
    .from(agentDrawItems)
    .innerJoin(issuedCdks, eq(issuedCdks.id, agentDrawItems.issuedCdkId))
    .leftJoin(users, eq(users.id, agentDrawItems.voidedBy))
    .where(
      inArray(
        agentDrawItems.drawOrderId,
        orderRows.map((row) => row.id),
      ),
    )
    .orderBy(agentDrawItems.id);

  const itemIds = items.map((row) => row.id);
  const claims = itemIds.length
    ? await db
        .select({
          sourceId: agentReconciliationClaims.sourceId,
          batchNo: agentReconciliationBatches.batchNo,
          batchStatus: agentReconciliationBatches.status,
        })
        .from(agentReconciliationClaims)
        .innerJoin(agentReconciliationBatches, eq(agentReconciliationBatches.id, agentReconciliationClaims.batchId))
        .where(
          and(
            eq(agentReconciliationClaims.sourceType, "draw_item"),
            inArray(agentReconciliationClaims.sourceId, itemIds),
          ),
        )
    : [];
  const claimByItem = new Map(claims.map((row) => [row.sourceId, row]));
  const billIds = [...new Set(items.map((row) => row.billId).filter((id): id is number => Boolean(id)))];
  const bills = billIds.length
    ? await db
        .select({ id: agentDrawBills.id, billNo: agentDrawBills.billNo })
        .from(agentDrawBills)
        .where(inArray(agentDrawBills.id, billIds))
    : [];
  const billNoById = new Map(bills.map((row) => [row.id, row.billNo]));

  return orderRows.map((order) => ({
    drawNo: order.drawNo,
    agentId: order.agentId,
    shopName: (order.shopName || order.displayName || "").trim() || `代理 ${order.agentId}`,
    realName: (order.realName || order.settlementName || "").trim(),
    username: order.username || "",
    planName: order.planName,
    quantity: order.quantity,
    issuedCount: order.issuedCount,
    unitPriceCents: order.unitPriceCents,
    status: order.status,
    fulfillmentKind: order.fulfillmentKind,
    lastErrorMessage: order.lastErrorMessage,
    createdAt: order.createdAt,
    items: items
      .filter((item) => item.drawOrderId === order.id)
      .map((item) => {
        const claim = claimByItem.get(item.id);
        const billNo = item.billId ? billNoById.get(item.billId) || "" : "";
        return {
          id: item.id,
          codeMasked: maskedDrawCode(item.codeEncrypted).codeMasked,
          matched: matchedCdkIds.has(item.issuedCdkId),
          amountCents: item.amountCents,
          cdkStatus: item.cdkStatus,
          manualUsed: Boolean(item.manualUsedAt),
          status: item.status,
          voidReason: item.voidReason,
          voidedByAgent: item.status === "void" && item.voidedByRole === "agent",
          settleRef: claim?.batchNo || billNo,
          settlePending: Boolean(claim) && !["paid", "cleared"].includes(claim?.batchStatus || ""),
        };
      }),
  }));
}
