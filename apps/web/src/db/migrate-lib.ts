import { eq, sql } from "drizzle-orm";
import { db, client } from "./index";
import {
  adminUsers,
  paymentChannelConfigs,
  settings,
  storefronts,
  users,
} from "./schema";
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

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  agent_id INTEGER,
  last_login_at TEXT,
  password_changed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS users_agent_id_uq ON users(agent_id);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_slug TEXT NOT NULL,
  theme_id TEXT NOT NULL DEFAULT 'snow',
  settlement_name TEXT NOT NULL DEFAULT '',
  settlement_method TEXT NOT NULL DEFAULT '',
  settlement_account_encrypted TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_current_slug_uq ON agents(current_slug);
CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status);

CREATE TABLE IF NOT EXISTS agent_slug_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  replaced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_slug_history_slug_uq ON agent_slug_history(slug);
CREATE INDEX IF NOT EXISTS agent_slug_history_agent_idx ON agent_slug_history(agent_id);

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

CREATE TABLE IF NOT EXISTS platform_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  global_cost_price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  cardplatform_sellable INTEGER NOT NULL DEFAULT 0,
  cardplatform_raw_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_plans_plan_key_uq ON platform_plans(plan_key);
CREATE INDEX IF NOT EXISTS platform_plans_enabled_sort_idx ON platform_plans(enabled, sort_order);

CREATE TABLE IF NOT EXISTS agent_plan_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  cost_override_cents INTEGER,
  retail_price_cents INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_plan_prices_agent_plan_uq ON agent_plan_prices(agent_id, plan_id);
CREATE INDEX IF NOT EXISTS agent_plan_prices_agent_enabled_idx ON agent_plan_prices(agent_id, enabled);

CREATE TABLE IF NOT EXISTS payment_channel_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  fee_rate_ppm INTEGER NOT NULL DEFAULT 0,
  fixed_fee_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_channel_configs_channel_uq ON payment_channel_configs(channel);

CREATE TABLE IF NOT EXISTS cardplatform_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'legacy',
  site_base TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL DEFAULT '',
  webhook_secret_encrypted TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_health_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  last_plans_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS cardplatform_accounts_enabled_default_idx ON cardplatform_accounts(enabled, is_default);

CREATE TABLE IF NOT EXISTS store_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  query_token_hash TEXT NOT NULL,
  query_token_encrypted TEXT NOT NULL DEFAULT '',
  agent_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  plan_key_snapshot TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  -- retail_price_cents / agent_cost_cents 是单价，gross_cents / agent_cost_total_cents 是整单总额。
  retail_price_cents INTEGER NOT NULL,
  agent_cost_cents INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  agent_cost_total_cents INTEGER NOT NULL DEFAULT 0,
  payment_channel TEXT NOT NULL,
  fee_rate_ppm INTEGER NOT NULL,
  fixed_fee_cents INTEGER NOT NULL,
  estimated_payment_fee_cents INTEGER NOT NULL,
  actual_payment_fee_cents INTEGER,
  final_payment_fee_cents INTEGER NOT NULL,
  fee_reconcile_status TEXT NOT NULL DEFAULT 'pending',
  fee_reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  fee_reconcile_last_error TEXT NOT NULL DEFAULT '',
  fee_reconciled_at TEXT,
  agent_earning_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  customer_email TEXT NOT NULL DEFAULT '',
  pay_status TEXT NOT NULL DEFAULT 'unpaid',
  fulfill_status TEXT NOT NULL DEFAULT 'pending',
  payment_trade_no TEXT,
  fulfillment_idempotency_key TEXT NOT NULL,
  cardplatform_account_id INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  delivered_at TEXT,
  refunded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_order_no_uq ON store_orders(order_no);
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_query_token_hash_uq ON store_orders(query_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_payment_trade_no_uq ON store_orders(payment_trade_no);
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_fulfillment_idempotency_key_uq ON store_orders(fulfillment_idempotency_key);
CREATE INDEX IF NOT EXISTS store_orders_agent_created_idx ON store_orders(agent_id, created_at);
CREATE INDEX IF NOT EXISTS store_orders_pay_fulfill_idx ON store_orders(pay_status, fulfill_status);

CREATE TABLE IF NOT EXISTS issued_cdks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  plan_key TEXT NOT NULL,
  code_encrypted TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL DEFAULT '',
  cardplatform_account_id INTEGER NOT NULL,
  redemption_order_id INTEGER,
  upstream_ref TEXT NOT NULL DEFAULT '',
  upstream_fee_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unused',
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS issued_cdks_order_idx ON issued_cdks(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS issued_cdks_code_hash_uq ON issued_cdks(code_hash);
CREATE INDEX IF NOT EXISTS issued_cdks_agent_issued_idx ON issued_cdks(agent_id, issued_at);

CREATE TABLE IF NOT EXISTS fulfillment_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_summary_json TEXT NOT NULL DEFAULT '{}',
  response_summary_json TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_attempts_order_attempt_uq ON fulfillment_attempts(order_id, attempt_no);

CREATE TABLE IF NOT EXISTS payment_fee_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  gateway_trade_no TEXT NOT NULL DEFAULT '',
  estimated_fee_cents INTEGER NOT NULL,
  actual_fee_cents INTEGER,
  difference_cents INTEGER,
  status TEXT NOT NULL,
  response_summary_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_fee_reconciliations_order_attempt_uq ON payment_fee_reconciliations(order_id, attempt_no);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  order_id INTEGER REFERENCES store_orders(id),
  trade_no TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_webhook_events_provider_event_uq ON payment_webhook_events(provider, event_key);
CREATE INDEX IF NOT EXISTS payment_webhook_events_order_idx ON payment_webhook_events(order_id);

CREATE TABLE IF NOT EXISTS background_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 12,
  run_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  locked_at TEXT,
  locked_by TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_dedupe_key_uq ON background_jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS background_jobs_due_idx ON background_jobs(status, run_after);

CREATE TABLE IF NOT EXISTS agent_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  payment_fee_cents INTEGER NOT NULL,
  fee_source TEXT NOT NULL DEFAULT 'estimated',
  earning_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  confirmed_at TEXT NOT NULL,
  settlement_id INTEGER,
  reversal_of_id INTEGER,
  reversal_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_earnings_order_id_uq ON agent_earnings(order_id);
CREATE INDEX IF NOT EXISTS agent_earnings_agent_confirmed_idx ON agent_earnings(agent_id, confirmed_at);

CREATE TABLE IF NOT EXISTS agent_earning_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  order_id INTEGER NOT NULL REFERENCES store_orders(id),
  source_earning_id INTEGER NOT NULL REFERENCES agent_earnings(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  settlement_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_earning_adjustments_order_type_uq ON agent_earning_adjustments(order_id, type);
CREATE INDEX IF NOT EXISTS agent_earning_adjustments_agent_status_idx ON agent_earning_adjustments(agent_id, status);

CREATE TABLE IF NOT EXISTS agent_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_no TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  payment_method TEXT NOT NULL DEFAULT '',
  payment_reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_settlements_no_uq ON agent_settlements(settlement_no);
CREATE INDEX IF NOT EXISTS agent_settlements_agent_created_idx ON agent_settlements(agent_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_role TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx ON audit_logs(actor_user_id, created_at);

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
  account_id INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_id_uq ON webhook_events(event_id);
-- account_id 上的索引不在这里建：老库的 CREATE TABLE IF NOT EXISTS 是空转，那一列要等
-- 后面的 ALTER 才有，在这里建索引会直接 no such column，ensureSchema 抛错、bootDb 起不来。
-- 索引建在 ALTER 之后。

CREATE TABLE IF NOT EXISTS account_card_selection_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  plan_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bin_prefix TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS account_card_selection_rules_account_sort_idx
  ON account_card_selection_rules(account_id, sort_order, id);

CREATE TABLE IF NOT EXISTS account_card_product_cache (
  account_id INTEGER NOT NULL,
  product_code TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT '',
  bin TEXT NOT NULL DEFAULT '',
  network TEXT NOT NULL DEFAULT '',
  issuing_area TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  card_group TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  bin_heads TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  suspended_at TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(account_id, product_code)
);
CREATE INDEX IF NOT EXISTS account_card_product_cache_enabled_idx
  ON account_card_product_cache(account_id, enabled);

CREATE TABLE IF NOT EXISTS account_card_fail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  card_last_four TEXT NOT NULL DEFAULT '',
  order_id INTEGER NOT NULL DEFAULT 0,
  cdk_code TEXT NOT NULL DEFAULT '',
  account_email_norm TEXT NOT NULL DEFAULT '',
  email_source TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  order_status TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, order_id, card_id)
);
CREATE INDEX IF NOT EXISTS account_card_fail_events_card_idx
  ON account_card_fail_events(account_id, card_id);

CREATE TABLE IF NOT EXISTS account_card_blocklist (
  account_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  card_last_four TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  distinct_emails INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  freeze_status TEXT NOT NULL DEFAULT '',
  freeze_error TEXT NOT NULL DEFAULT '',
  blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  unblocked_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(account_id, card_id)
);
CREATE INDEX IF NOT EXISTS account_card_blocklist_active_idx
  ON account_card_blocklist(account_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON order_status_history(order_id);

-- 卡台 result 里的 events[]。轮询每 2~3 秒重复返回同一批，靠 (order_id, event_key)
-- 去重；event_key 优先用上游事件 id，没有就拼「步骤+时间+分类」。
CREATE TABLE IF NOT EXISTS order_timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS order_timeline_events_key_uq
  ON order_timeline_events(order_id, event_key);
CREATE INDEX IF NOT EXISTS order_timeline_events_order_idx
  ON order_timeline_events(order_id, seq, id);

-- 每单一行，存最近一次卡台返回的订单级字段和原始报文。原始报文只给管理员看：
-- 里面有卡 id、发卡行、内部错误码这些买家不该看到的东西。
CREATE TABLE IF NOT EXISTS order_upstream_snapshots (
  order_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  account_email TEXT NOT NULL DEFAULT '',
  card_last_four TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

const CARD_OPS_DDL = `
CREATE INDEX IF NOT EXISTS webhook_events_account_idx ON webhook_events(account_id);
CREATE TABLE IF NOT EXISTS account_card_selection_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  plan_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bin_prefix TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS account_card_selection_rules_account_sort_idx
  ON account_card_selection_rules(account_id, sort_order, id);
CREATE TABLE IF NOT EXISTS account_card_product_cache (
  account_id INTEGER NOT NULL,
  product_code TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT '',
  bin TEXT NOT NULL DEFAULT '',
  network TEXT NOT NULL DEFAULT '',
  issuing_area TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  card_group TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  bin_heads TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  suspended_at TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(account_id, product_code)
);
CREATE INDEX IF NOT EXISTS account_card_product_cache_enabled_idx
  ON account_card_product_cache(account_id, enabled);
CREATE TABLE IF NOT EXISTS account_card_fail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  card_last_four TEXT NOT NULL DEFAULT '',
  order_id INTEGER NOT NULL DEFAULT 0,
  cdk_code TEXT NOT NULL DEFAULT '',
  account_email_norm TEXT NOT NULL DEFAULT '',
  email_source TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  order_status TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, order_id, card_id)
);
CREATE INDEX IF NOT EXISTS account_card_fail_events_card_idx
  ON account_card_fail_events(account_id, card_id);
CREATE TABLE IF NOT EXISTS account_card_blocklist (
  account_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  card_last_four TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  distinct_emails INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  freeze_status TEXT NOT NULL DEFAULT '',
  freeze_error TEXT NOT NULL DEFAULT '',
  blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  unblocked_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(account_id, card_id)
);
CREATE INDEX IF NOT EXISTS account_card_blocklist_active_idx
  ON account_card_blocklist(account_id);
`;

export async function ensureCardOpsTables() {
  await client.executeMultiple(CARD_OPS_DDL);
}

export async function ensureSchema() {
  await client.executeMultiple(DDL);
  await client.executeMultiple(`
    UPDATE agent_earning_adjustments
    SET created_at = replace(created_at, ' ', 'T') || '.000Z'
    WHERE created_at GLOB '????-??-?? ??:??:??';
    UPDATE agent_settlements
    SET created_at = replace(created_at, ' ', 'T') || '.000Z'
    WHERE created_at GLOB '????-??-?? ??:??:??';
    UPDATE payment_webhook_events
    SET received_at = replace(received_at, ' ', 'T') || '.000Z'
    WHERE received_at GLOB '????-??-?? ??:??:??';
    UPDATE background_jobs
    SET
      run_after = CASE WHEN run_after GLOB '????-??-?? ??:??:??'
        THEN replace(run_after, ' ', 'T') || '.000Z' ELSE run_after END,
      created_at = CASE WHEN created_at GLOB '????-??-?? ??:??:??'
        THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END,
      updated_at = CASE WHEN updated_at GLOB '????-??-?? ??:??:??'
        THEN replace(updated_at, ' ', 'T') || '.000Z' ELSE updated_at END
    WHERE
      run_after GLOB '????-??-?? ??:??:??'
      OR created_at GLOB '????-??-?? ??:??:??'
      OR updated_at GLOB '????-??-?? ??:??:??';
    UPDATE store_orders
    SET
      created_at = CASE WHEN created_at GLOB '????-??-?? ??:??:??'
        THEN replace(created_at, ' ', 'T') || '.000Z' ELSE created_at END,
      updated_at = CASE WHEN updated_at GLOB '????-??-?? ??:??:??'
        THEN replace(updated_at, ' ', 'T') || '.000Z' ELSE updated_at END
    WHERE
      created_at GLOB '????-??-?? ??:??:??'
      OR updated_at GLOB '????-??-?? ??:??:??';
  `);
  try {
    await client.execute(
      "ALTER TABLE issued_cdks ADD COLUMN redemption_order_id INTEGER",
    );
  } catch (error) {
    if (!/duplicate column/i.test(String(error))) throw error;
  }
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS issued_cdks_redemption_order_id_uq ON issued_cdks(redemption_order_id)",
  );
  try {
    await client.execute(
      "ALTER TABLE store_orders ADD COLUMN query_token_encrypted TEXT NOT NULL DEFAULT ''",
    );
  } catch (error) {
    if (!/duplicate column/i.test(String(error))) throw error;
  }
  const addColumn = async (sqlText: string) => {
    try {
      await client.execute(sqlText);
    } catch (error) {
      if (!/duplicate column/i.test(String(error))) throw error;
    }
  };
  await addColumn(
    "ALTER TABLE cardplatform_accounts ADD COLUMN priority INTEGER NOT NULL DEFAULT 100",
  );
  await addColumn(
    "ALTER TABLE cardplatform_accounts ADD COLUMN webhook_path TEXT NOT NULL DEFAULT ''",
  );
  await addColumn("ALTER TABLE cardplatform_accounts ADD COLUMN last_ok_at TEXT");
  await addColumn(
    "ALTER TABLE cardplatform_accounts ADD COLUMN last_error_at TEXT",
  );
  await addColumn(
    "ALTER TABLE cardplatform_accounts ADD COLUMN last_products_sync_at TEXT",
  );
  await addColumn(
    "ALTER TABLE webhook_events ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0",
  );
  // 必须跟在上面这条 ALTER 后面：老库里这一列是刚补出来的。
  await client.execute(
    "CREATE INDEX IF NOT EXISTS webhook_events_account_idx ON webhook_events(account_id)",
  );
  await addColumn(
    "ALTER TABLE agents ADD COLUMN theme_id TEXT NOT NULL DEFAULT 'snow'",
  );
  await addColumn(
    "ALTER TABLE store_orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1",
  );
  await addColumn(
    "ALTER TABLE store_orders ADD COLUMN gross_cents INTEGER NOT NULL DEFAULT 0",
  );
  await addColumn(
    "ALTER TABLE store_orders ADD COLUMN agent_cost_total_cents INTEGER NOT NULL DEFAULT 0",
  );
  // 老订单都是一张一单，总额就等于单价。0 表示这行还没补过，正常订单不可能是 0 元。
  await client.executeMultiple(`
    UPDATE store_orders
    SET gross_cents = retail_price_cents * quantity
    WHERE gross_cents = 0;
    UPDATE store_orders
    SET agent_cost_total_cents = agent_cost_cents * quantity
    WHERE agent_cost_total_cents = 0;
  `);
  // 一单多张之后 order_id 不能再唯一。DDL 已经建好非唯一索引，这里只负责拆掉老的。
  await client.execute("DROP INDEX IF EXISTS issued_cdks_order_id_uq");
  await ensureCardOpsTables();

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
    if (
      process.env.NODE_ENV === "production" &&
      (!process.env.KAIMI_ADMIN_PASSWORD ||
        password === "kaimi-change-me" ||
        password.length < 12)
    ) {
      throw new Error(
        "首次生产部署必须配置至少 12 位的 KAIMI_ADMIN_PASSWORD",
      );
    }
    await db.insert(adminUsers).values({
      username,
      passwordHash: await bcrypt.hash(password, 10),
    });
  }

  // Additive migration: preserve every legacy admin login as a super-admin.
  const legacyAdmins = await db.select().from(adminUsers);
  for (const legacy of legacyAdmins) {
    await db
      .insert(users)
      .values({
        username: legacy.username.toLowerCase(),
        passwordHash: legacy.passwordHash,
        role: "super_admin",
        status: "active",
        createdAt: legacy.createdAt,
        updatedAt: legacy.createdAt,
      })
      .onConflictDoNothing({ target: users.username });
  }

  for (const channel of ["alipay", "wxpay"]) {
    await db
      .insert(paymentChannelConfigs)
      .values({ channel })
      .onConflictDoNothing({ target: paymentChannelConfigs.channel });
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
