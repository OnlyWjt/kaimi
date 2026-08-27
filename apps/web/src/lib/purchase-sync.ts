import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cdkPool, purchaseImports } from "@/db/schema";
import { bootDb, getAppConfig, getSetting, setSetting } from "@/lib/config";
import { findCdkByCode, normalizeCdkCode } from "@/lib/inventory";
import { getUpstreamClient } from "@/lib/upstream";

const LAST_KEY = "purchase_import_last";
const WATCH_KEY = "purchase_watch_orders";
const BACKFILL_KEY = "purchase_orders_backfilled";
const IMPORTABLE = new Set(["delivered", "paid_undelivered"]);
const DROP_WATCH = new Set(["expired", "cancelled", "delivered"]);
const PAGE_SIZE = 50;
const MAX_BACKFILL_PAGES = 100;
const MISSING_CODES_RETRY_MS = 10 * 60_000;
const FULL_RESCAN_INTERVAL_MS = 15 * 60_000;

export type PurchaseOrder = {
  order_no: string;
  plan: string;
  count: number;
  status: string;
  issued_codes: string[];
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function issuedCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => String(c || "").trim()).filter(Boolean);
}

export function asPurchaseOrder(raw: unknown): PurchaseOrder | null {
  const root = asRecord(raw);
  const nested = asRecord(root.order);
  const o = Object.keys(nested).length ? { ...nested, ...root } : root;
  const order_no = String(o.order_no || o.orderNo || "").trim();
  if (!order_no) return null;
  return {
    order_no,
    plan: String(o.plan || ""),
    count: Math.max(0, Math.floor(Number(o.count) || 0)),
    status: String(o.status || ""),
    issued_codes: issuedCodes(o.issued_codes ?? o.issuedCodes),
  };
}

function parseWatch(raw: string) {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export async function watchPurchaseOrder(orderNo: string) {
  await bootDb();
  const no = orderNo.trim();
  if (!no) return;
  const list = parseWatch(await getSetting(WATCH_KEY, ""));
  if (list.includes(no)) return;
  list.push(no);
  await setSetting(WATCH_KEY, list.join(","));
}

async function unwatchPurchaseOrder(orderNo: string) {
  const list = parseWatch(await getSetting(WATCH_KEY, "")).filter((n) => n !== orderNo);
  await setSetting(WATCH_KEY, list.join(","));
}

async function importUnusedCodes(items: Array<{ code: string; plan: string }>) {
  let imported = 0;
  let restored = 0;
  const now = new Date().toISOString();

  for (const item of items) {
    const code = normalizeCdkCode(item.code);
    if (!code) continue;
    const existing = await findCdkByCode(code);
    if (existing) {
      if (existing.status === "disabled") {
        await db
          .update(cdkPool)
          .set({
            code,
            status: "unused",
            planKey: item.plan || existing.planKey,
            source: "purchase",
            orderId: null,
            lockedAt: null,
            updatedAt: now,
          })
          .where(eq(cdkPool.id, existing.id));
        restored += 1;
      }
      continue;
    }
    const inserted = await db
      .insert(cdkPool)
      .values({
        code,
        planKey: item.plan || "unknown",
        status: "unused",
        source: "purchase",
      })
      .onConflictDoNothing({ target: cdkPool.code })
      .returning({ id: cdkPool.id });
    if (inserted.length > 0) imported += 1;
  }

  return { imported, restored };
}

function isWholeDelivery(order: PurchaseOrder, expectedCount: number) {
  return (
    order.status === "delivered" &&
    expectedCount > 0 &&
    order.issued_codes.length >= expectedCount
  );
}

/**
 * 按 order_no 入库。已整单入库则跳过；未齐的单只补新码。
 */
export async function importPurchaseOrder(
  raw: unknown,
  source: "poll" | "webhook" | "watch",
) {
  await bootDb();
  const order = asPurchaseOrder(raw);
  if (!order || !IMPORTABLE.has(order.status)) {
    return { skipped: true as const, reason: "not_importable" };
  }

  const existing = await db.query.purchaseImports.findFirst({
    where: eq(purchaseImports.orderNo, order.order_no),
  });
  if (existing?.complete) {
    await unwatchPurchaseOrder(order.order_no);
    return { skipped: true as const, reason: "already_imported", orderNo: order.order_no };
  }
  if (order.issued_codes.length === 0) {
    if (order.status === "delivered") {
      const now = new Date().toISOString();
      if (!existing) {
        await db
          .insert(purchaseImports)
          .values({
            orderNo: order.order_no,
            plan: order.plan,
            status: order.status,
            expectedCount: order.count,
            importedCount: 0,
            complete: false,
            codesJson: "[]",
            source,
            importedAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: purchaseImports.orderNo });
      } else {
        const firstSeenMs = Date.parse(existing.importedAt);
        if (
          Number.isFinite(firstSeenMs) &&
          Date.now() - firstSeenMs >= MISSING_CODES_RETRY_MS
        ) {
          await unwatchPurchaseOrder(order.order_no);
        }
      }
    }
    return { skipped: true as const, reason: "no_codes", orderNo: order.order_no };
  }

  const result = await importUnusedCodes(
    order.issued_codes.map((code) => ({ code, plan: order.plan })),
  );
  const expectedCount = order.count > 0 ? order.count : existing?.expectedCount || 0;
  const complete = isWholeDelivery(order, expectedCount);
  const now = new Date().toISOString();
  const row = {
    plan: order.plan,
    status: order.status,
    expectedCount,
    importedCount: order.issued_codes.length,
    complete,
    codesJson: JSON.stringify(order.issued_codes.map((c) => normalizeCdkCode(c))),
    source,
    updatedAt: now,
  };

  await db
    .insert(purchaseImports)
    .values({
      orderNo: order.order_no,
      ...row,
      importedAt: existing?.importedAt || now,
    })
    .onConflictDoUpdate({
      target: purchaseImports.orderNo,
      set: row,
    });

  if (complete || DROP_WATCH.has(order.status)) {
    await unwatchPurchaseOrder(order.order_no);
  }

  await setSetting(
    LAST_KEY,
    JSON.stringify({
      at: now,
      imported: result.imported,
      restored: result.restored,
      orders: [order.order_no],
      source,
    }),
  );

  return {
    ok: true as const,
    orderNo: order.order_no,
    imported: result.imported,
    restored: result.restored,
    complete,
  };
}

async function hydrateOrder(raw: unknown) {
  let order = asPurchaseOrder(raw);
  if (!order) return null;
  if (
    IMPORTABLE.has(order.status) &&
    (order.issued_codes.length === 0 || order.count <= 0)
  ) {
    const missing = await db.query.purchaseImports.findFirst({
      where: eq(purchaseImports.orderNo, order.order_no),
    });
    const firstSeenMs = missing ? Date.parse(missing.importedAt) : Number.NaN;
    if (
      missing?.status === "delivered" &&
      missing.importedCount === 0 &&
      Number.isFinite(firstSeenMs) &&
      Date.now() - firstSeenMs >= MISSING_CODES_RETRY_MS
    ) {
      return order;
    }
    try {
      const upstream = await getUpstreamClient();
      order = asPurchaseOrder(await upstream.getOrder(order.order_no)) ?? order;
    } catch (err) {
      console.warn("[kaimi-purchase] hydrate failed", order.order_no, err);
    }
  }
  return order;
}

async function listByStatus(status: string, maxPages: number) {
  const upstream = await getUpstreamClient();
  const out: PurchaseOrder[] = [];
  let complete = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await upstream.listOrders({ status, page, page_size: PAGE_SIZE });
    const list = res.list || [];
    if (list.length === 0) {
      complete = true;
      break;
    }
    for (const raw of list) {
      const order = asPurchaseOrder(raw);
      if (!order) continue;
      out.push(order);
    }
    const total = Number(res.total || 0);
    if (list.length < PAGE_SIZE || (total > 0 && page * PAGE_SIZE >= total)) {
      complete = true;
      break;
    }
    if (page === maxPages && maxPages > 1) {
      console.warn(`[kaimi-purchase] ${status} backfill capped at ${maxPages} pages`);
    }
  }
  return { orders: out, complete };
}

/**
 * 主路径未上回调前的兜底：扫 delivered，并收 paid_undelivered 未齐部分。
 * 下单后还会盯着这一单，查到 delivered / paid_undelivered 再入库。
 */
export async function pollPurchasesAndImport() {
  await bootDb();
  const cfg = await getAppConfig();
  if (!cfg.upstreamBaseUrl || !cfg.upstreamApiKey) {
    return { skipped: true as const, reason: "upstream_not_configured" };
  }

  const upstream = await getUpstreamClient();
  const candidates: Array<{ order: PurchaseOrder; source: "poll" | "watch" }> = [];
  const seen = new Set<string>();
  const backfillDone = (await getSetting(BACKFILL_KEY, "0")) === "1";
  const backfillAt = Date.parse(await getSetting(`${BACKFILL_KEY}_at`, ""));
  const fullRescan =
    !backfillDone ||
    !Number.isFinite(backfillAt) ||
    Date.now() - backfillAt >= FULL_RESCAN_INTERVAL_MS;
  let backfillComplete = true;

  const push = (order: PurchaseOrder | null, source: "poll" | "watch") => {
    if (!order || seen.has(order.order_no)) return;
    seen.add(order.order_no);
    candidates.push({ order, source });
  };

  for (const status of ["delivered", "paid_undelivered"] as const) {
    try {
      const listed = await listByStatus(status, fullRescan ? MAX_BACKFILL_PAGES : 1);
      for (const order of listed.orders) push(order, "poll");
      if (fullRescan && !listed.complete) backfillComplete = false;
    } catch (err) {
      backfillComplete = false;
      console.warn("[kaimi-purchase] list", status, "failed", err);
    }
  }
  if (fullRescan && backfillComplete) {
    await setSetting(BACKFILL_KEY, "1");
    await setSetting(`${BACKFILL_KEY}_at`, new Date().toISOString());
  }

  for (const no of parseWatch(await getSetting(WATCH_KEY, ""))) {
    try {
      const fresh = asPurchaseOrder(await upstream.getOrder(no));
      if (!fresh) continue;
      if (DROP_WATCH.has(fresh.status) && !IMPORTABLE.has(fresh.status)) {
        await unwatchPurchaseOrder(no);
        continue;
      }
      push(fresh, "watch");
    } catch (err) {
      console.warn("[kaimi-purchase] watch getOrder failed", no, err);
    }
  }

  let imported = 0;
  let restored = 0;
  let orders = 0;
  const importedOrderNos: string[] = [];
  for (const candidate of candidates) {
    const order = await hydrateOrder(candidate.order);
    const result = await importPurchaseOrder(order, candidate.source);
    if ("ok" in result && result.ok) {
      imported += result.imported;
      restored += result.restored;
      orders += 1;
      importedOrderNos.push(result.orderNo);
    }
  }

  if (orders === 0) {
    return { skipped: true as const, reason: "no_new_delivery", checked: candidates.length };
  }

  await setSetting(
    LAST_KEY,
    JSON.stringify({
      at: new Date().toISOString(),
      imported,
      restored,
      orders: importedOrderNos,
      source: "poll",
    }),
  );
  console.log(`[kaimi-purchase] imported=${imported} restored=${restored} orders=${orders}`);
  return { ok: true as const, imported, restored, orders };
}

/** 主站补齐 order.delivered / order.fulfill_failed 后走这条。拉单兜底保留。 */
export async function importPurchaseFromWebhook(eventType: string, data: Record<string, unknown>) {
  const nested = asRecord(data.order);
  const base = Object.keys(nested).length ? { ...nested, ...data } : data;
  const mapped = {
    ...base,
    status:
      String(base.status || "") ||
      (eventType === "order.fulfill_failed" ? "paid_undelivered" : "") ||
      (eventType === "order.delivered" ? "delivered" : ""),
  };
  const hydrated = await hydrateOrder(mapped);
  if (!hydrated) {
    throw new Error("购卡回调缺少 order_no");
  }
  const result = await importPurchaseOrder(hydrated, "webhook");
  if (
    eventType === "order.delivered" &&
    (("skipped" in result && result.skipped && result.reason !== "already_imported") ||
      ("ok" in result && result.ok && !result.complete))
  ) {
    const reason = "reason" in result ? result.reason : "delivery_incomplete";
    throw new Error(`已发货订单暂不可完整入库：${reason}`);
  }
  return result;
}

export async function getPurchaseImportLast() {
  const raw = await getSetting(LAST_KEY, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      at?: string;
      imported?: number;
      restored?: number;
      orders?: string[];
      source?: string;
    };
  } catch {
    return null;
  }
}
