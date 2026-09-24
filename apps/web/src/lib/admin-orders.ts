import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, cdkPool, issuedCdks, orders, storeOrders, users } from "@/db/schema";
import { agentIdentityLabel } from "@/lib/agent-identity-core";
import { decryptSecret, hashLookupValue, maskCode } from "@/lib/crypto";

const PAGE_SIZE = 50;
const CSV_LIMIT = 5000;

export async function queryAdminOrders(searchParams: URLSearchParams) {
  const status = searchParams.get("status") || "";
  const q = searchParams.get("q")?.trim() || "";
  const includeHidden = searchParams.get("include_hidden") === "1";
  const cursor = Number(searchParams.get("cursor") || 0);
  const csv = searchParams.get("export") === "csv";
  const limit = csv ? CSV_LIMIT : PAGE_SIZE;
  const conditions = [];
  if (!includeHidden) conditions.push(eq(orders.hidden, false));
  if (!csv && Number.isSafeInteger(cursor) && cursor > 0) conditions.push(lt(orders.id, cursor));
  if (status) {
    const statusMatch = or(eq(orders.fulfillStatus, status), eq(orders.payStatus, status));
    if (statusMatch) conditions.push(statusMatch);
  }
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, "")}%`;
    const parts = [
      like(orders.orderNo, pattern),
      like(orders.email, pattern),
      like(orders.accountEmail, pattern),
      like(orders.upstreamRequestId, pattern),
      like(orders.codeLast4, pattern),
      sql`${orders.storeOrderId} IN (SELECT id FROM store_orders WHERE order_no LIKE ${pattern})`,
    ];
    if (q.length >= 8) {
      parts.push(
        sql`${orders.issuedCdkId} IN (SELECT id FROM issued_cdks WHERE code_hash = ${hashLookupValue(q.toUpperCase())})`,
      );
    }
    const textMatch = or(...parts);
    if (textMatch) conditions.push(textMatch);
  }
  const list = await db.query.orders.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    orderBy: [desc(orders.id)],
    limit: limit + (csv ? 0 : 1),
  });
  const hasMore = !csv && list.length > PAGE_SIZE;
  const page = hasMore ? list.slice(0, PAGE_SIZE) : list;
  const rows = await decorateAdminOrders(page);
  const last = rows[rows.length - 1];
  return {
    list: rows,
    page: {
      next_cursor: hasMore && last ? String(last.id) : null,
      has_more: hasMore,
    },
  };
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

export function adminOrdersCsv(list: Awaited<ReturnType<typeof decorateAdminOrders>>) {
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
        row.source,
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
