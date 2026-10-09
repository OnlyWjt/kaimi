import { and, desc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, cdkPool, issuedCdks, orders, storeOrders, users } from "@/db/schema";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { decryptSecret, hashLookupValue, maskCode } from "@/lib/crypto";
import { FINISHED_GPT_PLAN_KEY } from "@/lib/finished-account-core";

export type AdminOrderListRow = {
  id: number;
  rowKind: "store" | "redeem";
  orderNo: string;
  kind: string;
  email: string;
  codeMasked: string;
  upstreamPlan: string;
  payStatus: string;
  fulfillStatus: string;
  productKind: "finished" | "cdk" | "redeem";
  createdAt: string;
  agentLabel: string;
  message: string;
  upstreamRequestId: string;
  storeOrderNo: string;
};

function cursorOf(row: { createdAt: string; rowKind: string; id: number }) {
  return `${row.createdAt}|${row.rowKind}|${row.id}`;
}

function parseCursor(raw: string) {
  const [at, kind, idRaw] = raw.split("|");
  const id = Number(idRaw);
  if (!at || (kind !== "store" && kind !== "redeem") || !Number.isSafeInteger(id)) return null;
  return { at, kind, id };
}

function isOlder(
  row: { createdAt: string; rowKind: string; id: number },
  cursor: { at: string; kind: string; id: number },
) {
  if (row.createdAt !== cursor.at) return row.createdAt < cursor.at;
  if (row.rowKind !== cursor.kind) return row.rowKind < cursor.kind;
  return row.id < cursor.id;
}

const PAGE_SIZE = 50;
const CSV_LIMIT = 5000;

export async function queryAdminOrders(searchParams: URLSearchParams) {
  const status = searchParams.get("status") || "";
  const q = searchParams.get("q")?.trim() || "";
  const includeHidden = searchParams.get("include_hidden") === "1";
  const cursor = parseCursor(searchParams.get("cursor") || "");
  const csv = searchParams.get("export") === "csv";
  const limit = csv ? CSV_LIMIT : PAGE_SIZE;
  const [storeRows, redeemRows] = await Promise.all([
    loadStoreOrderRows({ status, q, cursor, limit }),
    loadRedeemRows({ status, q, includeHidden, cursor, limit }),
  ]);
  const merged = [...storeRows, ...redeemRows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.rowKind !== b.rowKind) return a.rowKind < b.rowKind ? 1 : -1;
    return b.id - a.id;
  });
  const visible = cursor ? merged.filter((row) => isOlder(row, cursor)) : merged;
  const hasMore = !csv && visible.length > PAGE_SIZE;
  const page = visible.slice(0, limit);
  const last = page[page.length - 1];
  return {
    list: page,
    page: {
      next_cursor: hasMore && last ? cursorOf(last) : null,
      has_more: hasMore,
    },
  };
}

function olderThan(
  createdAt: unknown,
  id: unknown,
  kind: "store" | "redeem",
  cursor: { at: string; kind: string; id: number } | null,
) {
  if (!cursor) return undefined;
  const sameKindId = cursor.kind === kind ? cursor.id : Number.MAX_SAFE_INTEGER;
  return or(sql`${createdAt} < ${cursor.at}`, and(sql`${createdAt} = ${cursor.at}`, lt(id as never, sameKindId)));
}

async function loadStoreOrderRows(input: {
  status: string;
  q: string;
  cursor: { at: string; kind: string; id: number } | null;
  limit: number;
}): Promise<AdminOrderListRow[]> {
  const conditions = [];
  const older = olderThan(storeOrders.createdAt, storeOrders.id, "store", input.cursor);
  if (older) conditions.push(older);
  if (input.status) {
    const statusMatch = or(eq(storeOrders.fulfillStatus, input.status), eq(storeOrders.payStatus, input.status));
    if (statusMatch) conditions.push(statusMatch);
  }
  if (input.q) {
    const pattern = `%${input.q.replace(/[%_]/g, "")}%`;
    const textMatch = or(
      like(storeOrders.orderNo, pattern),
      like(storeOrders.customerEmail, pattern),
      like(storeOrders.productNameSnapshot, pattern),
      like(agents.displayName, pattern),
    );
    if (textMatch) conditions.push(textMatch);
  }
  const rows = await db
    .select({
      id: storeOrders.id,
      orderNo: storeOrders.orderNo,
      planKey: storeOrders.planKeySnapshot,
      productName: storeOrders.productNameSnapshot,
      email: storeOrders.customerEmail,
      payStatus: storeOrders.payStatus,
      fulfillStatus: storeOrders.fulfillStatus,
      message: storeOrders.lastErrorMessage,
      createdAt: storeOrders.createdAt,
      agentName: agents.displayName,
      shopName: agents.shopName,
      realName: agents.realName,
      settlementName: agents.settlementName,
      username: users.username,
    })
    .from(storeOrders)
    .innerJoin(agents, eq(agents.id, storeOrders.agentId))
    .leftJoin(users, eq(users.agentId, agents.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(storeOrders.createdAt), desc(storeOrders.id))
    .limit(input.limit);
  const ids = rows.map((row) => row.id);
  const issued = ids.length
    ? await db
        .select({
          orderId: issuedCdks.orderId,
          codePrefix: issuedCdks.codePrefix,
          planKey: issuedCdks.planKey,
        })
        .from(issuedCdks)
        .where(inArray(issuedCdks.orderId, ids))
    : [];
  const preview = new Map<number, string>();
  for (const row of issued) {
    if (!preview.has(row.orderId)) preview.set(row.orderId, row.codePrefix || "");
  }
  return rows.map((row) => {
    const finished = row.planKey === FINISHED_GPT_PLAN_KEY;
    return {
      id: row.id,
      rowKind: "store" as const,
      orderNo: row.orderNo,
      kind: finished ? "finished" : "cdk",
      email: row.email,
      codeMasked: preview.get(row.id) || "",
      upstreamPlan: row.productName,
      payStatus: row.payStatus,
      fulfillStatus: row.fulfillStatus,
      productKind: finished ? "finished" as const : "cdk" as const,
      createdAt: row.createdAt,
      agentLabel: agentIdentityLabel(row),
      message: row.message || "",
      upstreamRequestId: "",
      storeOrderNo: "",
    };
  });
}

async function loadRedeemRows(input: {
  status: string;
  q: string;
  includeHidden: boolean;
  cursor: { at: string; kind: string; id: number } | null;
  limit: number;
}): Promise<AdminOrderListRow[]> {
  const conditions = [isNull(orders.storeOrderId)];
  if (!input.includeHidden) conditions.push(eq(orders.hidden, false));
  const older = olderThan(orders.createdAt, orders.id, "redeem", input.cursor);
  if (older) conditions.push(older);
  if (input.status) {
    const statusMatch = or(eq(orders.fulfillStatus, input.status), eq(orders.payStatus, input.status));
    if (statusMatch) conditions.push(statusMatch);
  }
  if (input.q) {
    const pattern = `%${input.q.replace(/[%_]/g, "")}%`;
    const parts = [
      like(orders.orderNo, pattern),
      like(orders.email, pattern),
      like(orders.accountEmail, pattern),
      like(orders.upstreamRequestId, pattern),
      like(orders.codeLast4, pattern),
    ];
    if (input.q.length >= 8) {
      parts.push(
        sql`${orders.issuedCdkId} IN (SELECT id FROM issued_cdks WHERE code_hash = ${hashLookupValue(input.q.toUpperCase())})`,
      );
    }
    const textMatch = or(...parts);
    if (textMatch) conditions.push(textMatch);
  }
  const list = await db.query.orders.findMany({
    where: and(...conditions),
    orderBy: [desc(orders.createdAt), desc(orders.id)],
    limit: input.limit,
  });
  const decorated = await decorateAdminOrders(list);
  return decorated.map((row) => ({
    id: row.id,
    rowKind: "redeem" as const,
    orderNo: row.orderNo,
    kind: row.kind,
    email: row.email || row.accountEmail || "",
    codeMasked: row.codeMasked,
    upstreamPlan: row.upstreamPlan || "",
    payStatus: row.payStatus,
    fulfillStatus: row.fulfillStatus,
    productKind: "redeem" as const,
    createdAt: row.createdAt,
    agentLabel: row.agentLabel,
    message: row.message || "",
    upstreamRequestId: row.upstreamRequestId || "",
    storeOrderNo: row.storeOrderNo,
  }));
}

async function decorateAdminOrders(list: Array<typeof orders.$inferSelect>) {
  const issuedIds = list.map((row) => row.issuedCdkId).filter((id): id is number => !!id);
  const storeIds = list.map((row) => row.storeOrderId).filter((id): id is number => !!id);
  const agentIds = list.map((row) => row.agentId).filter((id): id is number => !!id);
  const issuedRows = issuedIds.length
    ? await db.select().from(issuedCdks).where(inArray(issuedCdks.id, issuedIds))
    : [];
  const storeRows = storeIds.length
    ? await db
        .select({ id: storeOrders.id, orderNo: storeOrders.orderNo })
        .from(storeOrders)
        .where(inArray(storeOrders.id, storeIds))
    : [];
  const agentRows = agentIds.length
    ? await db
        .select({
          id: agents.id,
          displayName: agents.displayName,
          shopName: agents.shopName,
          realName: agents.realName,
          settlementName: agents.settlementName,
          username: users.username,
        })
        .from(agents)
        .leftJoin(users, eq(users.agentId, agents.id))
        .where(inArray(agents.id, agentIds))
    : [];
  const poolRows = list.length
    ? await db
        .select({ orderId: cdkPool.orderId, code: cdkPool.code })
        .from(cdkPool)
        .where(inArray(cdkPool.orderId, list.map((row) => row.id)))
    : [];
  const codeByIssued = new Map<number, string>();
  for (const row of issuedRows) {
    try {
      codeByIssued.set(row.id, decryptSecret(row.codeEncrypted));
    } catch {
      codeByIssued.set(row.id, "");
    }
  }
  const poolByOrder = new Map<number, string>();
  for (const row of poolRows) {
    if (row.orderId) poolByOrder.set(row.orderId, row.code);
  }
  const storeNo = new Map(storeRows.map((row) => [row.id, row.orderNo]));
  const agentLabel = new Map(agentRows.map((row) => [row.id, agentIdentityLabel(row)]));
  return list.map((row) => {
    const raw = (row.issuedCdkId ? codeByIssued.get(row.issuedCdkId) : "") || poolByOrder.get(row.id) || "";
    return {
      ...row,
      codeMasked: raw ? maskCode(raw) : row.codeLast4 ? `****${row.codeLast4}` : "",
      codeLast4: raw ? raw.slice(-4) : row.codeLast4,
      storeOrderNo: row.storeOrderId ? storeNo.get(row.storeOrderId) || "" : "",
      agentLabel: row.agentId ? agentLabel.get(row.agentId) || "" : "",
    };
  });
}

export function adminOrdersCsv(list: AdminOrderListRow[]) {
  const header = [
    "order_no",
    "kind",
    "email",
    "plan",
    "pay_status",
    "fulfill_status",
    "store_order_no",
    "agent",
    "source",
    "request_id",
    "message",
    "created_at",
  ];
  const lines = [
    header.join(","),
    ...list.map((row) =>
      [
        row.orderNo,
        row.kind,
        row.email,
        row.upstreamPlan,
        row.payStatus,
        row.fulfillStatus,
        row.storeOrderNo,
        row.agentLabel,
        row.rowKind,
        row.upstreamRequestId || "",
        (row.message || "").replace(/"/g, '""'),
        row.createdAt,
      ]
        .map((value) => `"${String(value ?? "")}"`)
        .join(","),
    ),
  ];
  return lines.join("\n");
}
