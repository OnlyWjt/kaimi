import { and, desc, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentDrawBills, agentDrawItems, agentDrawOrders, agents, issuedCdks } from "@/db/schema";
import {
  DRAW_ITEM_LABEL,
  DRAW_MAX_SETTLE_ITEMS,
  beijingDateEndExclusiveIso,
  beijingDateStartIso,
  billRevertOpen,
  drawCodeUseLabel,
  drawPaymentMethodLabel,
  normalizeDrawPaymentMethod,
  toCsv,
} from "@/lib/agent-draw-core";
import { DrawError, maskedDrawCode, parseSummary } from "@/lib/agent-draw-shared";
import { publicShopName } from "@/lib/agent-names";
import { isFinishedRef } from "@/lib/finished-account-core";
import { normalizePage, normalizePageSize } from "@/lib/pagination-core";

// 提卡账单的只读查询和账本导出。结算、撤销账单会动额度，留在 agent-draw.ts。

export type DrawBillQuery = {
  agentId?: number;
  query?: string;
  paymentMethod?: string;
  status?: string;
  from?: string;
  to?: string;
};

function billQueryWhere(input: DrawBillQuery) {
  const query = (input.query || "").trim().replace(/[%_]/g, "");
  const status = input.status === "settled" || input.status === "reverted" ? input.status : "";
  const method = normalizeDrawPaymentMethod(input.paymentMethod || "");
  const fromIso = beijingDateStartIso(input.from || "");
  const toIso = beijingDateEndExclusiveIso(input.to || "");
  return and(
    input.agentId && input.agentId > 0 ? eq(agentDrawBills.agentId, input.agentId) : undefined,
    method ? eq(agentDrawBills.paymentMethod, method) : undefined,
    status ? eq(agentDrawBills.status, status) : undefined,
    fromIso ? gte(agentDrawBills.createdAt, fromIso) : undefined,
    toIso ? lt(agentDrawBills.createdAt, toIso) : undefined,
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

export async function listDrawBills(
  filter: DrawBillQuery | number = {},
  paging?: { page?: unknown; pageSize?: unknown },
) {
  const input: DrawBillQuery = typeof filter === "number" ? { agentId: filter } : filter;
  const where = billQueryWhere(input);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDrawBills)
    .innerJoin(agents, eq(agents.id, agentDrawBills.agentId))
    .where(where);
  const page = paging ? normalizePage(paging.page) : 1;
  const pageSize = paging ? normalizePageSize(paging.pageSize) : Math.max(1, Number(total) || 1);
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
    .where(where)
    .orderBy(desc(agentDrawBills.id))
    .limit(pageSize)
    .offset(paging ? (page - 1) * pageSize : 0);
  const list = rows.map((row) => ({
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
  return { list, total: Number(total) || 0, page, pageSize };
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
      manualUsedAt: agentDrawItems.manualUsedAt,
      codeEncrypted: issuedCdks.codeEncrypted,
      upstreamRef: issuedCdks.upstreamRef,
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
      manualUsedAt: item.manualUsedAt || "",
      codeMasked: maskedDrawCode(item.codeEncrypted).codeMasked,
      finished: isFinishedRef(item.upstreamRef),
    })),
  };
}

export async function listAgentBills(agentId: number) {
  const { list } = await listDrawBills(agentId);
  return list.map(({ notes: _notes, paymentReference: _ref, ...bill }) => bill);
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
      manualUsedAt: item.manualUsedAt || "",
      codeMasked: maskedDrawCode(item.codeEncrypted).codeMasked,
      finished: isFinishedRef(item.upstreamRef),
    })),
  };
}

export async function drawLedgerCsv(kind: "items" | "bills", agentId = 0, billQuery?: DrawBillQuery) {
  if (kind === "bills") {
    const { list: bills } = await listDrawBills({ ...billQuery, agentId: billQuery?.agentId || agentId });
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
      manualUsedAt: agentDrawItems.manualUsedAt,
      codeEncrypted: issuedCdks.codeEncrypted,
      upstreamRef: issuedCdks.upstreamRef,
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
      maskedDrawCode(row.codeEncrypted).codeMasked,
      drawCodeUseLabel(row.cdkStatus, Boolean(row.manualUsedAt), isFinishedRef(row.upstreamRef)),
      (row.amountCents / 100).toFixed(2),
      DRAW_ITEM_LABEL[row.status] || row.status,
      row.billId ? billNoById.get(row.billId) || "" : "",
    ]),
  );
}
