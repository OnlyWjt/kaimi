# kaimi 侧改造：开票接入 Folio + 代理开票通知

> 版本：v1.0（2026-10-20）
> 状态：设计稿，待确认
> 配套文档：Folio 仓库 `docs/kaimi-integration-folio-side.md`（Folio 侧改造）
> 对接契约：Folio 仓库 `docs/integration-api.md`（签名、A/B/C/D 四个接口的字段）
> 下文 `src/...` 均指 `apps/web/src/...`

---

## 0. 目标与结论

**用户需求**：代理店铺里买家申请的发票开出来以后，代理能收到通知（Telegram）。

**现状**：kaimi 的开票完全靠人工。

- 买家勾选开票、付款后，`notifyStoreInvoicePaid` 给管理员发一条 TG"这单需要开发票"。
- 之后去哪开、开没开，kaimi 都不知道。
- 订单上没有开票状态、发票号码。
- 代理只在下单通知里看到一句"这单买家要发票"。

**方案**：kaimi 按 Folio 的通用约定接入。

| 方向 | 接口 | 用途 |
|---|---|---|
| A 推单 | kaimi → Folio | 付款后自动把开票申请推给 Folio |
| B 查单 | Folio → kaimi | Folio 开票前核对金额和抬头 |
| C 回调 | Folio → kaimi | Folio 发信后回写开票结果；**kaimi 收到后用代理绑定的 TG 通知代理** |
| D 退款 | kaimi → Folio | 管理员退款后通知 Folio，未开的作废、已开的红冲 |

代理的 TG 绑定、按代理发消息、失败重试这些能力 kaimi 都已经有了：`telegram-bind.ts`、`dispatchNotifyText` 的 `telegramChatId` 覆盖参数、`background_jobs` 的重试。本期主要是把开票这条链路接通。

**改动清单**

| # | 内容 |
|---|---|
| K1 | 后台 Folio 对接设置（开关、地址、密钥） |
| K2 | Folio 签名与验签模块，nonce 防重放 |
| K3 | B 查单接口 |
| K4 | A 付款后推单（后台任务） |
| K5 | C 回调接口：回写订单、记事件 |
| K6 | 代理开票通知（TG） |
| K7 | 税号校验收紧为 15 / 18 / 20 位 |
| K8 | D 退款推送 |
| K9 | 管理后台：订单开票信息、补推、补发通知 |
| K10 | 代理后台：订单列表显示开票状态；通知设置加开关 |

工作量约 2 天开发 + 0.5 天联调。总开关 `folio_enabled` 关闭时，行为和现在完全一样。

---

## 1. 端到端流程

```
买家下单勾选开票 → 付款
  │ confirm-store-order.ts：订单置 paid，事务内入队任务（现有：发卡、手续费对账）
  │ 新增：invoice_requested 时一并入队 folio_push_invoice
  │ 现有：管理员 TG「这单需要开发票」照发，文案不变
  ▼
K4 folio_push_invoice ── A ──▶ Folio
                       ◀─ B ── Folio 实时查单（K3），核对金额、抬头
  订单：folio_push_status = pushed，invoice_status = pending_review

        …… 财务在 Folio 审核、开具、核查后发送邮件 ……

Folio ── C ──▶ K5 /api/v1/integrations/folio/callback
  · 按 event_id 去重，写 folio_invoice_events
  · 版本号比订单上的新才回写：invoice_status = issued、发票号码、开票时间
  · issued / reddened 事件入队 notify_agent_invoice
  ▼
K6 notify_agent_invoice：查代理绑定的 TG
  · 已绑定且开着通知 → 发消息；失败按后台任务退避重试
  · 没绑定或关了通知 → 记 skipped，不重试

退款：管理员退款 → K8 folio_refund_event ── D ──▶ Folio
  → 未开具的作废；已开具的红冲，完成后回调 invoice.reddened → 通知代理「发票已作废」
```

---

## 2. 数据模型

迁移沿用现有方式：在 `src/db/migrate-lib.ts` 的 `ensureSchema()` 里 `addColumn` / `CREATE TABLE IF NOT EXISTS`，同时更新 `src/db/schema.ts`。

### 2.1 `store_orders` 新增列

| 列 | 类型 / 默认值 | 说明 |
|---|---|---|
| `folio_push_status` | TEXT `''` | 空 = 未推 / 不开票；`pending` 排队中；`pushed` 已进入 Folio；`rejected` 被 Folio 拒绝（金额不符、税号格式等，不自动重试）；`failed` 重试用尽 |
| `folio_push_error` | TEXT `''` | 最近一次失败原因，给管理员看 |
| `folio_pushed_at` | TEXT NULL | 推送成功时间 |
| `folio_invoice_id` | TEXT `''` | Folio 发票 id。重开后会变成新票的 id |
| `invoice_status` | TEXT `''` | 空；`pending_review` 已到 Folio 待开具；`issued` 已开具并交付；`reddened` 已红冲作废 |
| `invoice_no` | TEXT `''` | 发票号码（fphm） |
| `invoice_issued_at` | TEXT NULL | 开票时间，取回调的 `kprq`（北京时间文本） |
| `invoice_pdf_url` | TEXT `''` | 回调里的 PDF 链接，只接受 `https://` |
| `invoice_sync_version` | INTEGER `0` | 已应用的最大回调版本号 |
| `folio_refund_action` | TEXT `''` | 退款推送后 Folio 的处理结果：`canceled` / `red_flush` / `red_pending` / `already_reddened` / `none` |

> 现有的 `invoice_notify_status/error/notified_at` 是"提醒管理员去开票"的状态，含义不变，不复用。

### 2.2 `agents` 新增列

| 列 | 类型 / 默认值 | 说明 |
|---|---|---|
| `invoice_notify_enabled` | INTEGER `1` | 代理是否接收开票通知。和 `telegram_notify_enabled`（下单通知）分开控制 |

### 2.3 新表 `folio_invoice_events`

每条 Folio 回调一行，同时承担三件事：**去重**、**审计**、**代理通知的发件箱**。

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `order_id` | `store_orders.id` |
| `event_id` | Folio 的 `event_id`，唯一索引（去重靠它） |
| `event` | `invoice.issued` / `invoice.reddened` / `invoice.file_ready` / `invoice.resync` |
| `version` | 回调版本号 |
| `folio_invoice_id`、`previous_invoice_id` | 发票 id；重开时 Folio 带上原票 id |
| `status`、`fphm`、`kprq`、`red_reason_code` | 回调原值 |
| `applied` | 是否回写到了订单（版本号旧的不回写，记 0） |
| `notice_kind` | 要发给代理的通知类型：`issued` / `reissued` / `reddened`；空串 = 这条不通知 |
| `agent_notify_status` | 空 / `pending` / `sending` / `sent` / `failed` / `skipped` |
| `agent_notify_error`、`agent_notify_attempts`、`agent_notified_at` | 同 `store_orders.agent_notify_*` 的用法 |
| `payload_json` | 原始回调 body |
| `created_at`、`updated_at` | |

索引：`event_id` 唯一；`(order_id, id)`。

### 2.4 新表 `folio_nonces`

| 列 | 说明 |
|---|---|
| `nonce` | 主键 |
| `expires_at` | 收到时间 + 10 分钟 |

调度器每轮删除过期行。用表而不用内存，是为了进程重启后 10 分钟内的重放仍然拦得住。

### 2.5 settings 新增键

| key | 说明 |
|---|---|
| `folio_enabled` | `"1"` 打开；其它值关闭 |
| `folio_base_url` | Folio 地址，例如 `https://folio.example.com` |
| `folio_secret` | 共用密钥，用 `encryptSecret` 加密存储（同 `telegram_bot_token`） |

---

## 3. 改动明细

### K1 后台 Folio 对接设置

- 位置：管理后台现有通知 / 集成设置区域（`src/app/admin/page.tsx` 中 Telegram 设置所在的位置）。接口加在 `src/app/api/admin/route.ts` 的设置读写里，或单独新建 `src/app/api/admin/folio/route.ts`。
- 字段：开关、Folio 地址、共用密钥（只写不读，回显为 `已设置 ••••末4位`）。
- 页面上显示两个只读地址，复制到 Folio「业务对接」页：
  - 业务系统地址 = 当前站点 origin
  - 回调地址 = `{origin}/api/v1/integrations/folio/callback`
- 「签名自测」按钮：用约定 §4.3 的固定向量算一遍签名，和期望值比对，显示通过或不通过，用来确认实现和 Folio 一致。
- 操作写审计日志（`writeAuditLog`，`action = settings.folio.update`）。

### K2 签名与验签模块

新建 `src/lib/folio/sign.ts`：

```ts
// METHOD\nPATH\nTS\nNONCE\nHEX(SHA256(body))，HMAC-SHA256，小写 hex
export function folioSign(method: string, path: string, ts: string, nonce: string, body: string | Buffer, secret: string): string;

export async function verifyFolioRequest(req: Request, rawBody: string):
  Promise<{ ok: true } | { ok: false; status: 401 | 503; error: string }>;

export async function folioFetch(method: "POST", path: string, body: unknown):
  Promise<{ httpStatus: number; envelope: { status_code: number; msg: string; data?: any } | null }>;
```

**验签规则：**

- `folio_enabled` 不是 `"1"` 或密钥为空：返回 503。
- 读 `X-Folio-Timestamp`、`X-Folio-Nonce`、`X-Folio-Signature`：
  - 时间戳和服务器相差超过 300 秒，拒绝；
  - nonce 少于 8 个字符，拒绝；
  - 签名用 `timingSafeEqual` 比对。
- PATH 取 `new URL(req.url).pathname`。Caddy 反代不改路径，所以和 Folio 签名时用的路径一致。
- 必须对**原始 body 字符串**算 hash：路由里先 `await req.text()`，验签通过后再 `JSON.parse`。
- nonce：`INSERT INTO folio_nonces ... ON CONFLICT DO NOTHING`，插入失败说明重放，返回 401。

**发请求：**`folioFetch` 用 `crypto.randomBytes(16)` 生成随机 nonce，超时 15 秒。

### K3 B 查单接口

新建 `src/app/api/v1/integrations/folio/orders/[orderNo]/route.ts`，`GET`，先过 K2 验签。

**响应：** HTTP 一律 200，用信封里的 `status_code` 表示结果。

- 订单不存在：`{ "status_code": 404, "msg": "订单不存在" }`
- 存在：`{ "status_code": 0, "msg": "success", "data": {...} }`，`data` 字段如下：

| 字段 | 取值 |
|---|---|
| `order_no` | `order_no` |
| `invoiceable` | `invoice_amount_cents` 转元，两位小数字符串，例如 `"110.00"` |
| `invoiceable_state` | 见下表 |
| `fingerprint` | `"sha256:" + hex(sha256("{order_no}\|{invoice_amount_cents}\|{pay_status}\|{refunded_at ?? ''}"))` |
| `has_payment_exception` | 固定 `false`。kaimi 付款异常（重复收款、关单后收款）在 `confirm-store-order.ts` 里已经拒绝，不会变成 paid。手续费对账的 `manual_review` 只是手续费待复核，不影响开票 |
| `consistent` | `invoice_amount_cents === gross_cents` |
| `currency` | `currency` |
| `order_status` | `"{pay_status}/{fulfill_status}"` |
| `total_amount` | 商品额 = `gross_cents - invoice_surcharge_cents` |
| `invoice_fee` | `invoice_surcharge_cents` |
| `customer_paid` | `gross_cents` |
| `refunded` | 已退款时 = `gross_cents`，否则 `"0.00"` |
| `buyer` | `{ type: "company", name: invoice_title, tax_no: invoice_tax_no, email: invoice_email, note: invoice_note }` |
| `items` | `[{ product_id: plan_key_snapshot, title: product_name_snapshot, quantity, net_amount: 商品额 }]` |
| `note` | `invoice_note` |

**`invoiceable_state` 规则**（只有 `ok` 能开票）：

| 条件 | 值 |
|---|---|
| `invoice_requested = 0` | `not_requested` |
| `pay_status = unpaid` 或已关闭 | `unpaid` |
| `pay_status = refunded` | `fully_refunded` |
| `pay_status = refunding`（退款处理中） | `refunding` |
| `pay_status = paid` 且 `invoice_amount_cents > 0` | `ok` |

> 金额口径：开票金额 = 买家实付（商品额 + 10% 开票费），与 `invoice-core.ts` 的注释"开票金额 = 实付"一致。Folio 推单和开票前都会逐分比对 A 里带的金额和这里的 `invoiceable`，两者都从 `invoice_amount_cents` 取，天然一致。

### K4 A 付款后推单

**入队**：`src/lib/payments/confirm-store-order.ts` 里，订单置 paid 的同一个事务中，已经插入了 `fulfill_store_order` 和 `reconcile_payment_fee` 两个任务。在这里追加：

```ts
...(order.invoiceRequested ? [{
  type: "folio_push_invoice",
  dedupeKey: `folio_push_invoice:${order.id}`,
  payloadJson: JSON.stringify({ orderId: order.id }),
  runAfter: now, createdAt: now, updatedAt: now,
}] : []),
```

同时把订单的 `folio_push_status` 置为 `pending`。store_orders 只有这一条变成 paid 的路径；退款失败回滚成 paid 的那条（`refund/route.ts:158`）不需要重新推送。

**执行**：`src/lib/background-jobs.ts` 的 `executeJob` 在现有 `orderId` 分支里（已退款订单会在前面直接返回，正好不推）增加 `folio_push_invoice`，调用新建的 `src/lib/folio/push.ts` `pushOrderToFolio(orderId)`。

- `folio_enabled` 关闭：清空 `folio_push_status`，任务正常完成。之后打开开关，可以在后台手动补推（K9）。
- 请求：`POST /api/integration/v1/invoice-requests`

```json
{
  "order_no": "KM202610201330AB12CD34EF",
  "invoice_amount": "110.00",
  "buyer": { "type": "company", "name": "抬头", "tax_no": "税号", "email": "收票邮箱", "note": "发票备注" }
}
```

**结果处理：**

| Folio 返回 | kaimi 处理 |
|---|---|
| 200，`status_code = 0`（含 `duplicate: true`） | `pushed`；记录 `folio_invoice_id`；`invoice_status = data.status`（通常是 `pending_review`）；任务完成 |
| 400 / 422（金额不一致、不可开票、税号格式错） | `rejected`，记录错误；`recordOpsAlert`（`level: warning`，code `folio.push.rejected:{orderNo}`）；**不抛错**，任务完成，不重试 |
| 401（签名或密钥不对） | 记录错误后抛错，任务重试；第一次出现时发 ops 告警，提醒检查密钥 |
| 503 / 5xx / 网络错误 | 抛错重试（后台任务现有退避：30 秒起翻倍，最长 1 小时，最多 12 次）；用尽后标 `failed` |

> Folio 收到推单时会**同步回调 B 查单**，所以 K3 必须先于 K4 上线，并且 Folio 能访问到 kaimi 的公网地址。

**管理员 TG 提醒**：`notify-core.ts` 的"⚠️ 这单需要开发票"保持现状，文案不改。

### K5 C 回调接口

新建 `src/app/api/v1/integrations/folio/callback/route.ts`，`POST`，先过 K2 验签。

**处理顺序**（在一个事务里完成，最后返回 200）：

1. 解析 body。按 `order_no` 找订单；找不到返回 HTTP 404。Folio 遇到 4xx 不会重试，并会在控制台标"同步失败"。
2. `INSERT INTO folio_invoice_events (...) ON CONFLICT(event_id) DO NOTHING`。没插入成功说明是重复投递，直接返回 `{ status_code: 0, data: { duplicate: true } }`。
3. **版本判断**：`version > invoice_sync_version` 才回写订单，否则 `applied = 0`，只留记录。
4. **回写订单**（applied 时）：

| 事件 | 回写 |
|---|---|
| `invoice.issued` / `invoice.resync` | `invoice_status = status`（`issued`）、`invoice_no = fphm`、`invoice_issued_at = kprq`、`folio_invoice_id = invoice_id`、`invoice_pdf_url`（仅 https）、`invoice_sync_version = version` |
| `invoice.file_ready` | 只更新 `invoice_pdf_url`、`invoice_sync_version` |
| `invoice.reddened` | `invoice_status = reddened`、`invoice_pdf_url = ''`、`invoice_sync_version = version` |

5. **决定是否通知代理**：只看 applied 的回调，并且**按状态变化判断，不看 `event` 名**。

   Folio 只保证最新版本的状态是准的。旧回调可能被新快照取代，或者晚到被判为旧版本，所以 `invoice.issued` 这个事件名不一定能收到，可能直接收到一条 `invoice.file_ready`。

   用回写**之前**订单上的 `invoice_status`、`folio_invoice_id`，和这一版的 `status`、`invoice_id` 比较：

| 条件 | `notice_kind` |
|---|---|
| 新 `status = issued`，之前不是 `issued`，且 `previous_invoice_id` 非空，或之前记录过别的 `folio_invoice_id` | `reissued` |
| 新 `status = issued`，之前不是 `issued`，其它情况 | `issued` |
| 新 `status = reddened`，之前不是 `reddened` | `reddened` |
| 状态没变（补发 PDF 链接、重新同步等） | 空，不通知 |

   `notice_kind` 非空时，置 `agent_notify_status = pending`，并入队任务：`type = notify_agent_invoice`，`dedupeKey = notify_agent_invoice:{eventRowId}`，`payload = { eventId: eventRowId }`。

6. 返回 `{ status_code: 0, data: { accepted: true } }`。**重复的 `event_id`、旧版本也返回 200**（`duplicate` / `applied: false`），不要返回 4xx，否则 Folio 会标"同步失败"。

> 版本号由 Folio 按订单分配，同一订单内单调递增：红冲后重开、重新推单的新票都接着往上走。

### K6 代理开票通知

**执行**：`background-jobs.ts` 的 `executeJob` 增加 `notify_agent_invoice` 分支。注意，它要和 `deliver_api_webhook` 一样**放在通用 orderId 分支前面**：通用分支对已退款订单直接 return，而退款导致的红冲通知恰好发生在已退款订单上。

调用新建的 `src/lib/folio/agent-notice.ts` 里的 `deliverAgentInvoiceNotice(eventRowId)`，步骤照抄 `deliverAgentStorePaid`：

1. 原子占位：条件 UPDATE，`agent_notify_status` 属于 `('pending','failed')`，或卡在 `sending` 超过租期的，改为 `sending`；没占到就直接返回。
2. 查订单和代理。代理没绑定 TG、关了 `telegram_notify_enabled`，或关了 `invoice_notify_enabled`：记 `skipped` 并写原因，任务完成，不重试。
3. 发送：

   ```ts
   dispatchNotifyText(text, { audience: "agent", orderNo, event }, "invoice.agent",
     { telegramChatId: agent.telegramChatId, webhookUrl: "" }, html)
   ```

4. 成功记 `sent`。Telegram 失败记 `failed`、`attempts + 1` 并抛错，交给后台任务退避重试（最多 12 次）。

**消息模板**（`src/lib/folio/agent-notice-core.ts`，纯函数，好写单测）：

```
🧾 发票已开具
订单：KM202610201330AB12CD34EF
商品：ChatGPT Plus 月卡 × 1
开票时间：2026-10-20 14:03
已发送到买家收票邮箱 ab***@qq.com
```

```
🧾 发票已重新开具
订单：KM202610201330AB12CD34EF
商品：ChatGPT Plus 月卡 × 1
原发票已作废，新发票已发送到买家收票邮箱 ab***@qq.com
```

```
🧾 发票已作废（红冲）
订单：KM202610201330AB12CD34EF
商品：ChatGPT Plus 月卡 × 1
原因：销货退回
```

- 红冲原因代码映射：`01` 开票有误、`02` 销货退回、`03` 服务中止、`04` 销售折让。
- 邮箱脱敏：保留前 2 位和域名。
- HTML 版本对动态字段做转义，沿用 `formatAgentStorePaidTelegramHtml` 的写法。

**默认不包含的信息**：抬头、税号、发票号码、PDF 链接、金额。kaimi 现在有意不让代理看买家的开票资料，下单通知里也只写"这单买家要发票"，这里沿用。要放开哪一项，改模板即可。

### K7 税号校验收紧

`src/lib/invoice-core.ts`：

```ts
// 现有：/^[0-9A-Z]{15,20}$/ —— 16、17、19 位会被 Folio 拒绝
export const INVOICE_TAX_NO_RE = /^(?:[0-9A-Z]{15}|[0-9A-Z]{18}|[0-9A-Z]{20})$/;
```

报错文案改为"纳税人识别号须为 15、18 或 20 位字母或数字"。前台店铺的下单表单和 Open API 都调用 `normalizeInvoiceRequest`，一处改动两处生效。

历史订单里如果有 16/17/19 位的税号，推单会被 Folio 以 400 拒绝，订单标为 `rejected`，由管理员人工处理。

### K8 D 退款推送

**入队**：`src/app/api/admin/store-orders/[orderNo]/refund/route.ts` 在订单成功置为 `refunded`、事务提交后，如果 `invoice_requested` 且 `folio_push_status` 属于 `('pushed','pending','failed')`，入队任务：`type = folio_refund_event`，`dedupeKey = folio_refund_event:{orderId}`。`refund` 和 `chargeback` 两种类型都推。

**执行**：同样要放在 `executeJob` 通用 orderId 分支**前面**（订单此时已经是 refunded）。

- 请求：`POST /api/integration/v1/refund-events`，body：

  ```json
  { "order_no": "KM...", "is_full_refund": true }
  ```

- 成功后把 `data.action` 写入 `folio_refund_action`。失败按后台任务重试。

**Folio 收到后的处理：**

| 发票状态 | Folio 动作 | action |
|---|---|---|
| 还没开具 | 作废 | `canceled` |
| 已开具 | 红冲，完成后回调 `invoice.reddened`，代理收到"发票已作废" | `red_flush` |
| 正在开具 | 等结果出来后红冲 | `red_pending` |
| 已红冲过 | 不处理 | `already_reddened` |
| 没有这张票 | 不处理 | `none` |

### K9 管理后台

**订单详情**（`src/app/api/admin/store-orders/[orderNo]/detail`）增加"开票"区块：

- 推送状态 + 原因、Folio 发票 #、开票状态、发票号码、开票时间、退款处理结果；
- 最近几条 `folio_invoice_events`，每条带代理通知状态。

**新增两个操作接口：**

| 接口 | 作用 |
|---|---|
| `POST .../store-orders/[orderNo]/folio-push` | 补推到 Folio。适用于 `folio_push_status` 为空、`rejected` 或 `failed`，且订单已付款并申请了开票。实现上重置 dedupe 任务，或换一个带时间戳的 dedupeKey 重新入队 |
| `POST .../store-orders/[orderNo]/invoice-agent-notify` | 补发最近一条开票通知给代理（force，忽略 skipped） |

**订单列表**：可选增加"开票状态"筛选：待推送 / 已推送 / 已开具 / 已作废 / 推送失败。

### K10 代理后台

**订单列表**（`src/app/api/agent/orders/route.ts`）：返回字段增加 `invoiceStatus`，**只给状态，不给抬头和税号**。前端显示为：

| 条件 | 显示 |
|---|---|
| 没申请开票 | 不显示 |
| 已申请、还没开 | 待开票 |
| 已推送、待开具 | 开票中 |
| `issued` | 已开票 |
| `reddened` | 已作废 |
| `rejected` / `failed` | 开票异常，请联系平台 |

**通知设置**（`src/app/agent/notify/page.tsx`、`src/app/api/agent/notify/route.ts`）：

- 增加开关"开票完成通知"，对应 `invoice_notify_enabled`。
- 未绑定 TG 时，开关置灰，并提示先绑定。

---

## 4. 改动文件一览

| 文件 | 改动 |
|---|---|
| `src/db/schema.ts`、`src/db/migrate-lib.ts` | 新列、新表 |
| `src/lib/folio/sign.ts`（新） | 签名、验签、发请求 |
| `src/lib/folio/push.ts`（新） | 推单、退款推送 |
| `src/lib/folio/agent-notice.ts`、`agent-notice-core.ts`（新） | 代理通知发送、模板 |
| `src/app/api/v1/integrations/folio/orders/[orderNo]/route.ts`（新） | B 查单 |
| `src/app/api/v1/integrations/folio/callback/route.ts`（新） | C 回调 |
| `src/lib/payments/confirm-store-order.ts` | 付款时入队推单 |
| `src/lib/background-jobs.ts` | 三个新任务类型 |
| `src/lib/sync-scheduler.ts` | 清理过期 nonce |
| `src/lib/invoice-core.ts` | 税号正则 |
| `src/app/api/admin/store-orders/[orderNo]/refund/route.ts` | 退款后入队 D |
| `src/app/api/admin/...`、`src/app/admin/...` | Folio 设置、订单开票区块、补推 / 补发 |
| `src/app/api/agent/orders/route.ts`、`src/app/api/agent/notify/route.ts`、`src/app/agent/...` | 开票状态列、通知开关 |

---

## 5. 测试

**单元测试（vitest）：**

- `folioSign`：用约定 §4.3 的自测向量，空 body 的签名必须等于 `0134d6ca…a0e8`。
- 验签：时间戳超窗、nonce 太短、nonce 重放、签名不对，各自拒绝。
- B 映射：未付款、已付款、退款中、已退款、未申请开票，五种状态的 `invoiceable_state`；金额转元的格式。
- 回调：
  - 同一 `event_id` 重复投递只处理一次；
  - 低版本只记录、不回写；
  - `previous_invoice_id` 非空判为 `reissued`；
  - 状态没变的回调（补发 PDF、重新同步）不通知代理；
  - 没收到 `invoice.issued`、直接收到状态为 `issued` 的 `invoice.file_ready` 时，照样发"已开具"通知。
- 通知：未绑定、关了总开关、关了开票开关，三种情况都是 skipped；三个模板的文案和邮箱脱敏。
- 税号：15、18、20 位通过；16、17、19 位拒绝。

**联调（对 Folio 测试实例）：**

1. 签名自测通过。
2. 下单勾选开票 → 付款 → Folio 出现待开具，kaimi 订单 `pushed`。
3. Folio 开具并发送 → kaimi 订单变为已开票，绑定了 TG 的测试代理收到"发票已开具"。
4. 代理关掉开票通知后再走一单 → 不收消息，事件记 skipped。
5. 管理员退款 → Folio 红冲 → 代理收到"发票已作废"。
6. Folio 财务红冲后重开 → 代理收到"发票已重新开具"。
7. kaimi 停服 5 分钟再起 → Folio 回调重试成功，代理只收到一条。

---

## 6. 上线顺序

1. Folio 先上线它的改动（F1–F3 必须）。
2. kaimi 上线，`folio_enabled` 默认关闭，现有行为不变。
3. 两边配置地址和密钥，跑签名自测。
4. 打开 `folio_enabled`，用一笔小额真实订单走完整链路。
5. **历史订单**：开关打开前已付款、申请了开票、还没开的订单，不会自动推送。可以在后台逐单「补推到 Folio」；如果数量多，再加一个批量补推（见问题 3）。

---

## 7. 需要确认的事项

| # | 问题 | 本文默认 |
|---|---|---|
| 1 | 通知里要不要写金额、发票号码、PDF 链接 | 都不写，只写订单号、商品、开票时间、脱敏邮箱 |
| 2 | 重开、红冲要不要通知代理 | 都通知（"已重新开具"、"已作废"） |
| 3 | 历史待开票订单怎么处理 | 后台逐单补推；需要的话再做批量补推 |
| 4 | 接入 Folio 后，管理员"需要开发票"的 TG 还发不发 | 照发，文案不变 |
| 5 | 代理 Open API 的 webhook 要不要增加 `invoice.issued` / `invoice.reddened` 事件 | 本期不做；需要时在 `ORDER_WEBHOOK_EVENTS` 加事件，K5 里顺带入队即可 |
