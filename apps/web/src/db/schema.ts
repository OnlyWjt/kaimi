import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull().default(""),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const adminUsers = sqliteTable("admin_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const storefronts = sqliteTable("storefronts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(), // shop | recharge
  siteName: text("site_name").notNull().default("Kaimi"),
  logoUrl: text("logo_url").notNull().default(""),
  faviconUrl: text("favicon_url").notNull().default(""),
  themeId: text("theme_id").notNull().default("aurora"),
  accent: text("accent").notNull().default(""),
  domain: text("domain").notNull().default(""),
  announcement: text("announcement").notNull().default(""),
  contacts: text("contacts").notNull().default(""),
  icp: text("icp").notNull().default(""),
  homeBanner: text("home_banner").notNull().default(""),
  afterSales: text("after_sales").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(), // code | recharge
  title: text("title").notNull(),
  coverUrl: text("cover_url").notNull().default(""),
  descriptionHtml: text("description_html").notNull().default(""),
  priceCents: integer("price_cents").notNull().default(0),
  currency: text("currency").notNull().default("CNY"),
  upstreamPlan: text("upstream_plan").notNull(),
  stockVisible: integer("stock_visible", { mode: "boolean" }).notNull().default(true),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const plansCache = sqliteTable("plans_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planKey: text("plan_key").notNull().unique(),
  name: text("name").notNull().default(""),
  upstreamPriceCents: integer("upstream_price_cents").notNull().default(0),
  markupCents: integer("markup_cents").notNull().default(0),
  rawJson: text("raw_json").notNull().default("{}"),
  syncedAt: text("synced_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const cdkPool = sqliteTable(
  "cdk_pool",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    planKey: text("plan_key").notNull(),
    status: text("status").notNull().default("unused"), // unused | locked | sold | used | disabled
    orderId: integer("order_id"),
    source: text("source").notNull().default("sync"), // sync | manual
    lockedAt: text("locked_at"),
    soldAt: text("sold_at"),
    usedAt: text("used_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    codeIdx: uniqueIndex("cdk_pool_code_uq").on(t.code),
    statusPlanIdx: index("cdk_pool_status_plan_idx").on(t.status, t.planKey),
  }),
);

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderNo: text("order_no").notNull(),
    kind: text("kind").notNull(), // code | recharge
    productId: integer("product_id"),
    email: text("email").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull().default("CNY"),
    payStatus: text("pay_status").notNull().default("unpaid"), // unpaid | paid | cancelled | manual
    fulfillStatus: text("fulfill_status").notNull().default("pending"), // pending | fulfilled | processing | success | failed | skipped | unknown
    paymentChannel: text("payment_channel").notNull().default("manual"), // manual | epay
    clientReference: text("client_reference").notNull().default(""),
    upstreamRequestId: text("upstream_request_id"),
    upstreamPlan: text("upstream_plan").notNull().default(""),
    credMode: text("cred_mode"),
    accountEmail: text("account_email"),
    message: text("message").notNull().default(""),
    deliveredCodesJson: text("delivered_codes_json").notNull().default("[]"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    paidAt: text("paid_at"),
  },
  (t) => ({
    orderNoIdx: uniqueIndex("orders_order_no_uq").on(t.orderNo),
    emailIdx: index("orders_email_idx").on(t.email),
    requestIdx: index("orders_request_idx").on(t.upstreamRequestId),
  }),
);

export const orderStatusHistory = sqliteTable(
  "order_status_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    status: text("status").notNull(),
    message: text("message").notNull().default(""),
    source: text("source").notNull().default("system"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    orderIdx: index("order_status_history_order_idx").on(t.orderId),
  }),
);

export const purchaseImports = sqliteTable("purchase_imports", {
  orderNo: text("order_no").primaryKey(),
  plan: text("plan").notNull().default(""),
  status: text("status").notNull().default(""),
  expectedCount: integer("expected_count").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  complete: integer("complete", { mode: "boolean" }).notNull().default(false),
  codesJson: text("codes_json").notNull().default("[]"),
  source: text("source").notNull().default("poll"),
  importedAt: text("imported_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull().default(""),
    payloadJson: text("payload_json").notNull().default("{}"),
    processedAt: text("processed_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    eventIdx: uniqueIndex("webhook_events_event_id_uq").on(t.eventId),
  }),
);
