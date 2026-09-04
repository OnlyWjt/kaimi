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

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(), // super_admin | agent
    status: text("status").notNull().default("active"), // active | disabled
    agentId: integer("agent_id"),
    lastLoginAt: text("last_login_at"),
    passwordChangedAt: text("password_changed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    usernameIdx: uniqueIndex("users_username_uq").on(t.username),
    agentIdx: uniqueIndex("users_agent_id_uq").on(t.agentId),
  }),
);

export const agents = sqliteTable(
  "agents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"), // active | disabled
    currentSlug: text("current_slug").notNull(),
    themeId: text("theme_id").notNull().default("snow"),
    settlementName: text("settlement_name").notNull().default(""),
    settlementMethod: text("settlement_method").notNull().default(""),
    settlementAccountEncrypted: text("settlement_account_encrypted").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    slugIdx: uniqueIndex("agents_current_slug_uq").on(t.currentSlug),
    statusIdx: index("agents_status_idx").on(t.status),
  }),
);

export const agentSlugHistory = sqliteTable(
  "agent_slug_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: integer("agent_id").notNull(),
    slug: text("slug").notNull(),
    replacedAt: text("replaced_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    slugIdx: uniqueIndex("agent_slug_history_slug_uq").on(t.slug),
    agentIdx: index("agent_slug_history_agent_idx").on(t.agentId),
  }),
);

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

export const platformPlans = sqliteTable(
  "platform_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planKey: text("plan_key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    coverUrl: text("cover_url").notNull().default(""),
    globalCostPriceCents: integer("global_cost_price_cents").notNull().default(0),
    currency: text("currency").notNull().default("CNY"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    cardplatformSellable: integer("cardplatform_sellable", { mode: "boolean" })
      .notNull()
      .default(false),
    cardplatformRawJson: text("cardplatform_raw_json").notNull().default("{}"),
    syncedAt: text("synced_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    planKeyIdx: uniqueIndex("platform_plans_plan_key_uq").on(t.planKey),
    enabledSortIdx: index("platform_plans_enabled_sort_idx").on(t.enabled, t.sortOrder),
  }),
);

export const agentPlanPrices = sqliteTable(
  "agent_plan_prices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: integer("agent_id").notNull(),
    planId: integer("plan_id").notNull(),
    costOverrideCents: integer("cost_override_cents"),
    retailPriceCents: integer("retail_price_cents").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    agentPlanIdx: uniqueIndex("agent_plan_prices_agent_plan_uq").on(
      t.agentId,
      t.planId,
    ),
    agentEnabledIdx: index("agent_plan_prices_agent_enabled_idx").on(
      t.agentId,
      t.enabled,
    ),
  }),
);

export const paymentChannelConfigs = sqliteTable(
  "payment_channel_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channel: text("channel").notNull(), // alipay | wxpay
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    feeRatePpm: integer("fee_rate_ppm").notNull().default(0),
    fixedFeeCents: integer("fixed_fee_cents").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    channelIdx: uniqueIndex("payment_channel_configs_channel_uq").on(t.channel),
  }),
);

export const cardplatformAccounts = sqliteTable(
  "cardplatform_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    protocol: text("protocol").notNull().default("legacy"),
    siteBase: text("site_base").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull().default(""),
    webhookSecretEncrypted: text("webhook_secret_encrypted").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    priority: integer("priority").notNull().default(100),
    webhookPath: text("webhook_path").notNull().default(""),
    lastHealthAt: text("last_health_at"),
    lastError: text("last_error").notNull().default(""),
    lastOkAt: text("last_ok_at"),
    lastErrorAt: text("last_error_at"),
    lastPlansSyncAt: text("last_plans_sync_at"),
    lastProductsSyncAt: text("last_products_sync_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    enabledDefaultIdx: index("cardplatform_accounts_enabled_default_idx").on(
      t.enabled,
      t.isDefault,
    ),
  }),
);

export const storeOrders = sqliteTable(
  "store_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderNo: text("order_no").notNull(),
    queryTokenHash: text("query_token_hash").notNull(),
    queryTokenEncrypted: text("query_token_encrypted").notNull().default(""),
    agentId: integer("agent_id").notNull(),
    planId: integer("plan_id").notNull(),
    planKeySnapshot: text("plan_key_snapshot").notNull(),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    /** 买几张。历史订单一律 1。 */
    quantity: integer("quantity").notNull().default(1),
    /** 单价（每张），只用来展示。算钱不要用它。 */
    retailPriceCents: integer("retail_price_cents").notNull(),
    /** 单张成本，同样是单价。 */
    agentCostCents: integer("agent_cost_cents").notNull(),
    /** 整单总额 = retail_price_cents × quantity。收款金额、到账校验、手续费都按这个算。 */
    grossCents: integer("gross_cents").notNull().default(0),
    /** 整单总成本 = agent_cost_cents × quantity。代理收益按这个扣。 */
    agentCostTotalCents: integer("agent_cost_total_cents").notNull().default(0),
    paymentChannel: text("payment_channel").notNull(),
    feeRatePpm: integer("fee_rate_ppm").notNull(),
    /** 每笔支付固定费。一单就是一笔支付，不随 quantity 翻倍。 */
    fixedFeeCents: integer("fixed_fee_cents").notNull(),
    estimatedPaymentFeeCents: integer("estimated_payment_fee_cents").notNull(),
    actualPaymentFeeCents: integer("actual_payment_fee_cents"),
    finalPaymentFeeCents: integer("final_payment_fee_cents").notNull(),
    feeReconcileStatus: text("fee_reconcile_status").notNull().default("pending"),
    feeReconcileAttempts: integer("fee_reconcile_attempts").notNull().default(0),
    feeReconcileLastError: text("fee_reconcile_last_error").notNull().default(""),
    feeReconciledAt: text("fee_reconciled_at"),
    agentEarningCents: integer("agent_earning_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    customerEmail: text("customer_email").notNull().default(""),
    payStatus: text("pay_status").notNull().default("unpaid"),
    fulfillStatus: text("fulfill_status").notNull().default("pending"),
    paymentTradeNo: text("payment_trade_no"),
    fulfillmentIdempotencyKey: text("fulfillment_idempotency_key").notNull(),
    cardplatformAccountId: integer("cardplatform_account_id"),
    lastErrorCode: text("last_error_code").notNull().default(""),
    lastErrorMessage: text("last_error_message").notNull().default(""),
    paidAt: text("paid_at"),
    deliveredAt: text("delivered_at"),
    refundedAt: text("refunded_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    orderNoIdx: uniqueIndex("store_orders_order_no_uq").on(t.orderNo),
    queryTokenIdx: uniqueIndex("store_orders_query_token_hash_uq").on(
      t.queryTokenHash,
    ),
    paymentTradeIdx: uniqueIndex("store_orders_payment_trade_no_uq").on(
      t.paymentTradeNo,
    ),
    fulfillmentKeyIdx: uniqueIndex(
      "store_orders_fulfillment_idempotency_key_uq",
    ).on(t.fulfillmentIdempotencyKey),
    agentCreatedIdx: index("store_orders_agent_created_idx").on(
      t.agentId,
      t.createdAt,
    ),
    payFulfillIdx: index("store_orders_pay_fulfill_idx").on(
      t.payStatus,
      t.fulfillStatus,
    ),
  }),
);

export const issuedCdks = sqliteTable(
  "issued_cdks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    agentId: integer("agent_id").notNull(),
    planKey: text("plan_key").notNull(),
    codeEncrypted: text("code_encrypted").notNull(),
    codeHash: text("code_hash").notNull(),
    codePrefix: text("code_prefix").notNull().default(""),
    cardplatformAccountId: integer("cardplatform_account_id").notNull(),
    redemptionOrderId: integer("redemption_order_id"),
    upstreamRef: text("upstream_ref").notNull().default(""),
    upstreamFeeMinor: integer("upstream_fee_minor").notNull().default(0),
    status: text("status").notNull().default("unused"),
    issuedAt: text("issued_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    usedAt: text("used_at"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    // 一单可以买多张，所以这里不能再是唯一索引；卡密本身仍然靠 code_hash 去重。
    orderIdx: index("issued_cdks_order_idx").on(t.orderId),
    codeHashIdx: uniqueIndex("issued_cdks_code_hash_uq").on(t.codeHash),
    redemptionOrderIdx: uniqueIndex("issued_cdks_redemption_order_id_uq").on(
      t.redemptionOrderId,
    ),
    agentIssuedIdx: index("issued_cdks_agent_issued_idx").on(
      t.agentId,
      t.issuedAt,
    ),
  }),
);

export const fulfillmentAttempts = sqliteTable(
  "fulfillment_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSummaryJson: text("request_summary_json").notNull().default("{}"),
    responseSummaryJson: text("response_summary_json").notNull().default("{}"),
    result: text("result").notNull(),
    errorCode: text("error_code").notNull().default(""),
    errorMessage: text("error_message").notNull().default(""),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    finishedAt: text("finished_at"),
  },
  (t) => ({
    orderAttemptIdx: uniqueIndex("fulfillment_attempts_order_attempt_uq").on(
      t.orderId,
      t.attemptNo,
    ),
  }),
);

export const paymentFeeReconciliations = sqliteTable(
  "payment_fee_reconciliations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    gatewayTradeNo: text("gateway_trade_no").notNull().default(""),
    estimatedFeeCents: integer("estimated_fee_cents").notNull(),
    actualFeeCents: integer("actual_fee_cents"),
    differenceCents: integer("difference_cents"),
    status: text("status").notNull(),
    responseSummaryJson: text("response_summary_json").notNull().default("{}"),
    errorCode: text("error_code").notNull().default(""),
    errorMessage: text("error_message").notNull().default(""),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    finishedAt: text("finished_at"),
  },
  (t) => ({
    orderAttemptIdx: uniqueIndex(
      "payment_fee_reconciliations_order_attempt_uq",
    ).on(t.orderId, t.attemptNo),
  }),
);

export const paymentWebhookEvents = sqliteTable(
  "payment_webhook_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    eventKey: text("event_key").notNull(),
    orderId: integer("order_id").references(() => storeOrders.id),
    tradeNo: text("trade_no").notNull().default(""),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("received"),
    error: text("error").notNull().default(""),
    receivedAt: text("received_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    processedAt: text("processed_at"),
  },
  (t) => ({
    providerEventIdx: uniqueIndex("payment_webhook_events_provider_event_uq").on(
      t.provider,
      t.eventKey,
    ),
    orderIdx: index("payment_webhook_events_order_idx").on(t.orderId),
  }),
);

export const backgroundJobs = sqliteTable(
  "background_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(12),
    runAfter: text("run_after")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lockedAt: text("locked_at"),
    lockedBy: text("locked_by").notNull().default(""),
    lastError: text("last_error").notNull().default(""),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    dedupeIdx: uniqueIndex("background_jobs_dedupe_key_uq").on(t.dedupeKey),
    dueIdx: index("background_jobs_due_idx").on(t.status, t.runAfter),
  }),
);

export const agentEarnings = sqliteTable(
  "agent_earnings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    agentId: integer("agent_id").notNull(),
    grossCents: integer("gross_cents").notNull(),
    costCents: integer("cost_cents").notNull(),
    paymentFeeCents: integer("payment_fee_cents").notNull(),
    feeSource: text("fee_source").notNull().default("estimated"),
    earningCents: integer("earning_cents").notNull(),
    status: text("status").notNull().default("pending"),
    confirmedAt: text("confirmed_at").notNull(),
    settlementId: integer("settlement_id"),
    reversalOfId: integer("reversal_of_id"),
    reversalReason: text("reversal_reason").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    orderIdx: uniqueIndex("agent_earnings_order_id_uq").on(t.orderId),
    agentConfirmedIdx: index("agent_earnings_agent_confirmed_idx").on(
      t.agentId,
      t.confirmedAt,
    ),
  }),
);

export const agentEarningAdjustments = sqliteTable(
  "agent_earning_adjustments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id),
    orderId: integer("order_id")
      .notNull()
      .references(() => storeOrders.id),
    sourceEarningId: integer("source_earning_id")
      .notNull()
      .references(() => agentEarnings.id),
    type: text("type").notNull(), // refund | chargeback | fee_correction
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    reference: text("reference").notNull().default(""),
    status: text("status").notNull().default("pending"),
    settlementId: integer("settlement_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    orderTypeIdx: uniqueIndex("agent_earning_adjustments_order_type_uq").on(
      t.orderId,
      t.type,
    ),
    agentStatusIdx: index("agent_earning_adjustments_agent_status_idx").on(
      t.agentId,
      t.status,
    ),
  }),
);

export const agentSettlements = sqliteTable(
  "agent_settlements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    settlementNo: text("settlement_no").notNull(),
    agentId: integer("agent_id").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("draft"),
    paymentMethod: text("payment_method").notNull().default(""),
    paymentReference: text("payment_reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdBy: integer("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    paidAt: text("paid_at"),
  },
  (t) => ({
    settlementNoIdx: uniqueIndex("agent_settlements_no_uq").on(t.settlementNo),
    agentCreatedIdx: index("agent_settlements_agent_created_idx").on(
      t.agentId,
      t.createdAt,
    ),
  }),
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorUserId: integer("actor_user_id"),
    actorRole: text("actor_role").notNull().default("system"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull().default(""),
    metadataJson: text("metadata_json").notNull().default("{}"),
    ip: text("ip").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    actorCreatedIdx: index("audit_logs_actor_created_idx").on(
      t.actorUserId,
      t.createdAt,
    ),
  }),
);

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

export const orderTimelineEvents = sqliteTable(
  "order_timeline_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull(),
    /** 去重键：上游事件 id，或「步骤+时间+分类」拼出来的稳定串。 */
    eventKey: text("event_key").notNull(),
    step: text("step").notNull().default(""),
    category: text("category").notNull().default(""),
    message: text("message").notNull().default(""),
    occurredAt: text("occurred_at").notNull().default(""),
    seq: integer("seq").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    orderIdx: index("order_timeline_events_order_idx").on(t.orderId, t.seq, t.id),
    keyUq: uniqueIndex("order_timeline_events_key_uq").on(t.orderId, t.eventKey),
  }),
);

export const orderUpstreamSnapshots = sqliteTable("order_upstream_snapshots", {
  orderId: integer("order_id").primaryKey(),
  status: text("status").notNull().default(""),
  stage: text("stage").notNull().default(""),
  message: text("message").notNull().default(""),
  accountEmail: text("account_email").notNull().default(""),
  cardLastFour: text("card_last_four").notNull().default(""),
  /** 卡台原始报文，仅管理员可见。 */
  payloadJson: text("payload_json").notNull().default(""),
  fetchedAt: text("fetched_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

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
    accountId: integer("account_id").notNull().default(0),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull().default(""),
    payloadJson: text("payload_json").notNull().default("{}"),
    processedAt: text("processed_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    eventIdx: uniqueIndex("webhook_events_event_id_uq").on(t.eventId),
    accountIdx: index("webhook_events_account_idx").on(t.accountId),
  }),
);

export const accountCardSelectionRules = sqliteTable(
  "account_card_selection_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    planKey: text("plan_key").notNull(),
    displayName: text("display_name").notNull(),
    binPrefix: text("bin_prefix").notNull().default(""),
    channel: text("channel").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    accountSortIdx: index("account_card_selection_rules_account_sort_idx").on(
      t.accountId,
      t.sortOrder,
      t.id,
    ),
  }),
);

export const accountCardProductCache = sqliteTable(
  "account_card_product_cache",
  {
    accountId: integer("account_id").notNull(),
    productCode: text("product_code").notNull(),
    issuer: text("issuer").notNull().default(""),
    bin: text("bin").notNull().default(""),
    network: text("network").notNull().default(""),
    issuingArea: text("issuing_area").notNull().default(""),
    scene: text("scene").notNull().default(""),
    cardGroup: text("card_group").notNull().default(""),
    description: text("description").notNull().default(""),
    binHeads: text("bin_heads").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    suspendedAt: text("suspended_at").notNull().default(""),
    syncedAt: text("synced_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    pk: uniqueIndex("account_card_product_cache_pk").on(
      t.accountId,
      t.productCode,
    ),
    enabledIdx: index("account_card_product_cache_enabled_idx").on(
      t.accountId,
      t.enabled,
    ),
  }),
);

export const accountCardFailEvents = sqliteTable(
  "account_card_fail_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull(),
    cardId: integer("card_id").notNull(),
    cardLastFour: text("card_last_four").notNull().default(""),
    orderId: integer("order_id").notNull().default(0),
    cdkCode: text("cdk_code").notNull().default(""),
    accountEmailNorm: text("account_email_norm").notNull().default(""),
    emailSource: text("email_source").notNull().default(""),
    errorCode: text("error_code").notNull().default(""),
    orderStatus: text("order_status").notNull().default(""),
    verdict: text("verdict").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => ({
    uniqueEvent: uniqueIndex("account_card_fail_events_uq").on(
      t.accountId,
      t.orderId,
      t.cardId,
    ),
    cardIdx: index("account_card_fail_events_card_idx").on(
      t.accountId,
      t.cardId,
    ),
  }),
);

export const accountCardBlocklist = sqliteTable(
  "account_card_blocklist",
  {
    accountId: integer("account_id").notNull(),
    cardId: integer("card_id").notNull(),
    cardLastFour: text("card_last_four").notNull().default(""),
    reason: text("reason").notNull().default(""),
    distinctEmails: integer("distinct_emails").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    freezeStatus: text("freeze_status").notNull().default(""),
    freezeError: text("freeze_error").notNull().default(""),
    blockedAt: text("blocked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    unblockedAt: text("unblocked_at"),
    notes: text("notes").notNull().default(""),
  },
  (t) => ({
    pk: uniqueIndex("account_card_blocklist_pk").on(t.accountId, t.cardId),
    activeIdx: index("account_card_blocklist_active_idx").on(t.accountId),
  }),
);
