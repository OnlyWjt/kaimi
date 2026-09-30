# 代理自助提卡 + 提卡账本 详细设计

> 状态：设计稿。分支 `feat/agent-self-draw` 上已有部分未提交代码（表结构、迁移、纯函数与单测、通知格式化），见 §16.9；其余实现暂停，等设计确认
> 日期：2026-09-30（同日第二版：接入付款地区，新增 §16，并更新 §5、§7.6、§9、§10 中受影响的部分）
> 地区相关：`docs/agent-region-cdk-design.md`（地区命名、徽标、发卡目标翻译都以那份为准）
> 读者：后续负责实现的开发者 / AI。本文力求「照着做就能落地」，每个决定都写了理由，改动点精确到文件。
> 相关文档：`docs/多代理即时发卡系统详细设计.md`、`docs/agent-earnings-ledger-design.md`

---

## 0. 一句话概述

代理向平台**申请开通**「自助提卡」→ 平台收到 **Telegram 通知**、线下沟通后在后台**审批并设定额度** → 代理获得一条**专属提卡链接**，登录后点一下即可从卡台直接取卡（不走买家支付）→ 每张卡按**代理成本价**记入该代理的**未结算账本** → 平台定期在后台新 Tab「提卡账本」里查看每个代理的未结算卡密，代理转账后，平台勾选并**标记为已结算**，生成一张结算账单；之后新提的卡又进入新的未结算周期。

### 0.1 术语

| 术语 | 含义 |
|---|---|
| 自助提卡 / 提卡 | 代理不经买家支付，直接从平台拿卡密（先拿后付，赊账） |
| 提卡权限 | 代理是否被允许提卡，以及额度、上限等参数。一个代理一行 |
| 提卡申请 | 代理发起的开通请求，保留历史 |
| 提卡单 | 代理点一次「生成」产生的一笔记录，可含多张卡 |
| 提卡明细 / 账本行 | 每张卡一行，承载金额和结算状态 |
| 结算账单 | 管理员一次「标记已结算」生成的记录，包含若干账本行 |
| 未结算敞口 | 代理当前欠平台的钱 = 未结算账本行金额 + 正在出卡中的提卡单预占金额 |
| 专属链接 | `/agent/draw/{token}`，每个已开通代理唯一 |

---

## 1. 目标与非目标

### 1.1 目标

1. 代理后台新增「自助提卡」入口；未开通时只能看到申请页，**必须由平台审批**才能使用。
2. 代理提交申请时，**立即推送 Telegram 通知**给平台（复用现有通知通道）。
3. 审批通过后，每个代理有一条**唯一的提卡链接**，登录后点一次按钮即可生成卡密。
4. 每张卡按成本计价，进入该代理的**未结算账本**。
5. 管理后台新增一个 Tab，可**按代理单独查看未结算卡密**、勾选后**标记为已结算**，形成结算账单；之后新的卡继续累计为未结算。
6. 提出的卡密能在现有兑换页 `/recharge` 正常兑换（和商城卖出的卡密一样）。
7. 风险可控：额度、每日上限、单次上限、并发控制、卡台异常时不重复扣卡、不丢卡。

### 1.2 非目标（一期不做）

- **不做在线支付结算**。代理怎么转账（支付宝 / USDT / 银行卡）完全线下，平台只在后台登记。
- **不做代理自主「结清」**。代理不能自己把账单改成已结算，只有管理员能。
- **不做本地成品号（`fulfillment_kind = local_account`）的提卡**。只支持卡台发卡的套餐。理由：成品号库存有限，走商城更可控；需要时再单独立项。
- **不做已结算卡密的作废/退款**。已结算的卡如需补偿，一期线下处理（见 §7.7 的二期预留）。
- **不做代理端 Telegram 通知**。系统里没有代理的 TG 绑定，平台自己跟代理聊。
- **不做开放 API 提卡**。一期只能在网页上点。

---

## 2. 与现有系统的关系（实现前必读）

### 2.1 资金方向相反，不能复用现有结算

| | 现有：商城收益结算 | 新增：提卡账本 |
|---|---|---|
| 谁先收钱 | 平台（买家付给平台） | 没人收钱，代理先拿卡 |
| 谁欠谁 | **平台欠代理**（收益） | **代理欠平台**（成本） |
| 数据来源 | `store_orders` → `agent_earnings` | 新表 `agent_draw_orders` → `agent_draw_items` |
| 结算单 | `agent_settlements`（平台打款给代理） | 新表 `agent_draw_bills`（代理转账给平台） |
| 金额口径 | `券后商品额 − 成本 − 代理手续费` | `单价 × 张数`，单价 = 代理成本价（或提卡专用价） |

**结论**：新建一套表和接口，**不要**往 `agent_earnings` / `agent_settlements` 里塞负数或加类型字段。理由：
- 现有结算单有「净额必须 > 0」「逐单验算 `verifyLedger`」「按 confirmedAt 周期」等规则，都是为商城订单设计的，混进来会互相污染。
- 两边的对账对象、审批人动作、展示文案全都不一样。

> 二期可以考虑「商城收益与提卡欠款互相抵扣」，但一期明确不做，两本账独立。

### 2.2 卡密必须写进 `issued_cdks`

兑换页 `/recharge` 靠 `findIssuedCdkByCode`（`lib/cardplatform/issued-redemption.ts`）按 `code_hash` 在 `issued_cdks` 里认卡。所以**提卡出来的卡也必须插入 `issued_cdks`**，否则兑换不了。

`issued_cdks.order_id` 是 `NOT NULL`，而提卡没有 `store_orders` 行。方案：

- 提卡的卡写 `order_id = 0`，新增列 `source = 'draw'` 和 `draw_order_id`。
- 现有所有 `innerJoin(storeOrders, eq(storeOrders.id, issuedCdks.orderId))` 的查询会**天然排除**提卡的卡。这正是我们要的：代理「已售卡密」页、开放 API `/api/v1/open/cdks` 都只显示商城卖出的卡。
- 需要显式改的只有少数几处（见 §11），比如管理员「卡密查询」要能搜到提卡的卡、兑换通知要能识别提卡的卡。

已核对：所有按 `issuedCdks.orderId = X` 查询的地方，`X` 都来自真实的 `store_orders.id`（从 1 开始自增），不会误匹配到 `0`。

### 2.3 复用的现有能力

| 能力 | 位置 | 用法 |
|---|---|---|
| 卡台出卡 | `CardplatformClient.issueMany(plan, count, idempotencyKey, pref)`（`lib/cardplatform/client.ts:225`） | 直接调用，单次最多 `MAX_ISSUE_COUNT = 200` |
| 卡台账户选择 | `getDefaultCardplatformAccount()` / `getCardplatformClientById()` | 提卡用默认账户，账户 ID 快照到提卡单 |
| 出卡偏好 | `issuePrefFromAccount(accountId)`（`lib/cardplatform/policy`） | 与商城发卡一致 |
| 幂等键续发 | `issueIdempotencyKey(base, alreadyIssued, emptyResponses)`（`lib/fulfillment/issue-keys.ts`） | 部分出卡 / 超时后续发，规则与商城一致 |
| 加密与哈希 | `encryptSecret` / `decryptSecret` / `hashLookupValue` / `maskCode`（`lib/crypto.ts`） | 卡密加密存储、按 hash 去重 |
| 单号 | `newOrderNo(prefix)`（`lib/ids.ts`） | 提卡单 `DR…`，结算账单 `DB…` |
| 通知 | `dispatchNotifyText(text, extra, event, overrides, telegramHtml)`（`lib/notify.ts`） | 发 TG + webhook |
| 售卖总闸 | `assertStoreSalesOpen()`（`lib/ops-health.ts`） | 卡台余额不足等情况关店时，提卡也一起关 |
| 审计 | `writeAuditLog`（`lib/audit`） | 所有管理员动作、代理提卡都写 |
| 鉴权 | `requireAgent()` / `requireAdmin()`（`lib/auth.ts`） | |
| 迁移 | `migrate-lib.ts` 的 `CREATE TABLE IF NOT EXISTS` + `addColumn`（吞 duplicate column） | 新增 `ensureAgentDrawSchema()` |
| 后台任务 | `background_jobs` 表 + `lib/background-jobs.ts` | 超时提卡单自动找回 |

---

## 3. 业务流程

### 3.1 权限状态机（每个代理一份）

```
            代理提交申请                    管理员通过
  none ──────────────────▶ pending ──────────────────▶ approved
   ▲                        │  ▲                          │  ▲
   │                        │  │ 代理重新申请              │  │ 管理员恢复
   │           管理员拒绝    ▼  │ （冷却 24h 后）           ▼  │
   │                      rejected                     suspended
   │                                                      │
   └──────────── 管理员「关闭提卡」（清空，回到 none）◀────┘
```

| 状态 | 代理看到 | 能否提卡 | 能否看账本 |
|---|---|---|---|
| `none` | 介绍 + 申请表单 | 否 | 否（没有数据） |
| `pending` | 「申请已提交，等待平台联系」+ 提醒按钮 | 否 | 否 |
| `rejected` | 拒绝原因 + 冷却倒计时 / 重新申请 | 否 | 若曾开通过则可看 |
| `approved` | 提卡台 + 账本 | **是** | 是 |
| `suspended` | 「提卡已暂停，请联系平台」+ 账本 | 否 | 是 |

额外约束：`agents.status = 'disabled'` 或 `users.status = 'disabled'` 时，无论权限状态如何都不能提卡（代理本来也登录不了）。

### 3.2 申请与审批时序

```
代理                        系统                               平台（你）
 │ 打开「自助提卡」          │                                    │
 │─────────────────────────▶│ 状态 none → 显示申请表单             │
 │ 填联系方式/说明，提交      │                                    │
 │─────────────────────────▶│ 写 agent_draw_applications         │
 │                          │ 权限 → pending                      │
 │                          │ 发 TG：「代理 X 申请开通自助提卡」──▶│ 收到通知
 │ 看到「等待平台联系」       │                                    │ 在 TG 上和代理沟通
 │                          │                                    │ 后台「提卡账本 › 申请」
 │                          │◀───────────────────────────────────│ 通过：设额度/上限/套餐
 │                          │ 权限 → approved，生成 link_token     │
 │ 刷新后看到专属链接+提卡台  │                                    │
```

### 3.3 提卡时序（点一下生成）

```
代理浏览器                   服务端                                        卡台
 │ 选套餐、张数，点「生成」     │                                              │
 │ 弹窗确认：Plus × 3 = ¥375  │                                              │
 │ 带 requestId（UUID）POST ──▶│ ① 鉴权：登录代理 == token 所属代理           │
 │                            │ ② 事务内：校验权限/套餐/额度/日上限/并发      │
 │                            │    插入提卡单 status=issuing（预占额度）      │
 │                            │ ③ 事务外：issueMany(plan, 3, key) ─────────▶│
 │                            │◀──────────────────────────────── 返回 3 张卡 │
 │                            │ ④ 事务内：写 issued_cdks(source=draw)         │
 │                            │    写 agent_draw_items（每张一行，unsettled） │
 │                            │    提卡单 → delivered                        │
 │                            │ ⑤ 发 TG（可关）                              │
 │◀─── 返回卡密明文 ───────────│                                              │
 │ 弹窗展示卡密，一键复制/下载  │                                              │
```

### 3.4 结算时序

```
平台                                          系统
 │ 「提卡账本」→ 选中代理 A                     │
 │ 看到未结算 12 张，合计 ¥1,500                │
 │ 点「复制对账文本」，发给代理（TG）             │
 │ 代理转账 ¥1,500                              │
 │ 勾选这 12 张（默认全选），点「标记已结算」──▶│ 校验：都属于 A、都未结算、合计 = ¥1,500
 │ 填收款方式、流水号                            │ 生成账单 DB…，12 行 → settled
 │                                              │ 写审计日志
 │ 之后 A 新提的卡 → 新的未结算                   │
```

---

## 4. 已定的业务决策（默认值，实现时可配置）

> 标「✅ 已确认」的是产品方已拍板的决策，实现时不要改；其余是默认值，可配置。标 ⚠️ 的仍待确认。

| # | 决策 | 默认 | 理由 |
|---|---|---|---|
| D1 ✅ 已确认 | 计价 | 单价默认 = **代理成本价**（`agent_plan_prices.cost_override_cents ?? platform_plans.global_cost_price_cents`），提卡时快照 | 产品方确认：提卡单价默认就是成本价；和商城同一个成本口径，代理不会困惑 |
| D2 | 提卡专用价 | 保留按「代理 × 套餐」单独设提卡价的能力，**默认留空 = 用 D1 成本价**。审批弹窗里这一列默认空着，不需要填 | 预留给个别代理特殊定价；不填就是成本价，不增加日常操作 |
| D3 | 何时记账 | **卡台出卡成功即记账**，不管代理之后用没用 | 卡台出卡时平台就已经付了上游的钱 |
| D4 ✅ 已确认 | 信用额度 | 每个代理单独设置，**默认 ¥3,000**（审批弹窗预填 3000.00，可改，必须 > 0）。未结算敞口 + 本次金额 > 额度 → 拒绝 | 产品方确认：可设置，默认 3000；赊账没有额度就是无限风险 |
| D5 | 每日张数上限 | 可选，默认不限（0） | 防止账号被盗后被刷 |
| D6 | 单次最多张数 | 默认 10，最大 200（卡台单次上限） | 点一下出一堆容易误操作 |
| D7 | 可提套餐 | 审批时勾选；默认 = 该代理已分配、平台已启用、卡台可售的全部套餐 | |
| D8 | 并发 | 同一代理同一时刻只允许 1 笔提卡单处于 `issuing` | 防止连点、防止额度穿透 |
| D9 ✅ 已修订 | 专属链接的作用 | **只要登录**。`link_token` 列保留，不校验、不展示。拦住被盗账号的是上限、单次张数、每次提卡通知和暂停 | 2026-09-30 改为只要登录，见 `docs/agent-self-draw-v2-design.md` §7 |
| D10 | 重置链接 | 管理员可一键重置，旧链接立即失效 | 链接外泄时止损 |
| D11 | 作废 | 管理员可作废**未结算且未使用**的卡：先调卡台删卡退款，成功后该行不计费 | 代理误提时的补救 |
| D12 | 结算方式 | 管理员勾选若干未结算行 → 标记已结算，生成账单。支持部分结算 | 代理可能只转了一部分 |
| D13 | 撤销结算 | 账单生成后 **7 天内**可撤销，行退回未结算 | 手滑点错时能改 |
| D14 ⚠️ | 每次提卡是否通知 TG | 设置项，默认**开** | 你说会定期查；初期建议开，量大了再关 |
| D15 | 额度预警 | 未结算敞口 ≥ 额度 80% 时发一次 TG（每个结算周期只发一次） | 提醒你去催款 |
| D16 | 重新申请冷却 | 被拒后 24 小时才能再申请；`pending` 状态下「提醒平台」按钮 6 小时一次 | 防骚扰 |
| D17 | 暂停时的欠款 | 暂停/关闭提卡**不影响**已有未结算账，账本照常可看、可结算 | |

---

## 5. 数据模型

所有金额单位为**分**（整数），时间为 ISO 字符串（与 `agent_earnings` 等新表一致，用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`）。

### 5.1 新表 `agent_draw_access`（提卡权限，一代理一行）

```sql
CREATE TABLE IF NOT EXISTS agent_draw_access (
  agent_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'none',            -- none | pending | approved | rejected | suspended
  link_token TEXT,                                -- 专属链接 token；未开通为 NULL
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,  -- 信用额度，approved 时必须 > 0
  daily_limit_count INTEGER NOT NULL DEFAULT 0,   -- 每日最多张数，0 = 不限
  max_per_draw INTEGER NOT NULL DEFAULT 10,       -- 单次最多张数，1..200
  allowed_plan_keys_json TEXT NOT NULL DEFAULT '[]', -- 可提套餐；空数组 = 按 D7 默认规则
  notify_each_draw INTEGER NOT NULL DEFAULT 1,    -- 该代理每次提卡是否通知（全局开关之外的单代理开关）
  credit_warned_at TEXT,                          -- 最近一次额度预警时间；结算后清空
  reject_reason TEXT NOT NULL DEFAULT '',         -- 展示给代理
  admin_note TEXT NOT NULL DEFAULT '',            -- 只有管理员可见
  approved_at TEXT,
  approved_by INTEGER,
  suspended_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_draw_access_token_uq ON agent_draw_access(link_token);
```

- `link_token`：24 位，字母表同 `lib/ids.ts`（`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`，去掉易混字符），用 `customAlphabet(…, 24)` 生成。**明文存储**：因为代理和管理员都要看到完整链接，且单独拿到 token 没有用（见 D9）。
- SQLite 唯一索引允许多个 NULL，所以未开通代理的 `NULL` 不冲突。

### 5.2 新表 `agent_draw_applications`（申请历史）

```sql
CREATE TABLE IF NOT EXISTS agent_draw_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  contact TEXT NOT NULL DEFAULT '',          -- 代理填的 TG 用户名 / 微信等，必填
  expected_monthly TEXT NOT NULL DEFAULT '', -- 预计月用量档位：lt50 | 50_200 | 200_1000 | gt1000
  note TEXT NOT NULL DEFAULT '',             -- 申请说明，≤ 500 字
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected | cancelled
  review_note TEXT NOT NULL DEFAULT '',      -- 审批时的说明（拒绝原因会同步到 access.reject_reason）
  reviewed_by INTEGER,
  reviewed_at TEXT,
  notify_status TEXT NOT NULL DEFAULT '',    -- sent | failed | unsent
  notify_error TEXT NOT NULL DEFAULT '',
  last_reminded_at TEXT,                     -- 代理点「提醒平台」的时间
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS agent_draw_applications_agent_idx ON agent_draw_applications(agent_id, created_at);
CREATE INDEX IF NOT EXISTS agent_draw_applications_status_idx ON agent_draw_applications(status);
```

同一代理同一时刻最多一条 `pending`（应用层在事务里保证）。

### 5.3 新表 `agent_draw_orders`（提卡单，点一次一行）

```sql
CREATE TABLE IF NOT EXISTS agent_draw_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_no TEXT NOT NULL,                     -- newOrderNo("DR")
  agent_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,                  -- 前端生成的 UUID，防重复提交
  plan_id INTEGER NOT NULL,
  plan_key_snapshot TEXT NOT NULL,           -- 地区变体 key，如 plus:us
  plan_name_snapshot TEXT NOT NULL,          -- 基础套餐名，如 Plus（不含地区）
  upstream_plan_key_snapshot TEXT NOT NULL DEFAULT '',  -- 发给卡台的 plan；空 = 用 plan_key_snapshot（§16.2）
  payment_country_snapshot TEXT NOT NULL DEFAULT '',    -- 卡台 payment_country；空 = 菲区，发码不传
  region_label_snapshot TEXT NOT NULL DEFAULT '',       -- 下单时的地区中文名，如 美区；账本/账单显示用
  quantity INTEGER NOT NULL,                 -- 请求张数
  issued_count INTEGER NOT NULL DEFAULT 0,   -- 实际出了几张
  unit_price_cents INTEGER NOT NULL,         -- 计费单价快照
  price_source TEXT NOT NULL,                -- draw_override | agent_cost | global_cost
  upstream_cost_unit_cents INTEGER,          -- 上游进价快照，给管理员看毛利；NULL = 未配置
  cardplatform_account_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,             -- 基础幂等键 = "draw:" + draw_no
  status TEXT NOT NULL DEFAULT 'issuing',    -- issuing | delivered | partial | failed | unknown
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  client_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_draw_orders_no_uq ON agent_draw_orders(draw_no);
CREATE UNIQUE INDEX IF NOT EXISTS agent_draw_orders_request_uq ON agent_draw_orders(agent_id, request_id);
CREATE INDEX IF NOT EXISTS agent_draw_orders_agent_created_idx ON agent_draw_orders(agent_id, created_at);
CREATE INDEX IF NOT EXISTS agent_draw_orders_status_idx ON agent_draw_orders(status);
```

状态含义：

| 状态 | 含义 | 是否占额度 |
|---|---|---|
| `issuing` | 正在向卡台取卡 | 是，按 `(quantity − issued_count) × unit_price` 预占 |
| `delivered` | 全部出齐 | 否（已转为账本行） |
| `partial` | 只出了一部分，剩余放弃 | 否 |
| `failed` | 卡台**明确**失败，一张没出 | 否 |
| `unknown` | 超时 / 结果未知，卡台可能已扣卡 | **是**，直到找回或人工处理 |

### 5.4 新表 `agent_draw_items`（账本行，一张卡一行）

```sql
CREATE TABLE IF NOT EXISTS agent_draw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_order_id INTEGER NOT NULL,
  issued_cdk_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  plan_key TEXT NOT NULL,
  payment_country TEXT NOT NULL DEFAULT '',  -- 冗余自提卡单快照，账本按地区筛选/汇总不用 join（§16.2）
  amount_cents INTEGER NOT NULL,             -- = 提卡单 unit_price_cents
  upstream_cost_cents INTEGER,               -- 快照，管理员看毛利用
  status TEXT NOT NULL DEFAULT 'unsettled',  -- unsettled | settled | void
  bill_id INTEGER,                           -- settled 时指向 agent_draw_bills.id
  void_reason TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  voided_by INTEGER,
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_draw_items_cdk_uq ON agent_draw_items(issued_cdk_id);
CREATE INDEX IF NOT EXISTS agent_draw_items_agent_status_idx ON agent_draw_items(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS agent_draw_items_bill_idx ON agent_draw_items(bill_id);
CREATE INDEX IF NOT EXISTS agent_draw_items_order_idx ON agent_draw_items(draw_order_id);
```

**为什么账本按张而不是按提卡单**：作废是按张的（一单 5 张可能只作废 1 张），部分结算也可能按张。按张记账，任何操作都不需要拆单。

### 5.5 新表 `agent_draw_bills`（结算账单）

```sql
CREATE TABLE IF NOT EXISTS agent_draw_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT NOT NULL,                      -- newOrderNo("DB")
  agent_id INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  first_item_at TEXT NOT NULL,                -- 本账单最早一张卡的提卡时间
  last_item_at TEXT NOT NULL,                 -- 最晚一张
  summary_json TEXT NOT NULL DEFAULT '[]',    -- 按套餐×地区×单价汇总快照 [{planKey, planName, paymentCountry, regionLabel, count, unitPriceCents, amountCents}]
  payment_method TEXT NOT NULL DEFAULT '',    -- alipay | wechat | usdt | bank | other
  payment_reference TEXT NOT NULL DEFAULT '', -- 流水号 / 交易哈希
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'settled',     -- settled | reverted
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reverted_at TEXT,
  reverted_by INTEGER,
  revert_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_draw_bills_no_uq ON agent_draw_bills(bill_no);
CREATE INDEX IF NOT EXISTS agent_draw_bills_agent_created_idx ON agent_draw_bills(agent_id, created_at);
```

### 5.6 现有表加列

```sql
-- issued_cdks：区分来源
ALTER TABLE issued_cdks ADD COLUMN source TEXT NOT NULL DEFAULT 'store';  -- store | draw
ALTER TABLE issued_cdks ADD COLUMN draw_order_id INTEGER;                  -- source=draw 时有值
CREATE INDEX IF NOT EXISTS issued_cdks_draw_order_idx ON issued_cdks(draw_order_id);

-- agent_plan_prices：提卡专用价（D2）
ALTER TABLE agent_plan_prices ADD COLUMN draw_price_cents INTEGER;         -- NULL = 用代理成本价
```

提卡的卡写入 `issued_cdks` 时：`order_id = 0`、`source = 'draw'`、`draw_order_id = 提卡单 id`，其余字段（`agent_id`、`plan_key`、`code_encrypted`、`code_hash`、`code_prefix`、`cardplatform_account_id`、`upstream_ref`、`upstream_fee_minor`、`status='unused'`）与商城发卡完全一致。

`issued_cdks.payment_country` 列由地区设计新增（地区文档 §5.3）。提卡写卡时同样填**本次实际传给卡台的地区**。如果提卡先于地区功能合并，这一列就由提卡的迁移先加上（`addColumn` 幂等，两边谁先跑都行）。

### 5.7 新增 settings 键

| key | 默认 | 说明 |
|---|---|---|
| `draw_enabled` | `1` | 全局总开关。关掉后所有代理都不能提卡（账本可看） |
| `draw_notify_each` | `1` | 每次提卡是否发 TG（D14），与单代理开关取「与」 |
| `draw_default_credit_cents` | `300000` | 审批弹窗里额度的默认值（¥3,000，见 D4） |
| `draw_default_max_per_draw` | `10` | 审批弹窗默认单次上限 |
| `draw_agent_notice` | 空 | 管理员写给所有代理的提卡须知（Markdown 纯文本），显示在代理提卡页顶部 |

### 5.8 Drizzle 定义

在 `apps/web/src/db/schema.ts` 末尾按现有风格新增 `agentDrawAccess`、`agentDrawApplications`、`agentDrawOrders`、`agentDrawItems`、`agentDrawBills` 五个表；给 `issuedCdks` 加 `source`、`drawOrderId`；给 `agentPlanPrices` 加 `drawPriceCents`。字段名与上面 SQL 一一对应（驼峰）。

### 5.9 迁移

在 `migrate-lib.ts` 新增 `ensureAgentDrawSchema()`，由 `ensureSchema()` 调用：

1. 执行 §5.1–5.5 的 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。
2. 用与 `ensureOrderLedgerSchema` 相同的 `addColumn`（吞 `duplicate column`）执行 §5.6。
3. 无数据回填（历史 `issued_cdks` 默认 `source='store'` 即正确）。
4. 幂等，可重复执行。

---

## 6. 计价与额度规则

### 6.1 单价解析（纯函数，放 `lib/agent-draw-core.ts`）

```ts
export type DrawPriceInput = {
  drawPriceCents: number | null;       // agent_plan_prices.draw_price_cents
  costOverrideCents: number | null;    // agent_plan_prices.cost_override_cents
  globalCostPriceCents: number;        // platform_plans.global_cost_price_cents
};

export function resolveDrawUnitPrice(p: DrawPriceInput):
  { unitPriceCents: number; source: "draw_override" | "agent_cost" | "global_cost" } | null {
  if (p.drawPriceCents != null && p.drawPriceCents > 0) return { unitPriceCents: p.drawPriceCents, source: "draw_override" };
  if (p.costOverrideCents != null && p.costOverrideCents > 0) return { unitPriceCents: p.costOverrideCents, source: "agent_cost" };
  if (p.globalCostPriceCents > 0) return { unitPriceCents: p.globalCostPriceCents, source: "global_cost" };
  return null; // 价格未配置 → 该套餐不可提
}
```

注意：商城里 `cost_override_cents` 为 `NULL` 才回退全局，`0` 会被当成有效值。提卡这里**把 0 也视为未配置**，避免免费提卡。

### 6.2 可提套餐判定

某套餐对某代理可提，当且仅当：

1. `platform_plans.enabled = 1` 且 `cardplatform_sellable = 1` 且 `fulfillment_kind = 'cardplatform'`；
2. 存在 `agent_plan_prices(agent_id, plan_id)` 行（代理已被分配该套餐；**不要求** `enabled = 1`，那个字段表示代理是否在店里上架，与提卡无关）；
3. `allowed_plan_keys_json` 为空数组，或包含该 `plan_key`；
4. `resolveDrawUnitPrice` 返回非空；
5. 该行 `payment_country` 非空（美区、智利区等）时，默认卡台账户必须支持付款地区（`accountSupportsPaymentCountry`，地区文档 §6.4）。

判定单位是**地区变体行**：`plus`（菲区）和 `plus:us`（美区）是两个独立的可提套餐，各有各的价格、白名单项。详见 §16.3。

### 6.3 敞口与额度

```
未结算金额   = Σ agent_draw_items.amount_cents  WHERE agent_id=? AND status='unsettled'
在途预占     = Σ (quantity − issued_count) × unit_price_cents
                 FROM agent_draw_orders WHERE agent_id=? AND status IN ('issuing','unknown')
敞口         = 未结算金额 + 在途预占
可用额度     = credit_limit_cents − 敞口
本次金额     = unit_price_cents × quantity
允许         ⇔ 本次金额 ≤ 可用额度
```

### 6.4 每日上限

「今天」按 **Asia/Shanghai** 自然日（复用 `lib/period.ts` 或 `lib/datetime.ts` 里已有的时区处理，不要自己拼）。

```
今日已提 = count(agent_draw_items WHERE agent_id=? AND status != 'void' AND created_at >= 今日0点UTC)
         + Σ (quantity − issued_count) of issuing/unknown 提卡单
允许     ⇔ daily_limit_count = 0 或 今日已提 + quantity ≤ daily_limit_count
```

作废的卡不占日上限。

---

## 7. 核心流程详细

### 7.1 提交申请 `POST /api/agent/draw/apply`

入参（zod）：

```ts
{
  contact: string,           // 1..100，必填
  expectedMonthly: "lt50" | "50_200" | "200_1000" | "gt1000",
  note?: string              // 0..500
}
```

处理：

1. `requireAgent()`；读取 `agent_draw_access`（没有就视为 `none`）。
2. 状态检查：
   - `approved` / `suspended` → 409「已开通，无需申请」/「已暂停，请联系平台」；
   - `pending` → 409「已有申请在处理中」；
   - `rejected` 且距 `reviewed_at` 不满 24h → 429「请在 X 小时后再申请」。
3. 事务：插入 `agent_draw_applications(status=pending)`；upsert `agent_draw_access.status = 'pending'`。
4. 事务外发 TG（§9.1），把结果写回 `notify_status` / `notify_error`。**通知失败不影响申请成功**，但后台申请列表要显示「通知失败」红标，方便你发现。
5. 审计：`agent.draw.apply`。
6. 返回最新状态。

### 7.2 提醒平台 `POST /api/agent/draw/remind`

- 仅 `pending` 可用；距 `last_reminded_at`（或 `created_at`）不满 6h → 429。
- 重发一条 TG（标题改为「代理 X 催审批：自助提卡」），更新 `last_reminded_at`。

### 7.3 审批

`POST /api/admin/draw/applications/[id]/approve`：

```ts
{
  creditLimitCents: number,     // > 0，必填
  dailyLimitCount: number,      // >= 0
  maxPerDraw: number,           // 1..200
  allowedPlanKeys: string[],    // 可空 = 全部可提套餐
  drawPrices?: Array<{ planKey: string; drawPriceCents: number | null }>, // D2，可选
  notifyEachDraw: boolean,
  adminNote?: string
}
```

事务内：
1. 申请必须是 `pending`；
2. 申请 → `approved`，写 `reviewed_by/at`；
3. `agent_draw_access`：`status='approved'`，写参数；若 `link_token` 为空则生成；`approved_at/by`；清空 `reject_reason`；
4. 写入 `agent_plan_prices.draw_price_cents`（只更新传了的套餐；该代理没有这行套餐时报错，不自动建行）；
5. 审计 `admin.draw.approve`，metadata 带全部参数。

`POST /api/admin/draw/applications/[id]/reject`：`{ reason: string(1..200) }` → 申请 `rejected`，access `rejected` + `reject_reason`。审计。

> 审批后**不自动通知代理**（代理没绑 TG）。代理下次打开页面即可看到。你在 TG 上顺口告诉他即可。

### 7.4 权限管理（审批后）

`PATCH /api/admin/draw/access/[agentId]`：可改额度、日上限、单次上限、可提套餐、提卡价、通知开关、备注。

`POST /api/admin/draw/access/[agentId]/action`：`{ action: "suspend" | "resume" | "reset_link" | "close" }`

| action | 效果 |
|---|---|
| `suspend` | `approved → suspended`，写 `suspended_at` |
| `resume` | `suspended → approved` |
| `reset_link` | 生成新 `link_token`；旧链接立即 404 |
| `close` | 状态回 `none`，`link_token = NULL`。**有未结算或在途时拒绝**（先结清） |

管理员也可以**不经申请直接开通**：`POST /api/admin/draw/access/[agentId]/grant`，入参同审批。用于你们线下聊好直接开。实现上等价于「自动建一条 approved 的申请 + 审批」。

### 7.5 专属链接与页面路由

- 链接格式：`{publicBaseUrl}/agent/draw/{token}`，`publicBaseUrl` 用 `getPublicBaseUrl()`，保证给代理的是主域名。
- `/agent/draw`（无 token）：提卡入口页。
  - `none/pending/rejected/suspended` → 显示对应状态页（§10.2）；
  - `approved` → 服务端 `redirect` 到 `/agent/draw/{token}`。
- `/agent/draw/[token]`：提卡台。服务端组件里：
  1. 未登录 → 跳 `/login`（若登录页不支持回跳参数，本期顺手加 `?next=`，只允许站内相对路径，防开放重定向）；
  2. 登录的不是代理 → 403 页；
  3. 按 token 查 `agent_draw_access`：查不到 → 「链接已失效，请到『自助提卡』查看最新链接」；
  4. token 所属 `agent_id ≠ 当前代理` → 「这不是你的提卡链接」（**不要**透露是哪个代理）；
  5. 状态非 `approved` → 渲染状态页；
  6. 通过 → 渲染提卡台。
- 所有提卡 API 都**再次校验 token**（前端把 token 放进请求体），防止只拿 session 绕过链接。

### 7.6 提卡（核心）`POST /api/agent/draw/orders`

入参：

```ts
{
  token: string,          // 专属链接 token
  requestId: string,      // 前端每次点击生成的新 UUID；重试同一次点击时复用
  planKey: string,
  quantity: number,       // 1..max_per_draw
  regionConfirmed?: boolean  // 套餐组内有 ≥2 个可提地区时必须为 true（§16.5）
}
```

伪代码（放 `lib/agent-draw.ts`，路由只做鉴权和参数校验）：

```ts
export async function createDrawOrder(input) {
  await assertStoreSalesOpen();                      // 卡台异常关店时一起关
  if (await getSetting("draw_enabled", "1") !== "1") throw 403("平台暂时关闭了自助提卡");

  // ① 幂等：同一 requestId 已存在就直接返回那一单的结果（包括卡密）
  const existing = findDrawOrder(agentId, requestId);
  if (existing) return present(existing);

  // ② 事务内：校验 + 预占
  const order = await db.transaction(async (tx) => {
    const access = tx.agent_draw_access[agentId];
    assert(access.status === "approved" && access.link_token === input.token);
    assert(agent.status === "active");
    assert(1 <= quantity && quantity <= access.max_per_draw);

    const offer = loadDrawableOffer(tx, agentId, planKey);      // §6.2
    const price = resolveDrawUnitPrice(offer);                   // §6.1
    if (!price) throw 409("该套餐未配置价格，暂不能提卡");

    // 并发：已有 issuing 且未超时（5 分钟租约）→ 拒绝
    if (hasFreshIssuing(tx, agentId)) throw 409("上一笔还在出卡，请稍候");

    const exposure = computeExposure(tx, agentId);               // §6.3
    const amount = price.unitPriceCents * quantity;
    if (exposure + amount > access.credit_limit_cents)
      throw 409(`额度不足：可用 ¥${…}，本次需要 ¥${…}`);

    checkDailyLimit(tx, agentId, quantity, access.daily_limit_count); // §6.4

    const account = await getDefaultCardplatformAccount();
    if (!account) throw 503("卡台未就绪");

    if (offer.paymentCountry && !accountSupportsPaymentCountry(account))
      throw 409("当前卡台不支持美区等付款地区，请先提菲区");   // 文案里的地区名用 regionDisplay

    const drawNo = newOrderNo("DR");
    return tx.insert(agent_draw_orders).values({
      drawNo, agentId, requestId, planId, planKeySnapshot, planNameSnapshot,
      upstreamPlanKeySnapshot: offer.upstreamPlanKey || offer.planKey,
      paymentCountrySnapshot: offer.paymentCountry,
      regionLabelSnapshot: regionDisplay(offer.paymentCountry, offer.regionLabel).zh,
      quantity, unitPriceCents: price.unitPriceCents, priceSource: price.source,
      upstreamCostUnitCents: offer.upstreamCostCents ?? null,
      cardplatformAccountId: account.id,
      idempotencyKey: `draw:${drawNo}`,
      status: "issuing", clientIp,
    }).returning();
  });

  // ③ 事务外出卡
  return await issueDrawOrder(order.id);
}
```

`issueDrawOrder(orderId)`：**照抄 `fulfillStoreOrder` 的卡台分支**，差异如下：

| 点 | 商城 `fulfillStoreOrder` | 提卡 `issueDrawOrder` |
|---|---|---|
| 锁 | `store_orders.fulfill_status → issuing`，5 分钟租约 | `agent_draw_orders.status = issuing`，同样 5 分钟租约；找回时用 `UPDATE … WHERE status IN ('issuing','unknown') AND updated_at <= stale` 抢占 |
| 已出张数 | `count(issued_cdks WHERE order_id=?)` | `count(issued_cdks WHERE draw_order_id=?)` |
| 幂等键 | `issueIdempotencyKey(order.fulfillmentIdempotencyKey, alreadyIssued, empties)` | `issueIdempotencyKey(order.idempotencyKey, alreadyIssued, empties)`，规则相同 |
| 尝试记录 | `fulfillment_attempts` | 不建新表，`attempts += 1`，错误写 `last_error_*`；需要细节时看审计日志 |
| 重复卡密 | 撞到别的订单的 `code_hash` → 抛 `CARDPLATFORM_DUPLICATE_CDK` | 同样处理，判断「别人的」条件改为 `draw_order_id != 本单` |
| 发给卡台的 plan / 地区 | `issueTargetFromSnapshot(订单快照)` | **同一个函数**，传提卡单快照（§16.4） |
| 写卡 | `issued_cdks(order_id=订单)` | `issued_cdks(order_id=0, source='draw', draw_order_id=本单, payment_country=快照)`；`agent_draw_items.payment_country` 同值 |
| 记账 | 发齐后写一行 `agent_earnings` | **每写一张卡同时写一行 `agent_draw_items(unsettled)`**，和写卡在同一事务 |
| 部分出卡 | 状态 `partially_delivered`，后台自动补发 | 状态 `partial`，**不自动补发**（代理在等结果，补发会让他困惑）；只对出了的卡记账，剩余预占释放 |
| 明确失败 | `paid_undelivered`，自动重试 | `failed`，不重试，额度释放；代理可重新点 |
| 结果未知 | `unknown` | `unknown`，额度继续预占，入队找回任务（§7.8） |

写卡事务内必须再次确认 `status = 'issuing'`，否则放弃写入（防止并发的找回任务重复记账）。`agent_draw_items.issued_cdk_id` 唯一索引是最后一道防线。

**返回给前端**：

```json
{
  "drawNo": "DR202609301530ABCDEFGH2K",
  "status": "delivered",
  "planName": "Plus",
  "planKey": "plus:us",
  "paymentCountry": "US",
  "regionLabel": "美区",
  "quantity": 3,
  "issuedCount": 3,
  "unitPriceCents": 12500,
  "amountCents": 37500,
  "codes": ["KM-XXXX-…", "…", "…"],
  "credit": { "limitCents": 300000, "exposureCents": 62500, "availableCents": 237500 },
  "message": ""
}
```

`partial` 时 `message = "卡台只出了 2/3 张，已按 2 张记账，剩余 1 张未扣费，可以再点一次"`；`unknown` 时 `codes` 可能为空，`message = "卡台响应超时，系统会自动找回，请稍后在下方记录里查看，不会重复扣费"`。

**超时设置**：`issueMany` 自带 180s 超时；路由层不要再加更短的超时。前端 fetch 不设超时，但按钮显示进度文案（§10.3）。如果部署在反向代理后，确认 nginx `proxy_read_timeout ≥ 200s`（在 README 部署章节补一句）。

### 7.7 作废 `POST /api/admin/draw/items/[id]/void`

入参：`{ reason: string(1..200), mode: "refund_upstream" | "local_only" }`

前置条件：账本行 `status='unsettled'`，对应 `issued_cdks.status='unused'`。其他情况拒绝（已用的卡不能作废；已结算的一期不支持）。

- `refund_upstream`：取 `issued_cdks.upstream_ref` 转为整数，调 `client.deleteCdkAndRefund(id)`；失败则尝试 `client.disableCdk(id)`；两者都失败 → 返回错误，**不改任何数据**。逻辑参考 `api/admin/store-orders/[orderNo]/refund/route.ts:115-135`。
- `local_only`：不调卡台（例如卡台已经手动处理过）。
- 成功后事务内：`issued_cdks.status='disabled'`；账本行 `status='void'`、`void_reason`、`voided_at/by`。审计 `admin.draw.void`。

二期预留：已结算的卡需要补偿时，新增 `agent_draw_adjustments` 表写一条负数调整，进下一张账单。一期不建。

### 7.8 找回超时提卡单

- 提卡单变成 `unknown` 时入队 `background_jobs`：`type='draw.recover'`，`dedupe_key='draw.recover:{drawOrderId}'`，`run_after = now + 60s`。
- 任务处理：调用 `issueDrawOrder(id)`（同一基础幂等键，卡台会重放已出的卡），直到 `delivered/partial/failed`。最多 6 次，指数退避（1m、2m、4m、8m、16m、32m）。
- 用尽仍未知 → 保持 `unknown`，发 TG 告警（§9.4），后台标红，等人工：
  - 「重试找回」按钮：再调一次 `issueDrawOrder`；
  - 「确认未出卡」按钮：人工核对卡台后标 `failed`，释放额度。审计。

### 7.9 标记已结算 `POST /api/admin/draw/bills`

入参：

```ts
{
  agentId: number,
  itemIds: number[],            // 1..5000
  expectedAmountCents: number,  // 前端算出的合计，防止「看到的」和「结的」不一致
  paymentMethod: "alipay" | "wechat" | "usdt" | "bank" | "other",
  paymentReference?: string,    // 0..200
  notes?: string                // 0..500
}
```

事务内：

1. 读出 `itemIds` 对应行，必须**全部**满足 `agent_id = agentId` 且 `status = 'unsettled'`，否则 409「有 N 张状态已变化，请刷新」；
2. `Σ amount_cents === expectedAmountCents`，否则 409「金额对不上，请刷新」；
3. 插入 `agent_draw_bills`：`bill_no = newOrderNo("DB")`，`item_count`，`amount_cents`，`first_item_at/last_item_at`，`summary_json`（按 `plan_key + amount_cents` 分组汇总）；
4. `UPDATE agent_draw_items SET status='settled', bill_id=?, settled_at=now WHERE id IN (…) AND status='unsettled'`，受影响行数必须等于 `itemIds.length`；
5. 清空 `agent_draw_access.credit_warned_at`（新周期重新预警）；
6. 审计 `admin.draw.bill.create`。

为什么由前端传 `itemIds` 而不是「结到某个时间点」：你看着屏幕上的列表跟代理对账，结算的必须**恰好**是你看到的那些卡。你查看期间代理新提的卡不会被误结进去。

### 7.10 撤销结算 `POST /api/admin/draw/bills/[id]/revert`

- `{ reason: string(1..200) }`；账单 `status='settled'` 且 `created_at` 在 7 天内。
- 事务：账单 → `reverted`；其下所有行 → `unsettled`，`bill_id=NULL`，`settled_at=NULL`。审计。
- 撤销后的账单仍保留在列表中（灰色、带删除线），不物理删除。

### 7.11 卡密状态同步

提卡的卡被兑换时，现有兑换流程会更新 `issued_cdks.status`（`unused → used` 等），无需额外处理。账本页面 join `issued_cdks` 显示「使用状态」，**只作参考，不影响计费**（D3）。

---

## 8. API 清单

### 8.1 代理端（全部 `requireAgent()`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/draw` | 当前状态总览：access 状态、最近一条申请、（approved 时）专属链接、额度、可提套餐及单价、全局须知 |
| POST | `/api/agent/draw/apply` | 提交申请（§7.1） |
| POST | `/api/agent/draw/remind` | 提醒平台（§7.2） |
| POST | `/api/agent/draw/orders` | 提卡（§7.6），body 带 token |
| GET | `/api/agent/draw/orders?page=&pageSize=` | 我的提卡单列表 |
| GET | `/api/agent/draw/orders/[drawNo]` | 单笔详情，含**卡密明文**（只返回自己的） |
| GET | `/api/agent/draw/items?status=unsettled\|settled\|void&page=` | 账本行列表（卡密脱敏） |
| GET | `/api/agent/draw/summary` | 未结算汇总：总张数、总金额、按套餐分组 |
| GET | `/api/agent/draw/bills` | 我的结算账单列表 |
| GET | `/api/agent/draw/bills/[billNo]` | 账单详情（含明细） |
| GET | `/api/agent/draw/export.csv?status=` | 导出账本（卡密脱敏，UTF-8 BOM，Excel 可直接打开） |

`GET /api/agent/draw` 返回示例：

```json
{
  "status": "approved",
  "notice": "提卡即计费，请按需提取。每周日对账。",
  "link": "https://kaimi.example.com/agent/draw/7K3M…",
  "credit": { "limitCents": 300000, "unsettledCents": 50000, "inflightCents": 0, "availableCents": 250000 },
  "limits": { "maxPerDraw": 10, "dailyLimit": 0, "todayCount": 4 },
  "plans": [
    { "planKey": "plus", "name": "Plus", "unitPriceCents": 12500, "coverUrl": "…" }
  ],
  "application": null
}
```

**代理端绝不返回**：上游进价、毛利、`admin_note`、其他代理任何信息。

### 8.2 管理端（全部 `requireAdmin()`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/draw/overview` | 顶部统计卡片数据 |
| GET | `/api/admin/draw/agents` | 已开通/暂停代理列表 + 每人未结算张数与金额、额度占用、最近提卡时间 |
| GET | `/api/admin/draw/agents/[agentId]` | 单代理详情：access 全字段、联系方式（最近申请的 contact） |
| GET | `/api/admin/draw/agents/[agentId]/items?status=unsettled` | **一次返回全部**未结算行（上限 5000，超过报错提示先结一部分），含 id、时间、提卡单号、套餐、卡密脱敏、使用状态、单价、上游进价 |
| GET | `/api/admin/draw/agents/[agentId]/statement` | 返回可复制的对账文本（§9.5） |
| GET | `/api/admin/draw/applications?status=pending` | 申请列表 |
| POST | `/api/admin/draw/applications/[id]/approve` | §7.3 |
| POST | `/api/admin/draw/applications/[id]/reject` | §7.3 |
| POST | `/api/admin/draw/access/[agentId]/grant` | 直接开通 |
| PATCH | `/api/admin/draw/access/[agentId]` | 改参数 |
| POST | `/api/admin/draw/access/[agentId]/action` | suspend / resume / reset_link / close |
| GET | `/api/admin/draw/orders?agentId=&status=` | 提卡单列表（含 unknown 待处理） |
| POST | `/api/admin/draw/orders/[id]/recover` | 重试找回 |
| POST | `/api/admin/draw/orders/[id]/mark-failed` | 确认未出卡 |
| POST | `/api/admin/draw/items/[id]/void` | 作废（§7.7） |
| POST | `/api/admin/draw/items/[id]/reveal` | 查看卡密明文（写审计） |
| GET | `/api/admin/draw/bills?agentId=` | 结算账单列表 |
| GET | `/api/admin/draw/bills/[id]` | 账单详情 |
| POST | `/api/admin/draw/bills` | 标记已结算（§7.9） |
| POST | `/api/admin/draw/bills/[id]/revert` | 撤销（§7.10） |
| GET | `/api/admin/draw/export.csv?agentId=&status=&billId=` | 导出（管理员版含上游进价列） |
| GET/POST | `/api/admin/draw/settings` | §5.7 的设置项 |

错误返回统一 `{ error: string }`，中文、可直接 toast。与现有接口一致。

---

## 9. Telegram 通知

全部通过 `dispatchNotifyText(text, extra, event, {}, telegramHtml)` 发送。格式化函数放 `lib/notify-core.ts`（纯函数，方便快照测试），发送包装放 `lib/notify.ts`。

**安全要求**：代理填写的 `contact`、`note`、店名等进入 HTML 前必须转义 `& < >`（parse_mode=HTML 下未转义会导致整条消息发送失败，也可能被注入链接）。如果 `notify-core.ts` 里已有转义函数就复用，没有就新增 `escapeTelegramHtml`。

后台处理链接统一用 `{publicBaseUrl}/admin?tab=draw`（`admin/page.tsx` 已支持 `?tab=` 参数，见 `applyLocation`）。

### 9.1 申请通知 `event = "draw.apply"`

```
🆕 代理申请开通「自助提卡」

代理：Polus（账号 polus01 · ID 12）
店铺：https://kaimi.example.com/s/polus
联系方式：@polus_tg
预计月用量：50–200 张
说明：想给老客户批量开，一次 20 张左右

已有商城订单：138 单 · 近 30 天 42 单
申请时间：2026-09-30 15:30

➡️ 去审批：https://kaimi.example.com/admin?tab=draw
```

「已有商城订单」帮你快速判断这个代理靠不靠谱，从 `store_orders` 统计 `pay_status='paid'` 的数量即可。

### 9.2 催审批 `event = "draw.remind"`

标题换成「⏰ 代理催审批：自助提卡」，其余同 9.1，并加一行「首次申请：X 小时前」。

### 9.3 提卡通知 `event = "draw.created"`（受 D14 开关控制）

```
📦 代理提卡  DR202609301530ABCDEFGH2K

代理：Polus
套餐：Plus · 美区 × 3（单价 ¥155.00）      ← 菲区也写「Plus · 菲区」，拼法见地区文档 §7.0.4
本次：¥465.00
未结算：¥875.00 / 额度 ¥3,000.00（29%）
平台毛利：¥15.00（上游 ¥120.00/张）
```

- 只在 `delivered` / `partial`（出了至少 1 张）时发；`partial` 标题加「（部分：2/3）」。
- 毛利行只在上游进价已配置时出现。

### 9.4 告警 `event = "draw.alert"`

- **额度预警**（D15）：敞口首次 ≥ 80% 时发，写 `credit_warned_at`，结算后清空才会再发。
  ```
  ⚠️ 提卡额度预警：Polus 未结算 ¥2,550.00 / 额度 ¥3,000.00（85%）
  ➡️ 去对账：…/admin?tab=draw
  ```
- **找回失败**：`draw.recover` 用尽次数仍 `unknown`。
  ```
  🚨 提卡结果未知，需人工核对：DR2026…（Polus · Plus · 美区 × 3）
  卡台可能已扣卡。请到卡台核对后，在后台选择「重试找回」或「确认未出卡」。
  ```

### 9.5 对账文本（不是推送，是给你复制发给代理的）

`GET /api/admin/draw/agents/[agentId]/statement` 返回：

```
【Kaimi 提卡对账】Polus
统计范围：2026-09-23 10:12 ～ 2026-09-30 15:30
————————————
Plus · 菲区     × 5  @ ¥125.00  = ¥625.00
Plus · 美区     × 2  @ ¥155.00  = ¥310.00
Pro 20x · 菲区  × 1  @ ¥400.00  = ¥400.00
————————————
合计 8 张，应付 ¥1,335.00
（作废 1 张未计入）
```

分组键是「套餐变体 × 单价」（`planKey` 本身已区分地区），排序为：基础套餐名 → 菲区在前、其余按地区 → 单价。对齐用显示宽度（中文算 2），不能用 `String.length`，否则「菲区」「美区」行会错位。

代理端「未结算」页也提供同样的「复制对账文本」按钮，双方看到的是同一份东西。

---

## 10. 界面设计

### 10.0 设计原则

- **视觉复用现有组件**：代理后台用 `km-acp-*` 布局与 `agent-console.css`；通用用 `km-panel`、`km-btn`、`km-btn-ghost`、`km-table`、`km-badge(-ok/-bad/-wait)`、`km-stat`、`km-tabs`、`km-input`、`toast`、`useAskDialog`。**不引入新 UI 库**。
- 金额一律显示元，两位小数，用 `lib/money.ts` 的 `yuanTextFromCents`。
- 时间用 `formatWhen` 风格（`MM-DD HH:mm`，24 小时制）。
- 所有「会花钱 / 改账」的操作都要二次确认，确认框里写清楚数字。
- 建议实现者先按仓库惯例做**预览页**（参考已有的 `app/preview/agent`、`app/preview/storefront`），用假数据把 §10.2–10.4 所有状态画出来，截图确认后再接接口。

### 10.1 代理后台导航改动

`components/agent-console-shell.tsx` 的 `NAV` 在「钱和量」组里、「账本」之后插入：

```ts
{ href: "/agent/draw", label: "自助提卡", hint: "进货", group: "钱和量" },
```

`hint` 按状态动态显示（与公告未读的写法一致）：

| 状态 | hint |
|---|---|
| none | 申请 |
| pending | 审核中 |
| approved | 进货 |
| approved 且额度占用 ≥ 80% | 待结算（用警示色） |
| suspended | 已暂停 |

需要把状态放进 `AgentConsoleProfile`（`lib/agent-console-core.ts`），在 layout 里一并查出来，避免每次切页都请求。

### 10.2 代理端：未开通 / 审核中 / 被拒 / 暂停

**未开通（none）**

```
┌──────────────────────────────────────────────────────────────┐
│ 自助提卡                                                      │
│ 不用等买家下单，自己直接从平台拿卡密，先用后结。                    │
├──────────────────────────────────────────────────────────────┤
│  ┌─ 怎么运作 ─────────────────────────────────────────────┐   │
│  │ ① 提交申请，平台会在 Telegram 上联系你                   │   │
│  │ ② 开通后你会得到一条专属提卡链接和一个信用额度             │   │
│  │ ③ 登录后点一下即可生成卡密，按成本价记账                   │   │
│  │ ④ 定期和平台对账转账，结清后额度恢复                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  联系方式 *   [ @your_telegram                          ]     │
│              平台会通过这个联系你，建议填 Telegram 用户名        │
│  预计月用量 * ( ) 50 张以下  (•) 50–200  ( ) 200–1000  ( ) 更多 │
│  补充说明     [ 用途、希望的额度等（选填）                  ]     │
│              [                                          ]     │
│                                                              │
│  ☐ 我已知晓：提卡即计费，卡密不用也要结算                        │
│                                                              │
│                                       [ 提交申请 ]            │
└──────────────────────────────────────────────────────────────┘
```

- 勾选框不勾，「提交申请」置灰。
- 提交成功 toast「申请已提交，平台会尽快联系你」，页面切到审核中。

**审核中（pending）**

```
┌──────────────────────────────────────────────────────────────┐
│ 自助提卡                                          [审核中]    │
├──────────────────────────────────────────────────────────────┤
│   ⏳ 申请已提交，等待平台联系                                   │
│                                                              │
│   提交时间   09-30 15:30                                      │
│   联系方式   @polus_tg                                        │
│   预计用量   50–200 张/月                                     │
│   说明       想给老客户批量开，一次 20 张左右                     │
│                                                              │
│   平台会通过 Telegram 联系你。等太久了可以提醒一下：              │
│   [ 提醒平台 ]   ← 6 小时内只能点一次，冷却中显示「3 小时后可再提醒」│
└──────────────────────────────────────────────────────────────┘
```

**被拒（rejected）**

```
┌──────────────────────────────────────────────────────────────┐
│ 自助提卡                                          [未通过]    │
├──────────────────────────────────────────────────────────────┤
│   这次申请没有通过                                             │
│   平台说明：近期订单量较少，建议下月再申请                          │
│                                                              │
│   [ 重新申请 ]   ← 24 小时冷却，冷却中显示「明天 15:30 后可重新申请」│
└──────────────────────────────────────────────────────────────┘
```

若该代理曾经开通过（有账本数据），被拒/暂停页面下方仍展示 §10.4 的账本区。

**已暂停（suspended）**

```
┌──────────────────────────────────────────────────────────────┐
│ 自助提卡                                          [已暂停]    │
│ 平台暂停了你的提卡权限，如有疑问请联系平台。已有账单不受影响。       │
├──────────────────────────────────────────────────────────────┤
│   （下面是 §10.4 账本区，只读）                                  │
└──────────────────────────────────────────────────────────────┘
```

### 10.3 代理端：提卡台（approved，`/agent/draw/[token]`）

**桌面布局**

```
┌──────────────────────────────────────────────────────────────────────┐
│ 自助提卡                                                  [已开通]    │
│ 📢 提卡即计费，请按需提取。每周日对账。          ← draw_agent_notice     │
├──────────────────────────────────────────────────────────────────────┤
│ ┌─ 我的专属链接 ───────────────────────────────────────────────────┐ │
│ │ https://kaimi.example.com/agent/draw/7K3M9QX…      [复制] [收藏说明]│ │
│ │ 这条链接只对你的账号有效，别人拿到也用不了。                          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌─ 额度 ───────────────────────────────────────────────────────────┐ │
│ │ 可用 ¥500.00                                  额度 ¥3,000.00      │ │
│ │ ███████████████████████████████░░░░░░  83%                        │ │
│ │ 未结算 ¥2,500.00 · 出卡中 ¥0.00 · 今日已提 4 张（不限）             │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌─ ① 选择套餐 ─────────────────────────────────────────────────────┐ │
│ │ ┌──────────┐  ┌──────────┐  ┌──────────┐                          │ │
│ │ │ [封面]    │  │ [封面]    │  │ [封面]    │                          │ │
│ │ │ Plus     │  │ Pro 20x  │  │ Team     │                          │ │
│ │ │ ¥125.00起│  │ ¥400.00  │  │ ¥600.00  │  ← 多地区显示最低价+「起」 │ │
│ │ │ PH US CL │  │ PH       │  │ PH       │  ← 可提的地区短码          │ │
│ │ │   ✓ 已选  │  │          │  │ 额度不足  │ ← 最低单价 > 可用额度时置灰 │ │
│ │ └──────────┘  └──────────┘  └──────────┘                          │ │
│ │                                                                    │ │
│ │ ② 付款地区                                                          │ │  ← 所选套餐只有一个地区时整块隐藏，只在合计行写地区
│ │ ┌───────────────┬───────────────┬────────────────┐                 │ │
│ │ │ [PH] 菲区      │ [US] 美区 ✓    │ [CL] 智利区     │                 │ │
│ │ │ ¥125.00/张     │ ¥155.00/张     │ ¥130.00/张      │                 │ │
│ │ └───────────────┴───────────────┴────────────────┘                 │ │
│ │ ⓘ 地区在出卡时写进卡密，客户兑换时按美区结账，提错不能换区。            │ │
│ │                                                                    │ │
│ │ ③ 数量  [ − ]  3  [ + ]    最多 10 张/次                             │ │
│ │                                                                    │ │
│ │ 合计   Plus · 美区 × 3 = ¥465.00        提后可用 ¥35.00               │ │
│ │                                                                    │ │
│ │                              [    生成 3 张 美区 卡密    ]           │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ （下方：§10.4 账本区）                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

交互细节：

- 数量 `+` 在「到达单次上限」或「再加一张就超额度」时置灰，旁边提示原因（「已到单次上限」/「额度只够 3 张」）。
- 点「生成」→ `useAskDialog` 确认框：

  ```
  ┌──────────────── 确认提卡 ──────────────────────┐
  │ ┌────────────────────────────────────────────┐ │
  │ │  付款地区   [US] 美区                       │ │  ← 警示横幅，放最上面
  │ │  客户兑换时按美区结账，提错不能换区、不能作废改提 │ │
  │ └────────────────────────────────────────────┘ │
  │ Plus × 3                                       │
  │ 单价 ¥155.00，合计 ¥465.00                      │
  │ 生成后立即计入未结算账单，不能撤回。                │
  │                                                │
  │ [ ] 我已确认提的是【美区】卡密，提错不能换区        │  ← 默认不勾
  │                                                │
  │                 [取消]   [确认生成]（置灰）       │  ← 勾选后才可点
  └────────────────────────────────────────────────┘
  ```

  地区确认规则与店铺一致（地区文档 §7.2.2）：所选套餐有 ≥2 个可提地区时必须勾，菲区也要勾；只有一个地区或点数档时不显示横幅和勾选框。每次打开都重新勾，不记住。`POST /api/agent/draw/orders` 同样增加 `regionConfirmed`，需要确认却没带时返回 400，**不预占额度、不调卡台**。

- 确认后：前端生成 `requestId = crypto.randomUUID()` 并保存在组件状态里。按钮变为 loading，文案依次为：
  - 0–5s「正在向卡台取卡…」
  - 5–30s「卡台处理中，请不要关闭页面…」
  - 30s 以上「比平时慢一些，最长约 3 分钟。关掉页面也不会重复扣费。」
- 网络中断或 5xx：弹出「结果未知」提示，按钮变成「重新获取结果」，**使用同一个 `requestId` 重发**，服务端按幂等返回原结果。只有在收到明确结果（成功/失败）后才清空 `requestId`。
- 成功 → 结果弹窗：

  ```
  ┌──────────────── 已生成 3 张卡密 ─────────────────┐
  │ DR202609301530ABCDEFGH2K · Plus · 美区 × 3 · ¥465.00 │
  │                                                  │
  │  KM-8H2K-…-QX7P                   [US]   [复制]  │
  │  KM-3MNV-…-7ZRA                   [US]   [复制]  │
  │  KM-9PLT-…-K2DD                   [US]   [复制]  │
  │                                                  │
  │  [ 全部复制 ]  [ 下载 .txt ]                       │
  │                                                  │
  │  卡密可随时在下方「提卡记录」里再次查看。             │
  │                                        [ 完成 ]  │
  └──────────────────────────────────────────────────┘
  ```

  「全部复制」每行一张，只复制码；`.txt` 文件名 `DR…-Plus-US-3.txt`（菲区写 `PH`），文件第一行写 `# Plus · 美区 × 3`，方便代理之后分辨。
- `partial`：弹窗顶部黄色条「卡台只出了 2/3 张，已按 2 张记账，剩余未扣费」。
- `failed`：toast 错误信息，额度不变。
- `unknown`：弹窗「卡台响应超时，系统会自动找回，找回后会出现在提卡记录里，不会重复扣费」。

**移动端**（< 640px）：专属链接卡片折叠为一行「专属链接 [复制]」；套餐卡片横向滚动；付款地区改为纵向列表（每行：徽标 + 地区名 + 单价）；「生成」按钮吸底（`position: sticky; bottom: 0`），上方显示「Plus · 美区 × 3 = ¥465.00」。

地区选择的交互细节（默认选中、切换套餐时怎么处理、额度不足的置灰）见 §16.5。

### 10.4 代理端：账本区（提卡台下方 / 暂停页）

使用 `km-tabs` 三个子页：

```
┌──────────────────────────────────────────────────────────────────────┐
│ [ 未结算 (4) ]  [ 结算账单 ]  [ 提卡记录 ]                               │
├──────────────────────────────────────────────────────────────────────┤
│ 未结算 4 张，合计 ¥530.00   地区 [全部 ▾]   [复制对账文本] [导出 CSV]  │
│ Plus · 菲区 × 2 = ¥250.00 · Plus · 美区 × 2 = ¥310.00                 │  ← 汇总按 §9.5 分组
│                                                                      │
│ 时间          提卡单        套餐   地区   卡密            状态    金额  │
│ 09-30 15:30  DR…GH2K     Plus   [US]   KM-8H2K…QX7P    未使用 155.00 │
│ 09-30 15:30  DR…GH2K     Plus   [US]   KM-3MNV…7ZRA    已兑换 155.00 │
│ 09-29 11:02  DR…PP4M     Plus   [PH]   KM-…            未使用 125.00 │
│ 09-28 20:15  DR…Q9TT     Plus   [PH]   KM-…            已作废  —     │ ← 作废行灰色+删除线，不计入合计
│                                                        [上一页][下一页]│
└──────────────────────────────────────────────────────────────────────┘
```

- 「状态」列显示卡密使用情况（未使用 / 兑换中 / 已兑换 / 已作废），只是参考。
- 「结算账单」子页：

  ```
  账单号              结算时间      张数   金额       方式     状态
  DB…A1B2           09-28 21:00    12   ¥1,500.00  支付宝   已结算   [明细]
  DB…C3D4           09-21 20:30     8   ¥1,000.00  USDT     已撤销   [明细]  ← 灰色
  ```

  「明细」展开账单汇总（按套餐）+ 卡密列表（脱敏）。
- 「提卡记录」子页：按提卡单列出，每行 `[查看卡密]` 打开与结果弹窗相同的卡密列表（明文，走 `GET /api/agent/draw/orders/[drawNo]`）。`unknown` 行显示「找回中」徽章。

### 10.5 管理后台：新 Tab「提卡账本」

`app/admin/page.tsx`：
- `Tab` 类型加 `"draw"`；`HASH_TABS` 加 `"draw"`；`tabs` 列表在 `["earnings", "收益统计"]` **之前**插入 `["draw", "提卡账本"]`。
- 渲染：`{tab === "draw" ? <AdminAgentDraw /> : null}`，组件放 `components/admin-agent-draw.tsx`（自己管理数据加载，和 `AdminEarningsStats` 一样）。
- Tab 标签上显示待审批数量角标：`提卡账本 ·2`（从 `/api/admin/draw/overview` 取；为了不影响其他 Tab，只在进入后台时请求一次）。

**顶部统计卡片**（`km-stat` × 4）：

```
┌────────────┐ ┌────────────┐ ┌──────────────────┐ ┌────────────┐
│ 待审批申请  │ │ 已开通代理  │ │ 未结算总额        │ │ 今日提卡    │
│ 2          │ │ 7 （暂停 1）│ │ ¥4,320.00         │ │ 23 张       │
│ 去处理 →    │ │            │ │ 36 张 · 毛利 ¥180 │ │ ¥2,875.00   │
└────────────┘ └────────────┘ └──────────────────┘ └────────────┘
```

若存在 `unknown` 提卡单，卡片上方加红色横条：「有 1 笔提卡结果未知，需要核对 [查看]」。

**子页切换**（`km-tabs` 小号）：`[ 账本 ] [ 申请 (2) ] [ 结算记录 ] [ 提卡单 ] [ 设置 ]`

#### 10.5.1 账本（默认子页）—— 左右分栏

```
┌─ 代理 ───────────────────┐┌─ Polus · @polus_tg ─────────────────────────────────────────┐
│ 🔍 [搜索代理         ]    ││ 额度 ¥850.00 / ¥3,000.00  █████░░░░░░░░░░░░░░ 28%           │
│ ☐ 只看有未结算             ││ 单次 ≤10 · 每日不限 · 套餐 Plus/Pro · 通知 开                   │
│                          ││ 链接 …/agent/draw/7K3M… [复制]                                │
│ ● Polus         ¥850.00  ││ [调整参数] [暂停] [重置链接] [复制对账文本] [导出]               │
│   7 张 · 28% ▓▓░░░░░░     │├──────────────────────────────────────────────────────────────┤
│ ○ 小鱼          ¥375.00  ││ 未结算 7 张，合计 ¥850.00       按套餐：Plus×6 ¥750 · Pro... │
│   3 张 · 13% ▓░░░░░░░     ││                                                              │
│ ○ Kevin           ¥0.00  ││ ☑ 时间        提卡单   套餐  地区  卡密          状态   单价 上游 操作      │
│   —                      ││ ☑ 09-30 15:30 DR…GH2K Plus [US] KM-8H2K…QX7P 未使用 155  148 [显示][作废]│
│ ○ 阿杰 [暂停]    ¥125.00  ││ ☑ 09-30 15:30 DR…GH2K Plus [US] KM-3MNV…7ZRA 已兑换 155  148 [显示]      │
│   1 张                    ││ ☑ 09-29 11:02 DR…PP4M Plus [PH] KM-…         未使用 125  120 [显示][作废]│
│                          ││ …                                                            │
│                          ││                                                              │
│                          │├──────────────────────────────────────────────────────────────┤
│                          ││ 已选 7 张 · ¥850.00                        [ 标记已结算 ]      │ ← 吸底
└──────────────────────────┘└──────────────────────────────────────────────────────────────┘
```

- 左栏：已开通 + 暂停 + 有未结算账的代理，按未结算金额降序。每行显示店名（用 `agentIdentityLabel` 与现有结算列表一致）、未结算金额、张数、额度占用条（≥80% 橙色，100% 红色）。
- 右栏表头「☑」为全选，**默认全选**。取消勾选部分行即为部分结算。
- 「作废」只在「未使用」行出现。点开弹窗：

  ```
  ┌──────────── 作废这张卡？ ────────────┐
  │ KM-8H2K…QX7P · Plus · ¥125.00        │
  │ 作废后不再计入 Polus 的账单。           │
  │                                      │
  │ 处理方式                              │
  │ (•) 同时在卡台删卡退款（推荐）           │
  │ ( ) 只在本系统作废（卡台已手动处理过）   │
  │ 原因 * [ 代理误提，未发出            ]  │
  │                                      │
  │              [取消]   [作废]（红色）   │
  └──────────────────────────────────────┘
  ```

- 「标记已结算」弹窗：

  ```
  ┌──────────── 标记已结算 · Polus ────────────┐
  │ 共 7 张，金额 ¥850.00                        │
  │   Plus · 菲区 × 4 = ¥500.00                 │
  │   Plus · 美区 × 2 = ¥310.00                 │
  │   Codex 点数 500 × 1 = ¥40.00               │  ← 点数档没有地区，不写后缀
  │ 时间范围 09-23 10:12 ～ 09-30 15:30          │
  │                                             │
  │ 收款方式 * [ 支付宝          ▼ ]             │
  │ 流水号     [ 2026093022001…             ]    │
  │ 备注       [                            ]    │
  │                                             │
  │ 确认已收到 ¥850.00 吗？                       │
  │                    [取消]   [确认已结算]       │
  └─────────────────────────────────────────────┘
  ```

  成功 toast「已生成账单 DB…，7 张已结算」，列表清空，左栏金额归零。
- 「调整参数」弹窗与审批弹窗（§10.5.2）相同表单，按钮文案「保存」。
- 「重置链接」确认文案：「重置后旧链接立即失效，Polus 需要到『自助提卡』页复制新链接。」
- 「显示」卡密：调 reveal 接口，写审计，与现有「卡密查询」Tab 行为一致。

#### 10.5.2 申请

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [ 待处理 (2) ] [ 已通过 ] [ 已拒绝 ] [ 全部 ]                    [ + 直接开通代理 ] │
├──────────────────────────────────────────────────────────────────────────────┤
│ 时间         代理              联系方式     预计月量   商城订单   说明           通知   操作 │
│ 09-30 15:30 Polus (polus01)   @polus_tg   50–200    138 单   想给老客户…   ✓     [通过][拒绝]│
│ 09-30 09:12 小鱼 (xiaoyu)      @xy_shop    <50        12 单   —             ✗ 失败 [通过][拒绝]│
│                                                                    ↑ 悬停显示失败原因     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**通过弹窗**（也用于「直接开通」「调整参数」）：

```
┌──────────────────── 开通自助提卡 · Polus ────────────────────┐
│ 信用额度 *     ¥ [ 3000.00  ]    未结算超过这个数就不能再提       │
│ 单次最多       [ 10 ] 张          1–200                        │
│ 每日最多       [ 0  ] 张          0 = 不限                      │
│ 每次提卡通知   [✓]                                              │
│                                                               │
│ 可提套餐与单价                                                  │
│ ┌───┬──────────────┬──────────┬──────────┬─────────┬────────┐ │
│ │ ✓ │ 套餐 / 地区   │ 代理成本价 │ 提卡价    │ 上游进价 │ 每张毛利│ │
│ ├───┼──────────────┼──────────┼──────────┼─────────┼────────┤ │
│ │ ☑ │ Plus    [整组]│          │          │         │        │ │  ← 组行：勾 = 组内所有地区
│ │ ☑ │   [PH] 菲区   │ ¥125.00  │ [      ] │ ¥120.00 │ ¥5.00  │ │
│ │ ☑ │   [US] 美区   │ ¥155.00  │ [      ] │ ¥148.00 │ ¥7.00  │ │
│ │ ☐ │   [CL] 智利区 │ ¥130.00  │ [      ] │ 未配置   │ —      │ │
│ │ ☑ │ Pro 20x       │          │          │         │        │ │
│ │ ☑ │   [PH] 菲区   │ ¥400.00  │ [      ] │ ¥380.00 │ ¥20.00 │ │
│ │ ☐ │ Team          │          │          │         │        │ │
│ │ ☐ │   [PH] 菲区   │ ¥600.00  │ [      ] │ 未配置   │ —      │ │  ← 只有菲区也按组显示，版式一致
│ └───┴──────────────┴──────────┴──────────┴─────────┴────────┘ │
│ 提卡价默认留空 = 按代理成本价，一般不用填。填了且低于上游进价会标红。  │
│ 只列出该代理已分配且卡台可售的套餐。美区、智利区是否可提单独勾。      │
│                                                               │
│ 内部备注       [ TG 聊过，每周日结                          ]    │
│                                                               │
│                               [取消]   [通过并开通]              │
└───────────────────────────────────────────────────────────────┘
```

- 「直接开通代理」先弹一个代理选择下拉（只列未开通的代理），再进上面的表单。
- **拒绝弹窗**：原因（必填，会展示给代理）+ 确认。

#### 10.5.3 结算记录

```
筛选：代理 [全部 ▼]  时间 [本月 ▼]                                    [导出 CSV]
┌──────────────────────────────────────────────────────────────────────────────┐
│ 账单号        代理     结算时间      范围              张数  金额       方式  流水号   状态  操作 │
│ DB…A1B2     Polus   09-28 21:00  09-21～09-28      12  ¥1,500.00 支付宝 2026… 已结算 [明细][撤销]│
│ DB…C3D4     小鱼     09-27 10:00  09-20～09-27       5  ¥625.00   USDT  0x8f… 已结算 [明细]      │ ← 超 7 天无撤销
│ DB…E5F6     Polus   09-21 20:30  …                  8  ¥1,000.00 …     …    已撤销 [明细]      │ ← 灰色
└──────────────────────────────────────────────────────────────────────────────┘
合计（已结算）：¥2,125.00 · 25 张
```

「明细」行内展开：按套餐汇总 + 卡密列表（脱敏，含使用状态）。「撤销」需填原因。

#### 10.5.4 提卡单

所有提卡单流水，筛选代理 / 状态。`unknown` 行置顶标红，操作列 `[重试找回] [确认未出卡]`；`partial` 行显示「2/3」。用于排查问题，平时不用看。

#### 10.5.5 设置

```
全局开关      [✓] 允许代理自助提卡           关掉后所有代理都不能提，账本照常
提卡通知      [✓] 每次提卡发 Telegram
默认额度      ¥ [ 3000.00 ]                  审批时的预填值
默认单次上限  [ 10 ] 张
代理须知      [ 提卡即计费，请按需提取。每周日对账。                 ]
             [                                                  ]
                                                         [ 保存 ]
```

通知渠道本身沿用「接入卡台 › 站点通知」里已配的 Telegram，这里不重复配置，只放一句链接「通知发到哪里？去接入卡台设置」。

### 10.6 其他页面的小改动

- **代理管理**（`components/admin-agents.tsx`）：代理行加一个小徽章「提卡：已开通 / 审核中 / 暂停」，点击跳 `/admin?tab=draw` 并选中该代理（用 `?tab=draw&agent=12`，`AdminAgentDraw` 读取 `agent` 参数）。
- **代理概览**（`/agent`）：已开通时在概览卡片区加一张「提卡未结算 ¥500.00」小卡，点击到 `/agent/draw`。
- **卡密查询 Tab**：来源列显示「商城」/「提卡」，见 §11。

---

## 11. 对现有代码的改动清单

| 文件 | 改动 |
|---|---|
| `apps/web/src/db/schema.ts` | 新增 5 张表；`issuedCdks` 加 `source`、`drawOrderId`；`agentPlanPrices` 加 `drawPriceCents` |
| `apps/web/src/db/migrate-lib.ts` | 新增 `ensureAgentDrawSchema()` 并在 `ensureSchema()` 中调用 |
| `apps/web/src/lib/agent-draw-core.ts`（新） | 纯函数：`resolveDrawUnitPrice`、`computeExposure`（接收行数据）、`checkDailyLimit`、`newDrawLinkToken`、`buildStatementText`、`summarizeItemsByPlan`、`creditWarnCrossed` |
| `apps/web/src/lib/agent-draw-core.test.ts`（新） | 见 §13 |
| `apps/web/src/lib/agent-draw.ts`（新） | 数据库操作：`getDrawState`、`applyForDraw`、`approveDraw`、`createDrawOrder`、`issueDrawOrder`、`voidDrawItem`、`createDrawBill`、`revertDrawBill` |
| `apps/web/src/lib/notify-core.ts` | 新增 `formatDrawApplyText/Html`、`formatDrawCreatedText/Html`、`formatDrawAlertText/Html`；如无 HTML 转义函数则新增 |
| `apps/web/src/lib/notify.ts` | 新增 `notifyDrawApply`、`notifyDrawCreated`、`notifyDrawAlert` |
| `apps/web/src/lib/notify-commerce.ts` | `loadRedeemNotifyContext`：当 `issued.source === 'draw'` 时，读取 `agent_draw_orders`，返回 `plan`、`agentName`，并在通知里标注「来源：代理提卡 DR…（成本 ¥X）」，**不要**填商城相关的 goods/coupon 字段 |
| `apps/web/src/lib/background-jobs.ts` | 注册 `draw.recover` 处理器 |
| `apps/web/src/app/api/agent/draw/**`（新） | §8.1 全部路由 |
| `apps/web/src/app/api/admin/draw/**`（新） | §8.2 全部路由 |
| `apps/web/src/app/api/admin/route.ts` | `section=stock` 的查询：`innerJoin(storeOrders)` 改为 `leftJoin(storeOrders)` + `leftJoin(agentDrawOrders, eq(agentDrawOrders.id, issuedCdks.drawOrderId))`；`orderNo` 取 `coalesce(storeOrders.orderNo, agentDrawOrders.drawNo)`；搜索条件同时匹配 `drawNo`；`source` 按 `issuedCdks.source` 返回 `shop` / `draw` |
| `apps/web/src/app/admin/page.tsx` | 加 `draw` Tab（§10.5）；卡密查询表格加「来源」列，`draw` 显示「提卡」徽章 |
| `apps/web/src/components/admin-agent-draw.tsx`（新） | 管理端全部界面 |
| `apps/web/src/components/agent-draw.tsx`（新） | 代理端提卡台 + 账本区 |
| `apps/web/src/components/agent-draw-apply.tsx`（新） | 代理端申请/状态页 |
| `apps/web/src/app/agent/draw/page.tsx`（新） | 入口，approved 时 redirect |
| `apps/web/src/app/agent/draw/[token]/page.tsx`（新） | 提卡台，服务端校验 token |
| `apps/web/src/components/agent-console-shell.tsx` | `NAV` 加「自助提卡」，hint 动态 |
| `apps/web/src/lib/agent-console-core.ts` / `agent-console.ts` | `AgentConsoleProfile` 加 `drawStatus`、`drawCreditRatio` |
| `apps/web/src/components/admin-agents.tsx` | 代理行加提卡徽章 |
| 登录流程（`components/login-form.tsx` + `/api/auth`） | 若尚不支持，加 `next` 回跳参数，仅允许以 `/` 开头且不以 `//` 开头的站内路径 |
| `README.md` 部署章节 | 注明反代 `proxy_read_timeout ≥ 200s` |
| `docs/多代理即时发卡系统详细设计.md` | 在「扩展」章节登记本功能，指向本文 |

**不需要改**（已核对，因 `innerJoin(storeOrders)` 自然排除 `order_id=0`）：
- `api/agent/cdks/route.ts`（代理「已售卡密」只显示商城卡，符合预期）
- `api/v1/open/cdks/route.ts`、`api/v1/open/orders/[orderNo]/route.ts`
- `api/public/store-orders/[orderNo]/route.ts`、退款、resolve、发卡流程

**需要实现者再核对一遍**（我没逐行读完）：兑换流程里是否有「通过 `issued.orderId` 回查 `store_orders` 并在查不到时报错」的逻辑。全仓搜 `issued.orderId`、`issuedCdk.orderId`、`row.orderId` 并确认 `0` 值不会抛错。目前已知 `notify-commerce.ts` 查不到时会回退到 `issued.agentId`，是安全的。另外 `docs/redeem-guard-open-api-agent-identity-plan.md` 里如有按商城订单识别代理身份的逻辑，提卡的卡要改为从 `issued_cdks.agent_id` 取。

---

## 12. 安全与风控

| 风险 | 对策 |
|---|---|
| 代理账号被盗后被刷卡 | 信用额度（硬上限）+ 每日上限 + 单次上限 + 每次提卡 TG 通知 + 管理员一键暂停 |
| 专属链接外泄 | 链接 + 登录双校验（D9）；可重置（D10）；错误提示不泄露链接归属 |
| 连点 / 并发穿透额度 | 事务内校验额度 + 同代理只允许一个 `issuing`（D8）+ `request_id` 唯一索引 |
| 卡台超时导致重复扣卡 | 基础幂等键固定为 `draw:{drawNo}`，续发规则复用 `issueIdempotencyKey`；超时单只找回不新建 |
| 卡台超时导致卡丢失（扣了卡没入库） | `unknown` 继续预占额度 + 自动找回 + 失败告警 + 人工处理入口 |
| 重复记账 | 写卡与记账同事务 + 事务内复核 `status='issuing'` + `agent_draw_items.issued_cdk_id` 唯一 |
| 结算时误结新卡 | 按 `itemIds` + `expectedAmountCents` 精确结算（§7.9） |
| 结算手滑 | 7 天内可撤销，保留记录 |
| 代理看到平台成本结构 | 代理接口不返回上游进价/毛利；导出也不含 |
| TG 消息注入 | 代理输入一律 HTML 转义 |
| 越权 | 所有代理接口按 `session.agentId` 过滤；卡密明文接口校验归属；管理接口 `requireAdmin` |
| 审计 | 以下动作全部 `writeAuditLog`：`agent.draw.apply`、`agent.draw.remind`、`agent.draw.create`、`admin.draw.approve`、`admin.draw.reject`、`admin.draw.grant`、`admin.draw.update`、`admin.draw.suspend/resume/reset_link/close`、`admin.draw.void`、`admin.draw.reveal`、`admin.draw.bill.create`、`admin.draw.bill.revert`、`admin.draw.order.recover/mark_failed`、`admin.draw.settings` |
| 卡台余额不足 | `assertStoreSalesOpen()` 与商城共用总闸 |

---

## 13. 测试

### 13.1 纯函数单测 `agent-draw-core.test.ts`

| 用例 | 断言 |
|---|---|
| 单价：有提卡价 | 用提卡价，source=`draw_override` |
| 单价：无提卡价，有代理成本 | source=`agent_cost` |
| 单价：都没有，用全局成本 | source=`global_cost` |
| 单价：代理成本为 0 | 视为未配置，回退全局；全局也为 0 → `null` |
| 敞口 | 未结算 + issuing 剩余 + unknown 剩余；void/settled 不计 |
| 额度边界 | 敞口 + 本次 == 额度 → 允许；多 1 分 → 拒绝 |
| 日上限 | 0 不限；作废不计；在途计入；跨 Asia/Shanghai 零点正确重置（用 UTC 16:00 前后构造） |
| 额度预警 | 从 79% 到 80% 触发；已预警过不再触发；结算后可再触发 |
| 对账文本 | 按套餐+单价分组；同套餐不同单价分两行；金额格式；作废计数 |
| token 生成 | 长度 24、字母表正确 |

### 13.2 集成测试（参照现有 `*.test.ts` 的 DB 测试写法）

- 申请：none → pending；重复申请 409；被拒 24h 内 429；通知失败申请仍成功且记录 `notify_status=failed`。
- 审批：写入参数并生成 token；`drawPrices` 指向未分配套餐时报错。
- 提卡成功：`issued_cdks` 写入 `order_id=0, source=draw`；每张一行 `agent_draw_items`；状态 `delivered`。
- 同一 `requestId` 重复提交：只出一次卡，返回相同结果。
- 并发两次不同 `requestId`：第二次 409。
- 额度不足 / 超单次 / 超日上限 / 套餐不在白名单 / 暂停 / token 不匹配 / token 属于别的代理：均拒绝且不调卡台（mock 断言未调用）。
- 卡台部分出卡：只记出了的张数，状态 `partial`，额度释放。
- 卡台超时：状态 `unknown`，额度仍占用；找回任务用相同幂等键重放后变 `delivered`，不重复记账。
- 卡台返回已属于商城订单的卡：抛 `CARDPLATFORM_DUPLICATE_CDK`，不写入。
- 作废：未使用 + 未结算可作废；已使用 / 已结算拒绝；卡台删卡失败时数据不变。
- 结算：金额不符 409；含其他代理的行 409；含已结算行 409；成功后行状态和 `bill_id` 正确；`credit_warned_at` 清空。
- 撤销：7 天内成功，行回到 unsettled；超 7 天拒绝；已撤销的再撤销拒绝。
- 兑换：提卡的卡能通过 `findIssuedCdkByCode` 找到并兑换；兑换通知识别为「代理提卡」。
- 管理员卡密查询：能搜到提卡的卡（按 `drawNo` 和完整卡密）。
- 代理「已售卡密」页：看不到提卡的卡。

### 13.3 通知快照测试

`draw.apply`、`draw.remind`、`draw.created`（含 partial、含/不含毛利）、`draw.alert` 两种，文本与 HTML 各一份快照；包含 `<script>` 的 note 被正确转义。

---

## 14. 分期与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 预览** | 按 §10 用假数据做 `/preview/draw-agent`、`/preview/draw-admin` 两个预览页，覆盖所有状态 | 你看截图确认界面 |
| **P1 申请与审批** | 表结构、迁移、申请/提醒/审批/拒绝/直接开通、TG 申请通知、代理端状态页、管理端「申请」子页和「设置」子页 | 代理能申请，你能收到 TG，能审批，代理看到专属链接 |
| **P2 提卡** | 提卡台、`createDrawOrder` / `issueDrawOrder`、幂等、额度、找回任务、提卡通知、代理端「提卡记录」 | 代理点一下拿到卡，卡能在 `/recharge` 兑换；断网重试不重复扣卡 |
| **P3 账本与结算** | 管理端「账本」「结算记录」「提卡单」子页，作废、结算、撤销、对账文本、导出；代理端「未结算」「结算账单」 | 你能按代理看未结算、勾选结算、生成账单；代理看到的账和你一致 |
| **P4 收尾** | 卡密查询来源列、兑换通知识别、代理管理徽章、概览小卡、额度预警、README / 旧文档更新 | 全部测试通过 |

P1–P3 可以一次发布，但**建议先上 P1**：申请流程不涉及钱，先跑起来收集代理需求，同时开发 P2/P3。

---

## 15. 决策记录与待确认问题

### 15.1 已确认（2026-09-30）

| # | 问题 | 结论 |
|---|---|---|
| D1 | 提卡单价 | 默认就是代理成本价；单独设提卡价的能力保留，但默认留空 |
| D9 | 专属链接 | 登录 + 链接双重校验 |
| D4 | 信用额度 | 每个代理可单独设置，默认 ¥3,000（`draw_default_credit_cents = 300000`） |
| D20 | 付款地区 | 提卡支持菲区（默认）、美区、智利区；每个地区单独定价、单独授权，成本由管理员填；续费套餐不做地区版（§16） |

### 15.2 待确认（不阻塞开发，按本文默认值实现）

1. **每次提卡通知（D14）**：默认开，是否需要改为默认关？
2. **定期汇总**：你说「定期查」，是否需要系统每周自动给你发一条「各代理未结算汇总」的 TG？本文没做，加起来很简单（一个定时任务 + 一条消息）。
3. **与商城收益抵扣**：如果某代理同时有商城收益（平台欠他）和提卡欠款（他欠平台），是否要支持互相抵扣？本文明确一期不做，两本账分开结。
4. **已结算后作废**：已结算的卡代理说有问题，是否需要系统支持「下期抵扣」？本文一期不做，线下处理。
5. **成品号套餐**：是否要支持提成品号（本地库存账号）？本文一期不支持。
6. **地区额度**：美区单价更高，要不要给地区单独设额度（例如美区最多欠 ¥1,000）？本文不做，所有地区共用一个信用额度（§16.3）。

---

## 16. 付款地区（美区 / 智利区）

卡台现在能发美区、智利区的 CDK，平台侧的地区设计在 `docs/agent-region-cdk-design.md`（下称「地区文档」）。本节写提卡要怎么跟上。已确认的前提：默认区叫**菲区**；地区成本**管理员自己填**；**续费套餐不做地区版**。

### 16.1 一句话

**提卡的最小单位是「地区变体」**：`plus`（菲区）、`plus:us`（美区）、`plus:cl`（智利区）在提卡里是三个独立的可提套餐，各自有价格、授权、白名单项。界面上把它们按基础套餐合并成「选套餐 → 选地区」两步。额度、日上限、结算都不区分地区，全部合在一起算。

### 16.2 数据模型（汇总）

| 表 | 列 | 来源 | 用途 |
|---|---|---|---|
| `agent_draw_orders` | `upstream_plan_key_snapshot` | 变体行 `upstream_plan_key \|\| plan_key` | 出卡时发给卡台的 plan |
| `agent_draw_orders` | `payment_country_snapshot` | 变体行 `payment_country` | 出卡时发给卡台的地区；空 = 菲区，不传 |
| `agent_draw_orders` | `region_label_snapshot` | `regionDisplay(...).zh` | 提卡记录、找回告警里显示，管理员后来改地区名不影响历史 |
| `agent_draw_items` | `payment_country` | 提卡单快照 | 账本按地区筛选、汇总，不用 join |
| `issued_cdks` | `payment_country` | 提卡单快照 | 兑换页、卡密查询显示地区（地区文档 §5.3） |
| `agent_draw_bills` | `summary_json` 每项加 `paymentCountry`、`regionLabel` | 结算时汇总 | 账单明细 |

`plan_name_snapshot` 只存基础套餐名（「Plus」），不拼地区。显示时用 `planWithRegion(planName, paymentCountry, regionLabelSnapshot)` 现拼，避免「Plus（美区） · 美区」这种重复。

**迁移**：`ensureAgentDrawSchema()` 里除了 `CREATE TABLE IF NOT EXISTS`（新库直接带这些列），还要对这 5 列各跑一次 `addColumn`。原因：开发库上可能已经按旧 DDL 建过表，`CREATE TABLE IF NOT EXISTS` 不会补列。

### 16.3 计价、授权、额度

| 规则 | 说明 |
|---|---|
| 单价 | 每个变体各自走 §6.1：提卡价 → 代理成本 → 平台成本。美区的代理成本就是 `agent_plan_prices(agent, plus:us)` 那一行，与菲区无关 |
| 平台成本未填 | 变体 `global_cost_price_cents=0` 且代理没有成本覆盖 → `resolveDrawUnitPrice` 返回 null → 不可提。和地区文档「成本不填不能上架」一致 |
| 分配 | 管理员在代理管理里给代理分配 `plus:us`（地区文档 §7.12），才会出现在提卡台 |
| 白名单 `allowed_plan_keys_json` | 存变体 key。**空数组 = 已分配的全部变体都可提**，所以以后新分配的地区自动可提；非空时新地区不会自动加进来，需要管理员在「调整参数」里勾 |
| 信用额度 | 所有地区共用一个额度。敞口公式不变（金额本身已经是各地区单价） |
| 日上限、单次上限 | 按张数算，不分地区 |
| 卡台账户不支持地区 | 默认账户是 Avanfinity 时，所有非菲区变体从提卡台消失（§6.2 第 5 条）；已有账本不受影响 |
| 点数档 | 没有地区，照常作为单独套餐可提，界面不显示地区块 |

### 16.4 出卡

`issueDrawOrder()` 与商城共用地区文档里的 `lib/cardplatform/issue-target.ts`：

```ts
const target = issueTargetFromSnapshot({
  planKeySnapshot: order.planKeySnapshot,
  upstreamPlanKeySnapshot: order.upstreamPlanKeySnapshot,
  paymentCountrySnapshot: order.paymentCountrySnapshot,
});
// target = { plan: "plus", paymentCountry: "US" }  或  { plan: "plus", paymentCountry: "" }

if (target.paymentCountry && !accountSupportsPaymentCountry(account)) {
  // 提卡单创建后管理员切了默认账户；提卡单绑定的是创建时的账户 id，这里按该账户判断
  → status = failed, last_error_code = CARDPLATFORM_REGION_UNSUPPORTED，额度释放，不调卡台
}

const cdks = await client.issueMany(target.plan, remaining, idempotencyKey, {
  ...(pref ?? {}),
  ...(target.paymentCountry ? { paymentCountry: target.paymentCountry } : {}),
});
```

- 幂等键规则不变（`draw:{drawNo}` + `issueIdempotencyKey`）。一张提卡单只有一个地区，重放请求体一致。
- 写卡：`issued_cdks.plan_key = 变体 key`（`plus:us`），`payment_country = target.paymentCountry`；`agent_draw_items.plan_key`、`payment_country` 同值。
- **地区类错误**（`isRegionIssueError()`，地区文档 §9.3）：提卡与商城不同，按**明确失败**处理，`status = failed`，额度立即释放，不重试。理由：代理就在页面前等结果，让他马上改提菲区比后台重试更好。同时触发一次套餐同步，让这个地区尽快从提卡台和店铺消失。前端文案：「卡台暂时不能出美区卡，没有扣费。可以先提菲区。」
- 找回任务（§7.8）同样读快照，不会因为变体行后来被改而发错地区。

### 16.5 提卡台交互细节（配合 §10.3 的图）

**接口**：`GET /api/agent/draw/state` 的 `plans` 改成按基础套餐分组返回，只返回当前可提的变体：

```json
{
  "plans": [
    {
      "baseKey": "plus",
      "name": "Plus",
      "cover": "/covers/plus.png",
      "regionCapable": true,
      "regions": [
        { "planKey": "plus",    "paymentCountry": "",   "code": "PH", "label": "菲区",   "note": "",           "unitPriceCents": 12500 },
        { "planKey": "plus:us", "paymentCountry": "US", "code": "US", "label": "美区",   "note": "以美元结算", "unitPriceCents": 15500 },
        { "planKey": "plus:cl", "paymentCountry": "CL", "code": "CL", "label": "智利区", "note": "",           "unitPriceCents": 13000 }
      ]
    },
    {
      "baseKey": "codex_credit_500",
      "name": "Codex 点数 500",
      "regionCapable": false,
      "regions": [ { "planKey": "codex_credit_500", "paymentCountry": "", "code": "", "label": "", "unitPriceCents": 4000 } ]
    }
  ]
}
```

分组、排序、封面回退都复用地区文档的店铺规则（§7.1.4、§7.2.6），抽成 `groupPlansByBase()` 放 `lib/cardplatform/regions.ts`，店铺和提卡共用。`POST /api/agent/draw/orders` 仍然只传 `planKey`（变体 key），服务端不需要知道「组」。

**默认选中**：

| 时机 | 选哪个地区 |
|---|---|
| 首次进入 | 本代理上次提卡用的地区（`localStorage["km-draw-region"]`），没有就菲区，菲区不可提就第一个 |
| 切换套餐 | 保持当前地区（新套餐有这个地区时），否则按「首次进入」规则 |
| 提卡成功后 | 保持不变，方便连续提同一个地区 |

**置灰与提示**：

- 地区按钮：该地区单价 > 可用额度 → 置灰，按钮下写「额度不足」。
- 套餐卡片：**组内最便宜的地区**都提不起才置灰整张卡。
- 数量上限按**当前所选地区**的单价重算（「额度只够 1 张美区」），切换地区时如果当前数量超了，自动降到上限并提示一次「已按美区单价调整为 1 张」。
- 所选套餐只有一个地区（如只开了菲区）→ 隐藏「② 付款地区」整块，合计行写「Plus · 菲区 × 3」。点数档（`regionCapable=false`）同样隐藏，合计行不带地区。
- 提示框「地区在出卡时写进卡密…提错不能换区」只在组内有 ≥2 个地区时显示。
- 「生成」按钮文案带地区：`生成 3 张 美区 卡密`；点数档是 `生成 3 张卡密`。

**确认框与结果弹窗**：见 §10.3。确认框有警示横幅和**必须勾选**的「我已确认提的是【美区】卡密」；结果弹窗里卡密旁带徽标，`.txt` 文件名与首行带地区。

**服务端地区确认**：`createDrawOrder` 在事务里按「该代理当前可提的同组变体数」判断是否需要确认。需要但 `regionConfirmed !== true` → 400「请确认付款地区」。这一步放在幂等检查之后、额度预占之前。审计日志 `agent.draw.create` 的 metadata 记 `regionConfirmed`。

### 16.6 账本、账单、导出、对账文本

| 位置 | 改动 |
|---|---|
| 代理端「未结算」表格（§10.4） | 加「地区」列（徽标）；表头加地区筛选（只列出现过的地区）；上方汇总按 §9.5 的分组 |
| 代理端「提卡记录」 | 每行「Plus · 美区 × 3」 |
| 代理端「结算账单」明细 | 汇总按套餐 × 地区 × 单价 |
| 管理端账本右栏（§10.5.1） | 加「地区」列与地区筛选；**「标记已结算」始终按勾选的行结算**，筛选只影响显示，不会偷偷漏结没显示的行——筛选状态下点「全选」只选当前显示的行，结算弹窗顶部显示「当前只选了美区 2 张，还有 5 张未选」 |
| 管理端「提卡单」 | 加地区列；`CARDPLATFORM_REGION_*` 错误显示中文 |
| 结算弹窗、账单明细 | 汇总行「Plus · 美区 × 2 = ¥310.00」 |
| 对账文本 | §9.5 |
| CSV（代理端与管理端） | 加 `payment_region`（菲区 / 美区 / 智利区；点数档留空）和 `payment_country`（PH / US / CL；点数档留空）两列 |
| 顶部统计卡片 | 不拆地区 |

`summarizeDrawItems()` 已经按 `planKey + 单价` 分组，`plus` 和 `plus:us` 自然是两组，逻辑不用改；只需要：入参加 `paymentCountry`、`regionLabel`，输出带上它们，排序改成「基础套餐名 → 菲区在前 → 地区 → 单价」。

### 16.7 通知

- **提卡通知 / 找回告警**：`notify-core.ts` 的格式化函数签名不变，调用方把 `planName` 传成 `planWithRegion(...)` 拼好的「Plus · 美区」。点数档传原名。
- **申请通知**：与地区无关，不改。
- **地区发码被拒**：复用地区文档 §7.14 的运维告警，文案里的「订单」换成「提卡单 DR…（代理 Polus）」。
- **兑换通知**：提卡的卡被兑换时，`notify-commerce.ts` 识别为代理提卡（§11），套餐行同样写「Plus · 美区」。

### 16.8 如果提卡先于地区功能合并（后接入清单）

先合提卡时，下面这些必须**已经在提卡里做好**，否则地区上线后要改表：

1. §16.2 的 5 个列先建好，值全部写空串（等于菲区）。
2. 出卡已经通过 `issueTargetFromSnapshot()`（先实现最小版：`plan = upstream || planKey`，地区为空不传）。
3. 显示名已经走 `planWithRegion()`（地区为空时返回原名）。

地区功能合并时只需：`issue-target.ts` 补上地区与协议判断、`regions.ts` 补上命名表、提卡台打开「② 付款地区」块。提卡的账本、账单、CSV 自动带上地区。

反过来如果地区先合（**推荐**，见地区文档 §12），提卡直接按本节实现即可。

### 16.9 分支上已有的未提交代码需要怎么改

`feat/agent-self-draw` 上已写的代码（未提交）与地区的关系：

| 文件 | 现状 | 需要的改动 |
|---|---|---|
| `db/schema.ts` | 已有 5 张新表、`issuedCdks.source / drawOrderId`、`agentPlanPrices.drawPriceCents` | `agentDrawOrders` 加 `upstreamPlanKeySnapshot`、`paymentCountrySnapshot`、`regionLabelSnapshot`；`agentDrawItems` 加 `paymentCountry`；`issuedCdks` 加 `paymentCountry`（若地区功能还没加） |
| `db/migrate-lib.ts` | 已有 `AGENT_DRAW_DDL`、`ensureAgentDrawSchema()` | DDL 加上述列；另加 5 个 `addColumn`（§16.2 迁移说明） |
| `lib/agent-draw-core.ts` | `summarizeDrawItems`、`buildDrawStatementText` 按 `planKey + 单价` 分组 | `DrawItemForSummary` / `DrawPlanSummary` 加可选 `paymentCountry`、`regionLabel`；排序改为 §16.6；对账文本对齐改用显示宽度；`planName` 由调用方传入已拼好地区的名字 |
| `lib/agent-draw-core.test.ts` | 21 个用例通过 | 新增：同一基础套餐两个地区分两组、排序菲区在前、中文对齐 |
| `lib/notify-core.ts` / `notify.ts` | 三组格式化与发送包装 | 不改签名；`notify-core.test.ts` 加一个「Plus · 美区」的样例（该测试文件还没跑过，改完一起跑） |

### 16.10 新增测试

1. 提 `plus:us` → `issueMany("plus", n, key, { paymentCountry: "US" })`；`issued_cdks.plan_key="plus:us"`、`payment_country="US"`；账本行 `payment_country="US"`。
2. 提 `plus`（菲区）→ 请求体没有 `payment_country` 键。
3. 美区变体平台成本 0、代理无覆盖 → 不在 `state.plans` 里，直接 POST 返回 409「该套餐未配置价格」。
4. 默认账户是 Avanfinity → 非菲区变体不在 `state.plans` 里；已建的美区 `issuing` 单出卡时 `failed` + `CARDPLATFORM_REGION_UNSUPPORTED`，额度释放，卡台未被调用。
5. 卡台返回地区类错误 → `failed`，额度释放，触发同步（mock 断言）。
6. 白名单非空且不含 `plus:cl` → 智利区不可提；白名单为空 → 已分配的智利区可提。
7. 额度只够 1 张美区、够 3 张菲区 → 美区数量上限 1，菲区 3（前端纯函数单测）。
8. 结算汇总与对账文本：菲区 2 张 + 美区 2 张 → 两行，菲区在前。
9. 找回任务重放美区单 → 请求体仍带 `payment_country: "US"`，幂等键与首发一致。
10. 地区确认：Plus 有菲区 + 美区可提时，不带 `regionConfirmed` 提任一地区 → 400，未建提卡单、未调卡台；带 `true` → 成功。只开了菲区、或提点数档 → 不要求。前端：未勾选时「确认生成」置灰，切换地区后勾选重置。

### 16.11 上线顺序（两份文档合起来）

| 步骤 | 内容 |
|---|---|
| 1 | 地区 P0（只读观察卡台地区） |
| 2 | 地区 P1（数据列、变体、发卡传地区、`issue-target.ts`、`regions.ts`、管理后台定价与上架） |
| 3 | 提卡 P0 预览页（界面按本文含地区的版本画） → 你确认截图 |
| 4 | 提卡 P1 申请与审批 |
| 5 | 地区 P2（店铺、代理后台、订单页展示） 与 提卡 P2/P3（提卡台、账本、结算）可并行 |
| 6 | 两边 P3/P4 收尾 |
