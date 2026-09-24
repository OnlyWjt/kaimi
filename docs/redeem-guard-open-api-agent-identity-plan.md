# 兑换防刷 / 订单卡密关系 / 开放 API / 代理真实身份 — 实施方案

分支：`feat/redeem-guard-open-api-agent-identity`
状态：方案，待实现。本文写给接手写代码的人，按章节顺序实现即可，每章末尾有验收条件。

---

## 0. 背景

2026-09-24 11:08–11:14，公开兑换口被人用 `attacker@evil.com`、`amp@test.com`、`probe2@test.com` 等探测邮箱连续提交，后台「订单查询」多出十几笔 RC 兑换单：卡密空、套餐空、支付「已持码」、履约「失败」。

结论（已核对代码）：

- 这些单**没有兑走任何卡**，也不涉及付款。现开卡密长度足够，按当前每分钟个位数的速度盲猜撞不中。
- 真正的问题是：猜错也会写正式订单、也会去打卡台 preview；猜中本地真卡时会先锁卡；限流只按 IP、只在内存里、批量按请求计而不是按张计。
- 另外发现后台订单列表的卡密列查错了表，成功兑换的 RC 单卡密列也是空的（见第 1 章）。

---

## 1. 订单和卡密的关系

### 1.1 现状：三张表，两条链

```
【现在在用的链路：店铺售卡】

store_orders (KS 开头，客户付款的销售单)
   │  1 : N   issued_cdks.order_id
   ▼
issued_cdks (付款后卡台现开的卡密，code_encrypted 加密存储，code_hash 去重)
   │  1 : 0..1   issued_cdks.redemption_order_id  (唯一索引)
   ▼
orders (RC 开头，kind='recharge'，客户拿卡密来兑换时建的兑换单)


【老链路：本地卡池，已基本不用】

cdk_pool (预先同步/手工导入的卡)
   │  N : 1   cdk_pool.order_id
   ▼
orders (kind='code' 的发卡单 / 旧版 recharge 单)
```

- **KS 单**（`store_orders`）= 钱。支付、手续费、代理收益、结算全挂在它上面。一单可以买多张（`quantity`）。
- **issued_cdks** = 货。只有 KS 单付款成功后，履约流程 `fulfillStoreOrder` 调卡台 `issueMany` 现开，才会产生。状态：`unused → locked → redeeming → used`，另有 `disabled`。
- **RC 单**（`orders`，`kind='recharge'`）= 一次兑换动作。客户在 `/recharge` 提交卡密 + Session/邮箱，系统建一笔 RC 单去卡台兑。它**不涉及钱**，`pay_status` 固定写 `manual`，后台显示成「已持码」——意思是「客户手里拿着码来兑」，不代表付过款。
- 同一张卡密最多成功挂一笔 RC 单（`redemption_order_id` 唯一）。兑换失败时卡退回 `unused`，但那笔失败 RC 单上的 `redemption_order_id` 会被下一次兑换覆盖，旧的失败单就不再能反查到卡。

### 1.2 现在的问题

| 问题 | 位置 | 后果 |
| --- | --- | --- |
| 后台「订单查询」卡密列只查 `cdk_pool.order_id` | `apps/web/src/app/api/admin/route.ts` `section === "orders"` | 走 `issued_cdks` 的 RC 单卡密列永远是 `—`，截图里成功单也是空的 |
| 本地查不到卡密也建 RC 单 | `apps/web/src/lib/orders.ts` `openRechargeOrder` | 乱猜的卡密全部落成失败订单，污染列表 |
| RC 单没有记录「用的是哪张卡」的稳定字段 | `orders` 表 | 失败单无法追溯；被覆盖后查不到历史 |
| RC 单看不出属于哪个代理 / 哪笔 KS 单 | `orders` 表 | 售后要人工拼 |
| 「已持码」这个标签误导 | `apps/web/src/app/admin/page.tsx` `manual: "已持码"` | 看起来像付过款 |

### 1.3 改法

**1.3.1 给 `orders` 加追溯字段（迁移写在 `apps/web/src/db/migrate-lib.ts`，schema 同步改 `schema.ts`）**

```sql
ALTER TABLE orders ADD COLUMN issued_cdk_id INTEGER;          -- 这次兑换用的卡，NULL = 本地查不到
ALTER TABLE orders ADD COLUMN store_order_id INTEGER;         -- 冗余，便于按 KS 单查兑换记录
ALTER TABLE orders ADD COLUMN agent_id INTEGER;               -- 冗余，便于按代理筛
ALTER TABLE orders ADD COLUMN code_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN code_last4 TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN client_ip TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS orders_issued_cdk_idx ON orders(issued_cdk_id);
CREATE INDEX IF NOT EXISTS orders_store_order_idx ON orders(store_order_id);
```

- `openRechargeOrder` 建单时写入这几个字段（`client_ip` 由路由层传进来，用 `clientIp(req)`）。
- 历史数据回填：一次性脚本按 `issued_cdks.redemption_order_id` 反写 `orders.issued_cdk_id / store_order_id / agent_id / code_prefix / code_last4`。回填不到的保持 NULL。
- `issued_cdks.redemption_order_id` 保持原语义（指向**最近一次**兑换单），不改。

**1.3.2 后台订单列表改查询**

`section === "orders"`：卡密展示改为优先 `orders.issued_cdk_id → issued_cdks`（解密后 `maskCode`），回落 `cdk_pool.order_id`。新增列：「来源 KS 单」「代理」。筛选框支持按 KS 单号、代理筛。

**1.3.3 标签**

`manual: "已持码"` 改为 `manual: "免支付"`（或「兑换单」），并在 RC 单的支付列 tooltip 注明「兑换单不涉及付款，付款记录见来源 KS 单」。

**1.3.4 查不到卡密的兑换不再落正式订单** —— 见第 2 章 2.3。

**验收**

- 随便挑一笔 09/21 成功的 RC 单，后台卡密列显示脱敏卡密，并能点到来源 KS 单和代理。
- 卡密查询页点某张卡，能看到它的全部兑换记录（成功 + 失败）。

---

## 2. 兑换防刷

### 2.1 现状

| 接口 | 限流 | 问题 |
| --- | --- | --- |
| `POST /api/public/cdk/redeem` | 8/分钟/IP | 只按 IP |
| `POST /api/recharge/submit` | 8/分钟/IP | 同上 |
| `POST /api/public/cdk/preview`、`/api/recharge/validate` | 20/分钟/IP | 猜错不计失败，直接打卡台 preview |
| `POST /api/public/cdk/preflight` | 15/分钟/IP | 同上 |
| `POST /api/recharge/batch/validate` / `submit` | 匿名 6 次请求/分钟 | 一次请求可带最多 200 张，按请求计 = 额度放大上百倍 |

限流器是 `apps/web/src/lib/rate-limit.ts` 的进程内 `Map`，重启清零，多实例各算各的。

### 2.2 目标

1. 猜错的卡密不写正式订单、不打卡台。
2. 失败次数驱动封锁，不只看请求次数。
3. 批量按张计额度。
4. 真卡被猜中时，占锁时间尽量短。
5. 后台能看到被拦截的记录，能手动解封。

### 2.3 设计

**2.3.1 本地先判卡密是否存在（最关键的一步）**

现在所有卡都来自 `issued_cdks`（付款后现开）。在 `openRechargeOrder` / `previewRedeemableCdk` 最前面：

```
issued = findIssuedCdkByCode(code)
if (!issued && !legacyCdkPoolHit(code) && !setting("redeem_allow_unknown_code")) {
  recordRedeemFailure(ip, email, "unknown_code")
  throw new RedeemRejectedError("卡密无效")      // 不建单、不打卡台
}
```

- 新增设置项 `redeem_allow_unknown_code`（默认 `false`）。只有当你确实还在卖「卡台直发、本站没记录」的码时才打开。
- 错误文案统一「卡密无效或已使用」，不区分「不存在 / 已使用 / 已禁用」，避免被用来枚举卡的状态。

**2.3.2 失败计数与封锁表（落库，不用内存）**

```sql
CREATE TABLE IF NOT EXISTS redeem_guard_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,         -- ip | email | code_hash
  subject TEXT NOT NULL,
  outcome TEXT NOT NULL,              -- unknown_code | used_code | disabled_code | preflight_failed | blocked | ok
  route TEXT NOT NULL,
  client_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS redeem_guard_events_subject_idx
  ON redeem_guard_events(subject_type, subject, created_at);

CREATE TABLE IF NOT EXISTS redeem_guard_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  blocked_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS redeem_guard_blocks_active_uq
  ON redeem_guard_blocks(subject_type, subject) WHERE released_at IS NULL;
```

新模块 `apps/web/src/lib/redeem-guard.ts`（纯逻辑放 `redeem-guard-core.ts`，便于单测）：

- `assertNotBlocked({ ip, email })`：所有兑换类接口第一步调用，命中返回 429 + `Retry-After`。
- `recordRedeemFailure({ ip, email, codeHash, outcome, route })`：写事件，并按阈值升级封锁。
- `recordRedeemSuccess(...)`：写 `ok` 事件（给统计用，不清零失败）。

默认阈值（全部做成 settings 可调）：

| 维度 | 窗口 | 失败次数 | 封锁时长 |
| --- | --- | --- | --- |
| IP | 10 分钟 | 5 次 | 30 分钟 |
| IP | 24 小时 | 20 次 | 24 小时 |
| 邮箱（小写、去 `+tag`） | 1 小时 | 5 次 | 1 小时 |
| 全站 | 1 分钟 | 60 次 `unknown_code` | 触发告警（见 2.3.6），不封 |

`preflight_failed`（Session 不对、账号不对）也算失败，但权重 0.5（两次算一次），避免误伤手滑的真实客户。

事件表保留 30 天，由 `sync-scheduler.ts` 里的定时任务清理。

**2.3.3 进程内限流保留，但换成「先内存、后落库」两层**

`rate-limit.ts` 的内存桶继续挡瞬时洪峰（成本最低）。失败计数一律走 2.3.2 的库表，重启、多实例都不丢。

**2.3.4 批量按张计额度**

`/api/recharge/batch/validate` 和 `/submit`：

- 匿名调用：每 IP 每小时最多 **20 张**（不是 20 次请求），超过直接 429。
- 代理登录：每代理每小时 500 张（settings 可调）。
- 批量里只要有 ≥ 3 张是 `unknown_code`，整批剩余的卡不再处理，直接返回，并按张数记失败。
- 匿名批量上限从 `getBatchRedeemLimit()` 再压一层：匿名最多 10 张/批。

**2.3.5 缩短真卡占锁时间**

现在：提交即 `unused → locked`，after() 里再跑 preview + preflight + redeem（每步最长 45 秒），预检失败才退回。

改为两段式：

1. 请求内只做本地校验（卡存在、状态 `unused`、未被封锁），**不抢锁**，建一笔 `fulfill_status='pending'` 的 RC 单。
2. after() 里先跑 preview + preflight；**预检通过后**才 `unused → locked`（CAS），然后立刻 redeem。

这样攻击者拿垃圾 Session 提交真卡，卡不会被锁。并发两人同时提交同一张卡：两人都能过预检，但只有一人抢到锁，另一人的 RC 单标 `failed`，消息「该卡密已在兑换中」，并把胜者的单号写进 message，界面照旧能跳转。

注意：`driveRechargeOrder` 里 `allowInFlight: true` 的特殊处理要一起改掉；`reconcileStuckIssuedLocks` 的逻辑不变。

**2.3.6 告警**

全站 1 分钟内 `unknown_code` ≥ 60，或单 IP 被升级到 24 小时封锁时，走现有 `notifyIfTerminal` 同一条通知渠道（或新增 webhook 设置项 `security_alert_webhook`）发一条：时间、IP、邮箱、次数。

**2.3.7 后台**

「订单查询」页新增一个页签或按钮「拦截记录」：

- 列表：时间、IP、邮箱、结果、接口。
- 当前封锁：主体、原因、到期时间、「解封」按钮（写 `released_at`，写 `audit_logs`）。
- 清理历史垃圾单：一次性管理动作「隐藏无卡密失败兑换单」—— 条件 `kind='recharge' AND issued_cdk_id IS NULL AND fulfill_status='failed'`，只打标记 `hidden=1`（新增列），不物理删除。

**2.3.8 可选：人机验证**

阈值被触发后的下一次请求要求 Cloudflare Turnstile token（设置项 `turnstile_site_key` / `turnstile_secret`，未配置就跳过）。第一期可以不做，留接口。

**验收**

- 用同一 IP 连续提交 5 个不存在的卡密，第 6 次返回 429，订单表不新增记录，卡台 preview 调用次数为 0。
- 匿名批量提交 30 张，只处理前 10 张；一小时内累计超过 20 张返回 429。
- 用真卡 + 格式正确但无效的 Session 提交，卡状态始终是 `unused`。
- 两个请求并发提交同一张真卡 + 有效 Session，只有一笔成功兑换，另一笔明确失败且指向胜者单号。
- 后台能看到拦截记录并手动解封。
- `rate-limit.test.ts` 旧用例全部通过；`redeem-guard-core.test.ts` 覆盖阈值升级、权重、邮箱归一化。

---

## 3. 对外开放 API（供二次开发）

### 3.1 现状

`/api/v1` 下只有卡台回调 webhook。其余接口全是给自家前端用的：靠 cookie 会话鉴权、返回结构随页面改、没有版本承诺。二开的人只能抓包调，一改就坏。

### 3.2 设计原则

- 新接口全部挂在 `/api/v1/open/*`，和前端内部接口彻底分开。内部接口以后怎么改都不影响开放 API。
- 鉴权用 API Key，不用 cookie。
- 返回格式、错误码、分页统一；字段只增不删，破坏性变更开 `/api/v2`。
- 业务逻辑复用 `lib/` 里现有函数，路由层只做鉴权、参数校验、字段映射。

### 3.3 API Key

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL,            -- platform | agent
  agent_id INTEGER,                    -- owner_type='agent' 时必填
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,            -- 形如 km_live_ab12，明文存，用于展示和定位
  key_hash TEXT NOT NULL,              -- 完整 key 的 HMAC-SHA256（复用 hashLookupValue）
  scopes TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
  ip_allowlist TEXT NOT NULL DEFAULT '[]',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  last_used_at TEXT,
  last_used_ip TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uq ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_agent_idx ON api_keys(agent_id);
```

- Key 格式：`km_live_` + 32 字节 base62。创建时明文只返回一次。
- 请求头：`Authorization: Bearer km_live_xxx`。
- 两类持有者：
  - **平台 Key**（超管在后台建）：能看全站数据。
  - **代理 Key**（代理在自己后台建）：只能看/操作自己 `agent_id` 的数据，所有查询强制加 `agent_id` 条件。
- 每次调用写 `api_request_logs`（key_id、路径、状态码、耗时、IP），保留 30 天。

鉴权中间件放 `apps/web/src/lib/open-api/auth.ts`：

```ts
export async function requireApiKey(req: Request, scope: OpenApiScope): Promise<ApiKeyContext>
// 1. 解析 Bearer；2. 按 hash 查 key，校验 status/expires/ip_allowlist；
// 3. 校验 scope；4. 按 key 维度限流（enforceRateLimitFor(`open:${key.id}`, key.rateLimitPerMin)）；
// 5. 更新 last_used_at（节流：同一 key 1 分钟最多写一次）
```

### 3.4 Scope

| scope | 平台 Key | 代理 Key | 说明 |
| --- | --- | --- | --- |
| `plans:read` | ✓ | ✓ | 套餐列表、代理成本价/零售价 |
| `orders:read` | ✓ | ✓（仅自己） | KS 销售单 |
| `orders:write` | ✓ | ✓（仅自己） | 代下单（生成支付链接） |
| `cdks:read` | ✓ | ✓（仅自己） | 卡密状态；明文卡密需要额外 `cdks:reveal` |
| `cdks:reveal` | ✓ | ✓（仅自己） | 返回卡密明文，调用写 `audit_logs` |
| `redeem:write` | ✓ | ✓ | 代客户兑换 |
| `redeem:read` | ✓ | ✓ | 查兑换单 |
| `earnings:read` | ✓ | ✓（仅自己） | 收益、结算 |
| `agents:read` | ✓ | ✗ | 代理列表（含真实身份，见第 4 章） |
| `webhooks:manage` | ✓ | ✓ | 配置回调地址 |

### 3.5 统一格式

成功：

```json
{ "data": { ... }, "request_id": "req_01J..." }
```

列表：

```json
{ "data": [ ... ], "page": { "next_cursor": "eyJpZCI6MTIzfQ", "has_more": true }, "request_id": "..." }
```

- 分页用游标（按 `id` 倒序），`limit` 默认 20、最大 100。

错误：

```json
{ "error": { "code": "CDK_INVALID", "message": "卡密无效或已使用" }, "request_id": "..." }
```

错误码表（放 `apps/web/src/lib/open-api/errors.ts`）：`UNAUTHORIZED`、`FORBIDDEN_SCOPE`、`RATE_LIMITED`、`VALIDATION_FAILED`、`NOT_FOUND`、`CDK_INVALID`、`CDK_IN_FLIGHT`、`REDEEM_BLOCKED`、`PLAN_UNAVAILABLE`、`UPSTREAM_UNAVAILABLE`、`CONFLICT`、`INTERNAL`。

- 写接口支持 `Idempotency-Key` 头，24 小时内同 key 同 API Key 返回首次结果（新表 `api_idempotency`：key_id、idem_key、request_hash、response_json、status、created_at）。
- 所有时间 ISO 8601 UTC；金额一律「分」整数 + `currency`。

### 3.6 第一期接口清单

**套餐**

- `GET /api/v1/open/plans` — 套餐列表。代理 Key 返回该代理的零售价与成本价。

**销售单（KS）**

- `POST /api/v1/open/orders` — 代下单。入参 `plan_key`、`quantity`、`customer_email`、`payment_channel`、`coupon_code?`。返回 `order_no`、`pay_url`、`query_token`。复用 `lib/store-orders.ts` 的建单逻辑。
- `GET /api/v1/open/orders` — 列表，筛选 `status`、`pay_status`、`created_from/to`、`customer_email`。
- `GET /api/v1/open/orders/{orderNo}` — 详情，含 `cdks[]`（默认脱敏）。

**卡密**

- `GET /api/v1/open/cdks` — 列表，筛选 `status`、`order_no`、`plan_key`。
- `GET /api/v1/open/cdks/{id}` — 详情，含兑换记录（依赖第 1 章的 `orders.issued_cdk_id`）。
- `POST /api/v1/open/cdks/{id}/reveal` — 返回明文，需 `cdks:reveal`，写审计。

**兑换**

- `POST /api/v1/open/redemptions` — 入参 `code`、`mode`（`session` | `mailbox`）、`session?`、`email?`、`password?`。返回 `redemption_no`（RC 单号）、`status`。**同样走第 2 章的 redeem-guard**，按 API Key 维度计失败，失败过多封 Key 而不是封 IP。
- `GET /api/v1/open/redemptions/{no}` — 状态、时间线（复用 `order-timeline.ts`）。

**收益**

- `GET /api/v1/open/earnings` — 按日/月汇总，代理 Key 只看自己。
- `GET /api/v1/open/settlements` — 结算记录。

**代理**（仅平台 Key）

- `GET /api/v1/open/agents` — 列表，含第 4 章定义的身份字段。

### 3.7 出站 Webhook

```sql
CREATE TABLE IF NOT EXISTS api_webhook_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL, agent_id INTEGER,
  url TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS api_webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

- 事件：`order.paid`、`order.delivered`、`order.refunded`、`redemption.succeeded`、`redemption.failed`、`earning.confirmed`。
- 签名头：`X-Kaimi-Signature: t=<unix>,v1=<hex(HMAC-SHA256(secret, t + "." + body))>`，接收方校验 5 分钟时间窗。
- 投递走现有 `background-jobs.ts`，失败指数退避（1m、5m、30m、2h、12h），5 次后停，后台可手动重投。
- 触发点：`confirm-store-order.ts`（paid）、`fulfill-store-order.ts`（delivered）、refund 路由、`driveRechargeOrder` 终态、`agent_earnings` 写入处。

### 3.8 文档与管理界面

- `apps/web/src/lib/open-api/spec.ts` 手写 OpenAPI 3.1 对象，`GET /api/v1/open/openapi.json` 输出；`/docs/api` 页面用 Scalar 或 Redoc 渲染。
- 超管后台新增「开放 API」页：Key 列表 / 新建（选 scope、IP 白名单、过期时间）/ 吊销 / 调用日志 / Webhook 配置与投递记录。
- 代理后台同样一页，只管自己的 Key 和 Webhook。

### 3.9 目录结构

```
apps/web/src/lib/open-api/
  auth.ts          // requireApiKey
  errors.ts        // 错误码 + toResponse
  respond.ts       // ok() / list() / fail()，统一 request_id
  idempotency.ts
  serializers.ts   // DB 行 → 对外字段（白名单式，绝不整行透出）
  webhooks.ts      // 出站投递
  spec.ts
apps/web/src/app/api/v1/open/
  plans/route.ts
  orders/route.ts
  orders/[orderNo]/route.ts
  cdks/route.ts
  cdks/[id]/route.ts
  cdks/[id]/reveal/route.ts
  redemptions/route.ts
  redemptions/[no]/route.ts
  earnings/route.ts
  settlements/route.ts
  agents/route.ts
  openapi.json/route.ts
```

### 3.10 实施顺序

1. `api_keys` 表 + `auth.ts` + `respond.ts` + `errors.ts` + 后台 Key 管理页。
2. 只读接口：plans、orders、cdks、redemptions 查询、earnings。
3. 写接口：redemptions 提交（接 redeem-guard）、orders 代下单 + 幂等。
4. Webhook。
5. OpenAPI 文档页。

**验收**

- 代理 A 的 Key 查代理 B 的订单返回 404（不是 403，避免泄露存在性）。
- 吊销 Key 后下一次请求 401。
- 同一 `Idempotency-Key` 重复提交兑换，只建一笔 RC 单。
- serializer 单测：订单详情不含 `query_token_hash`、`code_encrypted`、`settlement_account_encrypted` 等内部字段。
- Webhook 签名可用文档里的示例代码验证通过。

---

## 4. 代理明细显示真实身份

### 4.1 现状

`agents.display_name` 是**店铺名**。代理在自己后台「店铺装修」里改店名时，`apps/web/src/app/api/agent/storefront/route.ts` 会直接 `update agents set display_name = 店名`。于是收益统计、结算、卡密查询、导出 Excel 里看到的都是代理随时能改的店名（截图里的「gpt代充站」「小浣熊的店」），无法对应到具体的人。

真实身份其实已有：

- `users.username`：登录名，建号时超管填的，唯一，代理不能改。
- `agents.settlement_name` / `settlement_method` / `settlement_account_encrypted`：收款人、收款方式、收款账号。
- `agents.id`：稳定主键。

### 4.2 改法

**4.2.1 拆开「店名」和「身份」**

新增列：

```sql
ALTER TABLE agents ADD COLUMN shop_name TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN real_name TEXT NOT NULL DEFAULT '';   -- 超管备注的真实姓名/称呼，仅后台可见
```

迁移：`UPDATE agents SET shop_name = display_name WHERE shop_name = ''`。

- 代理改店名 → 只写 `shop_name`（改 `storefront/route.ts`）。店铺前台、代理后台标题都读 `shop_name`。
- `display_name` 回归「超管给代理起的内部显示名」，只有超管能改（`admin/agents/[id]/route.ts` 已支持）。迁移时保持原值，超管可自行修正。
- `real_name` 超管在代理管理页填写。

需要全局替换读取点（`rg "displayName" apps/web/src`）：前台/店铺相关的读 `shop_name`，后台/统计/结算相关的读身份字段。

**4.2.2 统一的后台身份展示**

新增 `apps/web/src/lib/agent-identity.ts`：

```ts
export type AgentIdentity = {
  agentId: number;
  username: string;        // users.username
  displayName: string;     // agents.display_name（超管定）
  realName: string;        // agents.real_name
  shopName: string;        // agents.shop_name（代理定）
  settlementName: string;  // agents.settlement_name
};
export function agentIdentityLabel(i: AgentIdentity): string
// 主文本：realName || settlementName || displayName || username
// 副文本：@username · 店铺：shopName
```

以及一个 drizzle 片段：`agents` left join `users on users.agent_id = agents.id and users.role = 'agent'`，一次查出上面全部字段。

**4.2.3 需要改的地方**

| 页面 / 接口 | 文件 | 改动 |
| --- | --- | --- |
| 收益统计 · 代理明细 | `app/api/admin/earnings/stats/route.ts`、`lib/earnings-stats-core.ts`、`components/admin-earnings-stats.tsx` | 聚合已经按 `agentId`，不用动；把 `agentName: string` 换成 `AgentIdentity` 返回；表格「代理」列显示主文本 + 副文本，新增「收款人」「收款方式」列 |
| 收益导出 | `app/api/admin/earnings/export.xlsx/route.ts` | 增加列：代理ID、登录名、真实姓名、店名、收款人、收款方式、收款账号（解密） |
| 结算 | `app/api/admin/settlements/route.ts` 及对应页面 | 同上，结算确认弹窗显示收款人 + 收款账号 |
| 卡密查询 | `app/api/admin/route.ts` `section === "cdks"` | 代理列改用身份标签 |
| 用量统计 | `lib/usage-stats.ts` | 同上 |
| 代理管理 | `app/api/admin/agents/route.ts`、`[id]/route.ts` 及页面 | 列表显示登录名、真实姓名、店名；编辑可改 `display_name`、`real_name` |
| 代理自己的导出 | `app/api/agent/earnings/export.xlsx/route.ts` | 用 `shop_name`，不暴露 `real_name` |

**4.2.4 店名修改留痕**

代理改店名时写 `audit_logs`（旧值 → 新值）。代理管理页显示「曾用店名」。

**验收**

- 代理在后台把店名从 A 改成 B，超管的收益统计里该代理行仍显示同一个人（主文本不变），副文本店名变成 B。
- 两个代理把店名改成一样，统计里仍是两行。
- 导出的 Excel 能直接用来打款：每行有收款人、收款方式、收款账号。
- 代理后台和店铺前台看不到 `real_name`。

---

## 5. 总体实施顺序与拆分建议

建议拆成 4 个 PR，按顺序合：

1. **PR1 订单卡密关系**（第 1 章）：迁移 + 回填脚本 + 后台列表修正 + 标签。改动小，先上线，立刻修复卡密列为空。
2. **PR2 兑换防刷**（第 2 章）：redeem-guard + 本地先判 + 批量按张计 + 两段式抢锁 + 拦截记录页。依赖 PR1 的 `orders.issued_cdk_id`。
3. **PR3 代理身份**（第 4 章）：和 PR1/PR2 无依赖，可并行。
4. **PR4 开放 API**（第 3 章）：依赖 PR1（兑换记录）、PR2（redeem-guard）、PR3（代理身份字段）。内部再按 3.10 分步。

每个 PR 都要：

- 迁移写在 `apps/web/src/db/migrate-lib.ts`，幂等（`IF NOT EXISTS` / 先查列再 `ALTER`），和现有写法一致。
- 纯逻辑放 `*-core.ts` 并配 vitest 单测，沿用仓库现有 `*.test.ts` 风格。
- 不改变现有前端内部接口的返回结构（只加字段），避免前台回归。

## 6. 上线后立刻可做的运维动作（不依赖代码）

- 确认反向代理配置和 `KAIMI_TRUSTED_PROXY_HOPS` / `KAIMI_CLIENT_IP_HEADER` 一致；走 Cloudflare 的话设 `KAIMI_CLIENT_IP_HEADER=cf-connecting-ip`，否则限流可能全部落在同一个代理 IP 上，或者被伪造 XFF 绕过。
- 在 Cloudflare / Nginx 层对 `/api/public/cdk/*`、`/api/recharge/*` 加一条速率规则作为兜底。
