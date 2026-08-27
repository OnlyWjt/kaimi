import { eq, sql } from "drizzle-orm";
import { db, client } from "./index";
import { adminUsers, settings, storefronts } from "./schema";
import bcrypt from "bcryptjs";

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS storefronts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  site_name TEXT NOT NULL DEFAULT 'Kaimi',
  logo_url TEXT NOT NULL DEFAULT '',
  favicon_url TEXT NOT NULL DEFAULT '',
  theme_id TEXT NOT NULL DEFAULT 'aurora',
  accent TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  announcement TEXT NOT NULL DEFAULT '',
  contacts TEXT NOT NULL DEFAULT '',
  icp TEXT NOT NULL DEFAULT '',
  home_banner TEXT NOT NULL DEFAULT '',
  after_sales TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  description_html TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  upstream_plan TEXT NOT NULL,
  stock_visible INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  upstream_price_cents INTEGER NOT NULL DEFAULT 0,
  markup_cents INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cdk_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  order_id INTEGER,
  source TEXT NOT NULL DEFAULT 'sync',
  locked_at TEXT,
  sold_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cdk_pool_code_uq ON cdk_pool(code);
CREATE INDEX IF NOT EXISTS cdk_pool_status_plan_idx ON cdk_pool(status, plan_key);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  kind TEXT NOT NULL,
  product_id INTEGER,
  email TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  pay_status TEXT NOT NULL DEFAULT 'unpaid',
  fulfill_status TEXT NOT NULL DEFAULT 'pending',
  payment_channel TEXT NOT NULL DEFAULT 'manual',
  client_reference TEXT NOT NULL DEFAULT '',
  upstream_request_id TEXT,
  upstream_plan TEXT NOT NULL DEFAULT '',
  cred_mode TEXT,
  account_email TEXT,
  message TEXT NOT NULL DEFAULT '',
  delivered_codes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no_uq ON orders(order_no);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
CREATE INDEX IF NOT EXISTS orders_request_idx ON orders(upstream_request_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_id_uq ON webhook_events(event_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON order_status_history(order_id);

CREATE TABLE IF NOT EXISTS purchase_imports (
  order_no TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  expected_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  codes_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'poll',
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export async function ensureSchema() {
  await client.executeMultiple(DDL);

  const shop = await db.query.storefronts.findFirst({
    where: (t, { eq }) => eq(t.kind, "shop"),
  });
  if (!shop) {
    await db.insert(storefronts).values([
      {
        kind: "shop",
        siteName: "Kaimi 发卡网",
        themeId: "aurora",
        announcement: "欢迎选购，支付成功后自动发码。",
        afterSales: "售码商品不支持退款，请确认套餐后再下单。",
      },
      {
        kind: "recharge",
        siteName: "Kaimi 代充店",
        themeId: "snow",
        announcement: "提交 Session 后开始开通，进度可在订单页查看。",
        afterSales: "",
      },
    ]);
  } else {
    // Drop legacy mailbox copy from default recharge announcement
    const recharge = await db.query.storefronts.findFirst({
      where: (t, { eq }) => eq(t.kind, "recharge"),
    });
    if (recharge?.announcement?.includes("或邮箱")) {
      await db
        .update(storefronts)
        .set({
          announcement: "提交 Session 后开始开通，进度可在订单页查看。",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storefronts.kind, "recharge"));
    }
    if (
      recharge?.afterSales &&
      /webhook|轮询|unknown|店主/i.test(recharge.afterSales)
    ) {
      await db
        .update(storefronts)
        .set({
          afterSales: "",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storefronts.kind, "recharge"));
    }
  }

  const adminCount = await db
    .select({ c: sql<number>`count(*)` })
    .from(adminUsers)
    .then((rows) => Number(rows[0]?.c ?? 0));

  if (adminCount === 0) {
    const username = process.env.KAIMI_ADMIN_USER || "admin";
    const password = process.env.KAIMI_ADMIN_PASSWORD || "kaimi-change-me";
    await db.insert(adminUsers).values({
      username,
      passwordHash: await bcrypt.hash(password, 10),
    });
  }

  const setup = await db.query.settings.findFirst({
    where: (t, { eq }) => eq(t.key, "setup_completed"),
  });
  if (!setup) {
    await db.insert(settings).values({ key: "setup_completed", value: "0" });
  }

  const ensureSetting = async (key: string, value: string) => {
    const row = await db.query.settings.findFirst({
      where: (t, { eq }) => eq(t.key, key),
    });
    if (row) return;
    try {
      await db.insert(settings).values({ key, value });
    } catch (err) {
      // 并发 boot 可能同时插入同一 key
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|unique/i.test(msg)) throw err;
    }
  };
  await ensureSetting("site_theme", "snow");
  await ensureSetting("site_name", "Kaimi");
  await ensureSetting("sync_interval_minutes", "15");
  await ensureSetting("shop_enabled", "0");
  await ensureSetting("payment_mode", "manual");
  await ensureSetting("notify_webhook_url", "");
  await ensureSetting("telegram_bot_token", "");
  await ensureSetting("telegram_chat_id", "");

  // Older saves accidentally wrote storefront titles into site_name via 外观店面卡.
  const siteNameRow = await db.query.settings.findFirst({
    where: (t, { eq }) => eq(t.key, "site_name"),
  });
  if (
    siteNameRow &&
    (siteNameRow.value === "Kaimi 代充店" || siteNameRow.value === "Kaimi 发卡网")
  ) {
    await db
      .update(settings)
      .set({ value: "Kaimi", updatedAt: new Date().toISOString() })
      .where(eq(settings.key, "site_name"));
  }
}
