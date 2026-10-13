# 自助提卡 第四版：提成品号

> 状态：已确认（2026-10-13），按 §9 的建议做；卡密单也加 Excel 导出。分支 `feat/draw-finished-account`。
> 日期：2026-10-13
> 前提：自助提卡第三版、对账并入提卡已经在用。本文只写相对现在要改什么。
> 相关：`docs/agent-self-draw-design.md`（§1.2 一期不做成品号）、`docs/finished-account-order-design.md`（成品号交付口径）

---

## 0. 要解决的问题

| 现在 | 后果 |
|---|---|
| 可提套餐只查 `fulfillment_kind = 'cardplatform'` 且 `cardplatform_sellable = 1`（`agent-draw.ts:623-628`） | `finished_gpt` 两个条件都不满足，代理后台看不到成品号 |
| 出卡流程 `issueDrawOrder` 只会调卡台 `issueMany` | 就算放开列表，下单也只能去卡台出卡，必然失败 |
| 提卡结果、记录、未结算只认「一行一个卡密」 | 成品号有邮箱、GPT 密码、邮箱密码、Session 四段，一行一行复制不方便 |

目标：已开通提卡的代理可以按提卡价直接拿成品号，记入未结算，和卡密一起对账结清；拿到的账号可以一键复制，也可以导出 Excel。

---

## 1. 账怎么算

和卡密完全一样，**一个成品号 = 一行提卡账本**（`agent_draw_items`）：

| | 卡密 | 成品号 |
|---|---|---|
| 单价 | 提卡价 > 代理成本价 > 全局成本价（`resolveDrawUnitPrice`） | 同左，不另起一套 |
| 进价（只给平台看） | 套餐上游进价 | 这个号的 `finished_accounts.cost_cents`，没填用套餐上游进价。按号记在每一行 `upstream_cost_cents` 上 |
| 额度、单次上限、每日上限 | 占用 | **同样占用**，和卡密合在一起算 |
| 对账 | 进未结算，按代理结清 | 同左，对账代码不用改 |
| 「未兑换积压」 | 未使用的卡算 | **不算**。交付即完成，`issued_cdks.status = used` |

---

## 2. 出号流程

### 2.1 和卡密的差别

卡台出卡要调外部接口，所以有「出卡中 / 结果未知 / 取回 / 租约」那一整套。成品号是从本地库存里拿，**一个写事务就做完**，不会有中间状态：

```text
校验（权限、套餐、价格、张数）
  └─ BEGIN IMMEDIATE
       ├─ 同 requestId 已有单 → 直接返回那一单
       ├─ 额度 / 在途单 / 日限检查（和卡密同一段代码）
       ├─ 可提库存 = 未售库存 − 商城保留数（§3.2）
       │    不够 → 整单拒绝「成品号库存不够，现在最多能提 N 个」，什么都不写
       ├─ 插 agent_draw_orders（status 直接是 delivered）
       ├─ 按 id 从小到大领号：finished_accounts unused → sold，记 draw_order_id
       ├─ 每个号插一行 issued_cdks + 一行 agent_draw_items
  └─ COMMIT
通知（notifyDrawCreated）、额度预警 —— 和卡密一样，失败不影响出号
```

**不做部分交付**：库存不够就整单不提。卡台那边部分出卡是因为卡已经扣了不能退；本地库存没这个问题，整单失败对代理更清楚。

### 2.2 写进哪些表

复用商城成品号的写法（`fulfillLocalAccountOrder`），只是来源换成提卡：

| 表 | 字段 | 值 |
|---|---|---|
| `agent_draw_orders` | `fulfillment_kind`（新加） | `local_account` |
| | `cardplatform_account_id` | `0` |
| | `status` | `delivered` |
| | `upstream_cost_unit_cents` | 这批号进价都一样时填，不一样填 NULL |
| `finished_accounts` | `status` / `sold_at` | `sold` / 当前时间 |
| | `draw_order_id`（新加） | 提卡单 id。`store_order_id` 保持 NULL |
| `issued_cdks` | `code_encrypted` | `邮箱----GPT密码----邮箱密码----Session` 加密，和商城一致 |
| | `code_hash` / `code_prefix` | 邮箱算 |
| | `status` / `used_at` | `used` / 当前时间 |
| | `source` / `draw_order_id` | `draw` / 提卡单 id |
| | `cardplatform_account_id` / `upstream_ref` | `0` / `finished:{账号id}` |
| `agent_draw_items` | `upstream_cost_cents` | 这个号的进价 |

现有的积压统计已经排除了 `upstream_ref LIKE 'finished:%'`（`agent-overview.ts:66`、`usage-stats.ts:169`），不用再改。

### 2.3 邮箱撞车

`issued_cdks.code_hash` 唯一。管理员可能已经把同一个邮箱手工补发过。领号时先按候选邮箱的 hash 查 `issued_cdks`，撞了的号跳过、继续往后领；最后够数才提交。跳过的号在事务外自动停用（和商城发货一样；提卡回滚了也停用，否则它们一直算在库存里，「可提」数会虚高），并写审计日志 `draw.finished.hash_conflict`。

### 2.5 并发

额度检查、库存检查和领号在同一个写事务里。两个代理同时抢最后几个号时只会有一边领到；另一边要么读到库存不够，要么撞上 SQLite 写锁报 `SQLITE_BUSY`（卡密提卡同样如此：libsql 的事务开在新连接上，没带 `busy_timeout`），两种情况都不会多领。

### 2.4 重复点击

和卡密一样靠 `(agent_id, request_id)` 唯一：同一个 requestId 再来，直接返回已建的单和同一批号，不会再领。成品号单不会停在 `issuing` / `unknown`，所以取回任务、「确认没出卡」都碰不到它。

---

## 3. 谁能提、能提多少

### 3.1 按代理开（建议）

`agent_draw_access` 加一列 `allow_finished INTEGER NOT NULL DEFAULT 0`。管理端提卡设置里加一个勾：

```text
[✓] 允许提成品号
```

不勾的代理看不到成品号。现在 `allowed_plan_keys_json` 为空表示「全部可提」，如果直接靠它，上线那一刻所有已开通的代理都能提成品号，库存可能被一下拿空。

### 3.2 给商城留库存（建议）

新设置 `draw_finished_reserve`（默认 0），提卡只能拿超出这个数的部分：

```text
可提库存 = max(0, 未售库存 − 保留数)
```

商城下单不受保留数影响。

### 3.3 套餐价格行

和卡密一样，代理的价目里要有 `finished_gpt` 这一行（`agent_plan_prices`），没有就不出现在可提列表里。

---

## 4. 代理后台：怎么提

### 4.1 选套餐

成品号排在卡密后面，标明库存：

```text
套餐
┌───────────────────────────────────────────┐
│ ChatGPT Plus 月卡 · ¥118.00               │
│ ChatGPT Plus 月卡（美区） · ¥125.00       │
│ GPT 成品号 · ¥35.00 · 可提 23 个          │
└───────────────────────────────────────────┘

数量（一次最多 10 个，现在可提 23 个）
[ 5 ]
合计 ¥175.00
[ 提取账号 ]
```

- 选中成品号时，数量上限 = min(单次上限, 可提库存)，按钮文案从「生成卡密」换成「提取账号」。
- 可提为 0 时这一项置灰，写「暂无库存」。
- 确认框：「确认提 GPT 成品号 × 5，合计 ¥175.00？提了就计入未结算，账号交出后不能退回库存。」

### 4.2 提完马上展示

代替现在的「刚生成的卡密」：

```text
刚提取的成品号（5 个）                        [ 复制全部 ]  [ 下载 Excel ]
┌────┬──────────────────────┬────────────┬────────────┬──────────────────┬──────┐
│ #  │ 邮箱                 │ GPT 密码   │ 邮箱密码   │ Session          │      │
├────┼──────────────────────┼────────────┼────────────┼──────────────────┼──────┤
│ 1  │ demo01@example.com   │ Xk9#mP2q   │ mb!77aa    │ eyJhbGciOi…  ⧉  │ 复制 │
│ 2  │ …                    │            │            │                  │      │
└────┴──────────────────────┴────────────┴────────────┴──────────────────┴──────┘
关掉这一页后，可以在「提取记录」里再次查看和导出。
```

- 邮箱、两个密码明文直接显示（刚提完就是要拿去用）；Session 很长，表格里只显示前 12 位，点 ⧉ 复制完整内容。
- **复制全部**：一行一个号，`邮箱----GPT密码----邮箱密码----Session`。和导入格式、商城交付格式一致，代理可以直接贴到别的系统。
- 每行的「复制」也是这一行格式。

### 4.3 提取记录

现在的「提卡记录」改名「提取记录」，成品号单和卡密单放在一起：

```text
10-13 14:20 · GPT 成品号 × 5/5 · 已交付          [ 查看账号 ]  [ 导出 Excel ]
10-13 11:02 · ChatGPT Plus 月卡 × 10/10 · 已出卡  [ 查看卡密 ]
```

「查看账号」展开 §4.2 那张表。

### 4.4 未结算列表

一个号一行，和卡密混排：

| 时间 | 提取单 | 套餐 | 卡密 / 账号 | 状态 | 金额 |
|---|---|---|---|---|---|
| 10-13 14:20 | DR…A1F3 | GPT 成品号 | us****@outlook.com 👁 | 已交付 | ¥35.00 |
| 10-13 11:02 | DR…77C0 | Plus 月卡 | CDK-XXXX****XXXX 👁 | 未使用 | ¥118.00 |

- 打码规则：邮箱只打 `@` 前面那段。
- 👁 点开看这个号的四段内容（复用 `DrawCodePeek`，后端拆成四段返回），写审计日志。
- 状态列：成品号固定「已交付」。

上面汇总行和「复制对账文本」不变。对账文本里成品号单位用「个」，卡密用「张」：

```text
GPT 成品号        × 5   @ ¥35.00   = ¥175.00
ChatGPT Plus 月卡 × 10  @ ¥118.00  = ¥1,180.00
合计 15 件，应付 ¥1,355.00
```

---

## 5. Excel 导出

项目里已经有 `exceljs`（`lib/earnings-export.ts` 在用），直接用它出 `.xlsx`。

### 5.1 两个入口

| 入口 | 接口 | 范围 |
|---|---|---|
| 单个提取单 | `GET /api/agent/draw/orders/{drawNo}/export` | 这一单的所有卡密或号 |
| 批量 | `GET /api/agent/draw/export?from=2026-10-01&to=2026-10-13` | 时间段内提过的卡密和成品号（北京时间，最多 31 天，最多 5000 条） |

批量入口放在「提取记录」上面：

```text
导出  [2026-10-01] 至 [2026-10-13]  [ 导出 Excel ]
```

### 5.2 表格内容

文件名：`kaimi-draw-DR20261013xxxx.xlsx` / `kaimi-draw-20261001-20261013.xlsx`

成品号和卡密分两个工作表，哪种没有就不建那张表：

「成品号」：

| 序号 | 提取单 | 提取时间（北京） | 套餐 | 邮箱 | GPT 密码 | 邮箱密码 | Session | 单价 |
|---|---|---|---|---|---|---|---|---|

「卡密」：

| 序号 | 提取单 | 提取时间（北京） | 套餐 | 付款地区 | 卡密 | 使用状态 | 单价 |
|---|---|---|---|---|---|---|---|

- 凭据列（邮箱、两个密码、Session、卡密）设成文本格式、**原样写入**，前导 0 和像日期的密码都不会被改。xlsx 的字符串单元格不会被当成公式，所以这几列**不加** `'` 前缀——加了会把 `=` 开头的密码改错。套餐名等其它文本列仍按 `toCsv` 的规则加 `'`。
- 首行冻结、加粗，列宽按内容；Session 列固定宽度、不换行。
- 末尾不加合计行（金额以未结算/对账为准，避免两边对不上）。

### 5.3 安全

- 只能导自己的号（按 `agent_id` 过滤），已作废的不导出。
- 响应头 `Cache-Control: no-store`、`Content-Disposition: attachment`。
- 每次导出写审计日志 `agent.draw.accounts.export`，记提取单号或时间段、个数。
- 卡密单也能导出（Q6 已确认），和成品号共用这两个接口。

---

## 6. 管理端

| 地方 | 改动 |
|---|---|
| 提卡设置 | 加「允许提成品号」勾（§3.1） |
| 系统设置 | 加「成品号给商城保留 N 个」（§3.2） |
| 成品号库存 | 「订单」列：提卡卖出的显示 `提卡 DR…（代理名）`；按 `draw_order_id` 左连 `agent_draw_orders` |
| 代理未结算明细 / CSV | 成品号显示打码邮箱，状态「已交付」 |
| 作废 | 见下 |
| 手动核销 | 成品号不显示这个按钮（没有兑换这一步） |

**作废成品号**：

- 允许对**未结算**的成品号作废，不要求「未使用」（成品号的 `issued_cdks.status` 本来就是 `used`）。
- 不调卡台，只有「只在本系统作废」一种方式。
- 账号**不回库存**，`finished_accounts.status` 改成 `disabled`。号已经交给代理看过了，不能再卖给别人。
- 金额从未结算里扣掉，对账文本照旧写「作废 N 件未计入」。

---

## 7. 开放 API

- `GET /v1/open/draws/account` 的 `plans` 里出现成品号，加 `fulfillment_kind`、`available_stock` 两个字段。
- `POST /v1/open/draws` 不用改参数。返回里 `codes` 照旧（每项是 `邮箱----GPT密码----邮箱密码----Session`），另加 `accounts: [{ email, gpt_password, mailbox_password, session }]`，成品号单才有。
- `GET /v1/open/draws/{drawNo}` 同上。
- 文档 `agent-docs.ts` / `spec.ts` 补一段。

---

## 8. 改动范围

### 8.1 数据库

```sql
ALTER TABLE agent_draw_orders ADD COLUMN fulfillment_kind TEXT NOT NULL DEFAULT 'cardplatform';
ALTER TABLE finished_accounts ADD COLUMN draw_order_id INTEGER;
CREATE INDEX finished_accounts_draw_order_idx ON finished_accounts(draw_order_id);
ALTER TABLE agent_draw_access ADD COLUMN allow_finished INTEGER NOT NULL DEFAULT 0;
-- settings: draw_finished_reserve = '0'
```

`migrate-lib.ts` 按现有 `ADD COLUMN` 的写法加，已有数据不用回填。

### 8.2 代码

| 文件 | 改动 |
|---|---|
| `lib/agent-draw.ts` | `getAgentDrawState`：可提列表加成品号（看 `allow_finished`、带可提库存）。`createDrawOrder`：按 `fulfillmentKind` 分支，成品号跳过卡台检查，在写事务里领号（§2.1）。`voidDrawItem`：成品号分支（§6）。`revealDrawItemCode`、`getAgentDrawOrderCodes`：成品号拆成四段返回。导出函数 |
| `lib/finished-accounts.ts` | `allocateFinishedAccounts` 加 `drawOrderId` 入参（和 `orderId` 二选一）；加「可提库存」函数（扣保留数） |
| `lib/agent-draw-core.ts` | 单位「张/个/件」、成品号打码、对账文本单位。加单元测试 |
| `lib/draw-export.ts`（新） | exceljs 出表，和 `earnings-export.ts` 同一写法 |
| `app/api/agent/draw/orders/[drawNo]/export/route.ts`（新） | 单提取单导出 |
| `app/api/agent/draw/finished/export/route.ts`（新） | 按时间段导出 |
| `components/agent-draw.tsx` | §4 的界面：库存显示、按钮文案、成品号结果表、复制全部、导出 Excel、记录展开 |
| `components/draw-code-peek.tsx` | 支持四段显示 |
| `components/admin-agent-draw.tsx` | 「允许提成品号」勾、成品号作废只给本地作废 |
| `components/finished-accounts-admin.tsx` | 订单列显示提卡单 |
| `app/api/v1/open/draws/*`、`lib/open-api/*` | §7 |
| `db/schema.ts`、`db/migrate-lib.ts` | §8.1 |

不用改：对账（`reconciliation*.ts`，只认 `agent_draw_items`）、积压统计、取回任务。

### 8.3 测试

1. 库存 3、保留 0，提 5 → 拒绝，库存、额度、账本都不变。
2. 库存 10、保留 8，提 3 → 拒绝，提示「最多能提 2 个」。商城仍能卖到 0。
3. 提 2 → 两个号变 `sold`、`draw_order_id` 正确；两行 `issued_cdks` 是 `used`、`finished:` 前缀；两行未结算，金额 = 提卡价 × 2，进价按各号 `cost_cents`。
4. 同一 requestId 提两次 → 只领一次，第二次返回同一批号。
5. 两个代理同时提最后 1 个 → 一个成功，一个「库存不够」。
6. 候选号邮箱已在 `issued_cdks` → 跳过、领下一个，审计日志有记录。
7. 未兑换积压不变。
8. 作废一个成品号 → 未结算减一笔，账号 `disabled`，不回库存；不调卡台。
9. 对账：成品号和卡密在同一批次里结清。
10. 导出：只有自己的号、不含作废；`=abc` 开头的密码在 Excel 里是文本；有审计日志。
11. `allow_finished = 0` 的代理：列表里没有成品号，直接调接口提也被拒。

---

## 9. 待确认

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 成品号是所有已开通提卡的代理都能提，还是逐个代理开 | **逐个开**（§3.1），默认关 |
| Q2 | 要不要给商城保留库存 | **要**，设置项，默认 0，你按需要调 |
| Q3 | 代理看到的库存是精确数字，还是只显示「充足 / 紧张 / 无货」 | **精确数字**，代理要知道能提几个；不想暴露的话改成「≥50 显示 50+」 |
| Q4 | 作废后账号回库存还是停用 | **停用**，账号已经交出去了 |
| Q5 | 提卡价沿用 提卡价 > 代理成本价 > 全局成本价 吗 | **沿用**。注意 `finished_gpt` 全局成本价现在是 ¥3.00（迁移写死的 `FINISHED_GPT_COST_CENTS`），上线前要给开通的代理配好提卡价 |
| Q6 | 卡密单要不要也能导 Excel | **要**（已确认），和成品号同一套导出 |
