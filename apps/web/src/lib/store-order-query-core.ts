const PAY_STATUSES = [
  "unpaid",
  "pending_pay",
  "paid",
  "refunded",
  "refunding",
  "chargeback",
] as const;

const FULFILL_STATUSES = [
  "pending",
  "issuing",
  "delivered",
  "partially_delivered",
  "paid_undelivered",
  "failed",
  "unknown",
] as const;

export type StoreOrderPayStatus = (typeof PAY_STATUSES)[number];
export type StoreOrderFulfillStatus = (typeof FULFILL_STATUSES)[number];

export type StoreOrderQuery = {
  q: string;
  agentId: number | null;
  payStatus: StoreOrderPayStatus | "";
  fulfillStatus: StoreOrderFulfillStatus | "";
};

export const STORE_ORDER_PAY_FILTERS = PAY_STATUSES;
export const STORE_ORDER_FULFILL_FILTERS = FULFILL_STATUSES;

/** 关键字里的 % _ 会变成 LIKE 通配符，直接剥掉，免得一张查询扫全表。 */
export function normalizeStoreOrderKeyword(value: string) {
  return value.trim().replace(/[%_]/g, "").slice(0, 64);
}

function parseAgentId(value: string) {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function pickAllowed<T extends string>(value: string, allowed: readonly T[]): T | "" {
  const key = value.trim();
  return (allowed as readonly string[]).includes(key) ? (key as T) : "";
}

/** 后台即时发卡列表的查询条件。不认的状态当没选，别让任意字符串进 SQL。 */
export function parseStoreOrderQuery(input: {
  q?: string | null;
  agentId?: string | null;
  payStatus?: string | null;
  fulfillStatus?: string | null;
}): StoreOrderQuery {
  return {
    q: normalizeStoreOrderKeyword(String(input.q || "")),
    agentId: parseAgentId(String(input.agentId || "")),
    payStatus: pickAllowed(String(input.payStatus || ""), PAY_STATUSES),
    fulfillStatus: pickAllowed(String(input.fulfillStatus || ""), FULFILL_STATUSES),
  };
}

export function storeOrderQueryIsEmpty(query: StoreOrderQuery) {
  return !query.q && query.agentId == null && !query.payStatus && !query.fulfillStatus;
}
