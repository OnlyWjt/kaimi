# 代理对账 V2 · 开发契约与验收规格

> 设计交付，不是已上线功能。配套原型：[打开独立 HTML](agent-settlement-v2-design/index.html)。原型只使用内存静态数据，不连接真实接口、不付款、不保存生产数据；刷新或重置恢复演示。此次不修改生产 apps、计划或旧设计稿。

## 1. 范围与依赖

沿用 Next.js、Drizzle、SQLite，新增统一父批次而非覆盖旧商店结算。现状依据：`agent-settlement.ts` 仅结算期间商店正收益与调整，负/零净额被拒绝；V2 不得复用该限制。提卡采用现有 itemIds 与 expectedAmountCents 校验思路，但必须增加父批次关联。旧周结调用链已定位到 `sync-scheduler.ts` 和 `api/admin/settlements/close-week/route.ts`，上线必须同时关闭自动与手动入口。本文接口、表和状态均为待开发契约。

依赖顺序：纯规则及只读预览 → 表与快照事务 → 付款状态/权限/审计 → 页面 → 备份审计与迁移灰度。人民币线下凭证由财务提供，系统只登记，不调用支付渠道。

## 2. 金额、时间与快照契约

所有金额使用整数人民币分，禁止浮点参与计算；API 用 `currency: CNY`。时间存 ISO UTC，页面统一北京时间。累计查询仅有上界 `occurredAt <= cutoffAt`，无期间下界；统计采用 `[start,end)`，与结算候选完全独立。

`净额 = 商店收益 + 有符号调整 - 提卡欠款`。净额正：平台应付代理；负：代理应付平台；零：抵扣结清。负调整直接抵扣，不隐式顺延。

累计未结包括 pending 与已占用但未完成批次的 settling（不能将生成批次误显示成清零）。分别返回未占用、待付款锁定、待核对金额；未知金额不假装为零。可生成金额只包括未占用且通过校验的明细。paid/cleared 后仅该批次组成行从累计未结扣除，新增账和跳过项继续保留。界面标注“可对账净额，不含待核对项”，不能把可结算数冒充全部账务。

订单复算：券前商品额 − 券优惠 = 券后商品额；券后商品额 − 代理成本 − 代理承担手续费 = 代理收益。通道手续费总额 = 代理承担 + 平台承担。开票加价、平台承担手续费、上游进价只供核验，不再扣代理收益。

### 演示基线（元）

| 行 | 券前 | 券优惠 | 券后 | 代理成本 | 代理手续费 | 平台手续费 | 通道费 | 收益/金额 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SO-1001 / Plus | 1,050 | 50 | 1,000 | 700 | 20 | 10 | 30 | +280 |
| SO-1002 / Pro | 2,000 | 0 | 2,000 | 1,400 | 40 | 20 | 60 | +560 |
| AD-001 / 手续费更正 #1 | — | — | — | — | — | — | — | −40 |
| DR-001 / 提卡 | — | — | — | — | — | — | — | 欠款 300 |

商店 840 + 调整 (−40) − 提卡 300 = **平台应付代理 500**。AD-001 关联历史批次 RC-OLD-001、原收益 E-0901 和订单 SO-0901。新增 SO-1003：券后 500 − 成本 380 − 代理手续费 20 = 收益 100；累计变成 600，原快照仍为 500。零示例：840 − 40 − 800 = 0；仅提卡示例净额 −300。

生成后新行不使快照失效；已纳入行的版本、状态、归属发生变化才返回 SNAPSHOT_CHANGED。不可修改旧快照来“刷新金额”，应取消未付款批次、释放占用、重取预览并生成新批次。已付行的退款/费用差额必须新增有序更正。

## 3. 页面规格

### 管理员 `/admin/agents/settlement`

首屏：截止时间、刷新、汇总（待生成代理数、平台应付、代理应付、待核对订单）、搜索/有余额/待付款/已清/待核对筛选与净额/更新时间/名称排序。列表显示代理、三项拆解、方向净额、明细数、异常数、最近批次及操作。单代理详情显示商店/调整/提卡/跳过/历史 Tab；跳过原因覆盖 manual_review、LEDGER_MISMATCH、数据缺失，提供核验建议。

A 生成：代理 + cutoff → 纳入及跳过预览 → 固定快照待确认。B 核对：确认不可变明细与方向 → pending_payment → 非零填写支付宝/微信/银行卡/其他、流水、付款时间、备注 → 二次确认 → paid；零无需且禁止付款字段 → cleared。取消仅限未付款。源变更红色提示并阻断登记，允许取消重建。

### 代理账本

累计未结与可对账三项置顶，独立期间统计置后。期间筛选只影响经营统计及成交明细，不影响余额或批次。显示成交额、已付订单数、已发齐数、发卡量、未兑换量、券减免、通道费与代理收益。成交明细能逐行复算。历史只有批次记录，点击打开只读快照，可导出、复制批次号联系管理员；不得取消、改金额或登记付款。

### 批次详情与移动端

展示批次号、代理、状态、创建人、cutoff、生成时间、方向、快照金额、付款凭证；明细分页/筛选/CSV 导出含来源批次；审计时间线包含生成、确认、取消、付款、更正。移动端列表变卡片，主金额与方向不横滚，次字段用展开详情；付款操作栏置底，二次确认显示人民币金额和方向。空明细禁生成，已清提示查看历史，异常跳过给处理路径。

原型为单代理三视图演示，不代表全量列表、服务端分页或数据库并发已实现。HTML **未实现管理员多代理列表的搜索、状态筛选、净额/更新时间/名称排序和跨代理汇总**；第 3 节管理员列表要求是后续生产开发规格，不属于本静态原型已完成能力。其管理员工具支持新增账、源变更、零净额、取消、历史、审计、导出与重置；代理视图隐藏所有账务写操作。

## 4. 数据模型与一致性

| 表 | 字段与约束 |
|---|---|
| agent_reconciliation_batches | id、唯一 batch_no、agent_id、cutoff_at、period_label（仅标签）、currency、store_earning_cents、adjustment_cents、draw_debt_cents、net_cents、三类 count、direction、status、snapshot_hash、version、created_by/at、paid_at、cancelled_at、payment_method/reference/note、actual_payment_at |
| agent_reconciliation_items | id、batch_id、agent_id、source_type(earning/adjustment/draw_item)、source_id、source_version、amount_cents（商店/调整有符号，提卡正欠款）、direction、source_order_no、snapshot_json、created_at；同批次同来源唯一；快照永不更新 |
| agent_reconciliation_claims | source_type + source_id 唯一、batch_id、claim_state；cancelled 删除活跃占用但保留快照；settled 占用长期保留，禁止再次纳入 |
| agent_earning_adjustments（升级现有表） | 保留 id、agent_id、order_id、source_earning_id、type、amount_cents、reason、reference、status、settlement_id、created_at/updated_at；新增 sequence、business_event_key、original_batch_id；移除旧 (order_id,type) 唯一索引，改为 UNIQUE(order_id,type,sequence) 与 UNIQUE(business_event_key)，sequence 为正整数且无默认值；此表实际承载更正金额 |
| agent_reconciliation_corrections | id、original_batch_id、source_item_id、original_order_id、sequence、type(refund/fee_delta/manual/reversal)、reason、reference、new_adjustment_id、new_batch_id、status、created_by/at；new_adjustment_id 唯一且外键指向调整表，sequence 与关联调整行一致；金额从调整行读取，关联表不作为另一份入账来源 |
| 审计 | request_id、actor_id/role、IP、action、target、old_value/new_value、source_batch_id、created_at |
| reconciliation_idempotency | actor_id、action、idempotency_key、payload_hash、result_status、result_json、created_at；精确唯一键 UNIQUE(actor_id,action,idempotency_key)，同键不同 payload_hash 返回 409 IDEMPOTENCY_CONFLICT |

snapshot_json 必含套餐、发生时间、订单/提卡号、券前/优惠/券后、成本、代理/平台/通道手续费、开票加价、上游成本、收益、调整原因/序号/原批次。快照 hash 按规范化排序后的组成行及金额生成；source version 单独用于付款前比对，新增行不参与旧批次检测。

创建使用 SQLite 写事务（例如 BEGIN IMMEDIATE，需与 Drizzle 驱动能力核实），服务器重新计算，不信任客户端总额；条件占用源行、唯一 claim、校验影响行数、三项总额与计数、写父批次与审计全部原子提交。失败全回滚，忙锁有限重试，不能重试造成重复批次。提卡保持 unsettled → settled，但生成时 claim 阻止其他 bill 消费它；旧单边 billId 不足以保证父批次归属。

付款 CAS 校验 status/version/hash、源行版本及活跃归属，再校验净额与方向、分项及行数；幂等请求重复返回原结果而非再次付款。付款、源状态、旧兼容子结算关联、审计同事务完成。旧 agentSettlements 仅用于历史/兼容，禁止新旧两个写入口并行结算同一行。

### 4.1 更正的实际入账路径与旧唯一约束迁移

现有 `apps/web/src/db/schema.ts:740–742` 定义 `agent_earning_adjustments_order_type_uq(order_id,type)`，会阻止同订单同类型的第二次更正。**决定升级现有 agent_earning_adjustments，而非只新增 corrections 关联表**。每次更正事务插入一条新调整行及一条关联记录；旧金额与旧快照均不覆盖。API `fee_delta` 映射调整类型 `fee_correction`，`refund` 映射 `refund`，`manual/reversal` 使用对应新增类型。同一订单、同一调整类型可发生 sequence=1、2、3… 的不同修正事件。

- 序号作用域为 `(order_id,type)`，不是单个批次或 source_item_id。在写事务中核验 `expectedCorrectionSequence = MAX(sequence)+1`，由服务端分配序号，唯一索引兜底；不同请求并发抢同一序号，失败者返回 409 CORRECTION_SEQUENCE_CONFLICT，刷新后再提交。已拒绝/撤回记录仍保留序号，不复用。
- `business_event_key` 是稳定账务事件标识（如渠道事件 `provider:<channel>:<eventId>`，人工事件 `manual:<uuid>`），全局唯一；同事件的网络重试甚至换了请求幂等键，也不得另增调整。相同事件相同账务内容返回已有记录，内容不同返回 409 ADJUSTMENT_EVENT_CONFLICT。人工发起新的修正必须使用新事件标识。
- HTTP 请求幂等与账务事件防重分别生效。更正接口要求 `Idempotency-Key` header 及 body `businessEventKey`；调整行、关联记录、序号分配、请求幂等结果和审计同事务提交。金额唯一权威为调整表 `amount_cents`，corrections 仅提供关联/流程元数据，不能被候选查询再次求和。
- 新批次候选只读取 `agent_earning_adjustments` 的 pending 且未占用行，以 `source_type=adjustment, source_id=调整行id` 建立唯一 claim。settled claim 永久防止同调整再次入账；取消未付款批次允许释放后重新纳入，但该行最终只能完成一次结算。新批次不再从 corrections 生成第二条金额行。

**迁移执行方案（后续上线操作，本次不执行）**：在第 7 节停写并核验旧待付之后、期初校验之前进行。

1. 备份并记录旧调整行数、ID 集合、各状态金额、settlement_id 归属和旧索引 SQL。除旧结算入口外，还须暂停所有退款/拒付/手续费调整写入者；检查调用者依赖的 `ON CONFLICT(order_id,type)`，新版本统一改为 business_event_key 防重，不能保留旧写语义。
2. 使用 SQLite 事务重建调整表，保留原主键、外键、字段值及状态/归属，增加 `sequence NOT NULL CHECK(sequence > 0)`、`business_event_key TEXT NOT NULL`、可空 `original_batch_id`。旧记录按 `(order_id,type)` 组内 `created_at,id` 排序确定序号（现有唯一索引正常情况下均为1），回填 `business_event_key='legacy-adjustment:'+id`；original_batch_id 仅根据已核验历史映射填入，无法确定则为空并保留 legacy settlement_id，不伪造关联。
3. 按 SQLite 官方重建表顺序建新表、复制、替换、重建相关索引/触发器及外键依赖；新表**不创建** `agent_earning_adjustments_order_type_uq`，仅创建上述三列序号唯一索引、事件唯一索引及原 agent/status 普通索引。检查 sqlite_schema/PRAGMA index_list 和 index_info，确认旧两列唯一索引不存在（包括意外残留的自动唯一约束）；同步未来 Drizzle schema 与迁移元数据，避免再次生成旧索引。驱动的外键开关须在事务外处理，恢复后执行 foreign_key_check；任一复制、约束或核验失败即回滚并保持停写。
4. 比较迁移前后 ID、行数、分状态金额、归属、时间与凭证引用，必须一致；历史 settled 不释放、不改 pending，不重复创建期初调整；原 pending 继续作为同一 source_id 候选。settling 隔离或按已核验批次恢复占用，不直接释放未知付款记录。
5. 迁移版本标记及确定性 legacy 事件键保证重跑无重复。副本验证同订单同类型新增 sequence=2、3 均成功，旧记录可查、旧快照不改、同事件重试只一条；所有检查通过后方可启用 V2 写入。后续不得用旧二列唯一约束的 schema/写入代码回滚覆盖已存在的多次修正，须按停写及补偿式回滚方案处理。

### 4.2 请求幂等键契约

精确唯一键是 **`(actor_id, action, idempotency_key)`**，不是仅 `(actor_id,action)`。actor_id 取认证会话，action 取服务端定义操作（create/confirm/cancel/mark_paid/clear/correction），不能任由客户端伪造。payload_hash 为规范化有效请求的 SHA-256，包含目标路径资源 ID、金额、方向、版本、业务事件键等完整业务内容；排除 requestId 等追踪字段，JSON 对象键排序规则固定。

同三元键且同 hash：完成请求返回首次保存的状态码/业务结果，不产生第二次调整、付款或状态审计；在途请求等待或返回可重试冲突，不重复执行。**同三元键不同 hash：409 IDEMPOTENCY_CONFLICT，即使仅目标批次或金额改变也冲突**。同 actor/action 使用不同 idempotency_key 可合法发起独立操作，仍受业务事件唯一键与来源 claim 约束；不同 actor/action 的同文本键属于不同命名空间，但不能绕过同事件防重。业务事务回滚时幂等成功结果也回滚，不遗留虚假成功；付款/更正结果记录不得在允许重试的生命周期内清除。

## 5. 状态机与权限

```text
draft（已持久化快照、已占用）→ pending_payment → paid（非零）
                                         → cleared（零）
draft / pending_payment → cancelled（释放占用，快照留存）
paid / cleared → correction_pending → corrected（关联新更正批次完成）
收益/调整：pending → settling → settled；取消 settling → pending
提卡：unsettled + 活跃 claim → settled；取消只释放 claim
```

draft 是待核对，不是可变金额草稿。原型将生成和管理员核对合并成 pending_payment，显式标记此简化。paid/cleared 原始金额和凭证不可覆盖、不可删除、不可取消；corrected 仅表示关联更正完成，原结清事实不回退。更正可拒绝/撤回但须留审计，已入新已付款批次不能撤回。全额冲正也只通过等额反向调整入新批次。

管理员可生成/确认/取消/登记/更正/导出；代理只能查看和导出自己的记录，后端按 session.agentId 强制归属校验，跨代理返回 404，写操作 403；系统任务只读计算/告警，禁止自动标付。金额状态变化需记录操作者、IP、前后值及来源批次。UI 隐藏按钮不构成权限控制。

## 6. 接口 JSON 契约

统一返回 `{ "data": ... , "requestId": "req-1" }`，错误为 `{ "error": { "code": "...", "message": "...", "retryable": false }, "requestId": "req-1" }`。分页使用 cursor/limit（最大100），导出使用同一个 batchId/hash，不重新读实时源金额。

| 方法/路径 | 用途 |
|---|---|
| GET /api/admin/reconciliations/agents?search=&status=&sort=&cursor= | 汇总与筛选，带 cutoffAt |
| GET /api/admin/reconciliations/agents/:agentId/preview?cutoffAt= | 只读候选、跳过、版本 |
| POST /api/admin/reconciliations | 生成快照 |
| GET /api/admin/reconciliations/:id | 摘要、状态、审计、付款信息 |
| GET /api/admin/reconciliations/:id/items?cursor=&limit=&type=&format=csv | 分页/导出不可变明细 |
| PATCH /api/admin/reconciliations/:id | confirm / cancel / mark_paid / clear |
| POST /api/admin/reconciliations/:id/corrections | 关联更正，产生 pending 调整 |
| GET /api/agent/ledger/unsettled | session 代理累计（cutoff、未占用/锁定/跳过分区） |
| GET /api/agent/ledger/period?start=&end= | 独立期间统计与成交分页 |
| GET /api/agent/reconciliations?cursor= | 自己的历史列表 |
| GET /api/agent/reconciliations/:id | 自己的快照，明细/导出子接口同样校验归属 |

预览响应（省略展示字段不代表实际只存汇总）：
```json
{"data":{"agentId":17,"currency":"CNY","cutoffAt":"2026-10-10T08:40:00Z","previewVersion":"pv-1","totals":{"storeEarningCents":84000,"adjustmentCents":-4000,"drawDebtCents":30000,"netCents":50000,"direction":"platform_pays_agent"},"items":[{"type":"earning","id":1001,"version":1},{"type":"earning","id":1002,"version":1},{"type":"adjustment","id":1,"version":1},{"type":"draw_item","id":1,"version":1}],"skipped":[{"orderNo":"SO-X1","code":"MANUAL_REVIEW_REQUIRED","message":"核对渠道凭证后重算"}]},"requestId":"req-1"}
```
生成请求（header `Idempotency-Key: create-17-1`）：
```json
{"agentId":17,"cutoffAt":"2026-10-10T08:40:00Z","previewVersion":"pv-1","items":[{"type":"earning","id":1001,"version":1},{"type":"earning","id":1002,"version":1},{"type":"adjustment","id":1,"version":1},{"type":"draw_item","id":1,"version":1}],"acknowledgedSkipped":["SO-X1"]}
```
生成 201：
```json
{"data":{"id":501,"batchNo":"RC-20261010-001","status":"draft","version":1,"snapshotHash":"sha256:example","netCents":50000,"direction":"platform_pays_agent","itemCount":4},"requestId":"req-2"}
```
管理员核对：`{"action":"confirm","expectedVersion":1,"snapshotHash":"sha256:example"}` 返回 pending_payment/version 2。登记请求（必须二次确认，幂等键独立）：
```json
{"action":"mark_paid","expectedVersion":2,"snapshotHash":"sha256:example","direction":"platform_pays_agent","currency":"CNY","amountCents":50000,"paymentMethod":"bank","paymentReference":"BANK-20261010-88","actualPaymentAt":"2026-10-10T09:00:00Z","note":"线下转账核验完成"}
```
响应：`{"data":{"id":501,"status":"paid","version":3,"netCents":50000,"paymentReference":"BANK-20261010-88"},"requestId":"req-3"}`。净额零提交 `{"action":"clear","expectedVersion":2,"snapshotHash":"sha256:example"}`，禁止 paymentMethod/reference；取消提交 `{"action":"cancel","expectedVersion":2,"reason":"源费用待复核"}`。

更正（header `Idempotency-Key: correction-501-fee-88`；序号作用域为原订单及映射后的调整类型）：
```json
{"sourceItemId":7001,"type":"fee_delta","amountCents":-2000,"reason":"渠道最终手续费补扣","reference":"FEE-88","businessEventKey":"provider:bank:FEE-88","expectedCorrectionSequence":2}
```
201 返回 `{"data":{"correctionId":901,"sequence":2,"originalBatchId":501,"newAdjustmentId":902,"status":"pending","amountCents":-2000},"requestId":"req-4"}`。金额不得反写原快照。

错误：409 SNAPSHOT_CHANGED / ITEM_ALREADY_CLAIMED / INVALID_STATE / IDEMPOTENCY_CONFLICT / CORRECTION_SEQUENCE_CONFLICT / ADJUSTMENT_EVENT_CONFLICT；422 LEDGER_MISMATCH / MANUAL_REVIEW_REQUIRED / PAYMENT_REFERENCE_REQUIRED / INVALID_DIRECTION / EMPTY_BATCH；409 BATCH_NOT_CANCELLABLE；401 未登录、403 无写权限。跳过项可以明确确认后排除，不得静默吞掉异常；若请求含异常行则整体拒绝。付款时间、币种、方式、金额必做服务端校验。

## 7. 迁移 runbook（上线前独立执行，不在普通账本长期展示）

1. **准备/审批**：财务、运维、开发共同签署 cutoff 与维护窗口；备份 SQLite（包含 WAL 一致性备份）、校验可恢复；在副本只读导出旧批次、收益、调整、提卡 bill 与付款凭证并计算校验和。禁止在本设计交付期间操作数据库。
2. **停写**：暂停 scheduler 的 closePreviousWeekIfDue 调用并关闭 close-week 手动 API 和旧创建/标付入口；等待在途事务结束，记录停写时间与最后旧批次。`weekly_settlement_closed` 是进度标记，不是停任务开关，不能只改它冒充停用。新订单可继续产生日志但不得新旧结算同时占用。
3. **核验旧待付**：每个 pending_payment 按线下凭证双人核验。已付者补人民币方式、流水、实际付款时间与审计后标付；未付者取消释放；无法确认者隔离，不得进入 V2 候选。禁止把已线下付款的行释放导致重付。
4. **历史映射**：给旧已付批次建立只读父记录/legacy_source 映射，不重新占用已结收益；用旧 settled/bill 与凭证交叉比对。历史缺失展示字段标记 unknown，不伪造订单快照；未知金额阻断对应代理灰度。
5. **期初校验**：逐代理列出来源 ID、未结收益、调整、提卡、净额、锁定/跳过金额。优先迁移已有来源行，不再另加重复期初调整；仅外部账确实缺失时以唯一 `migration:<cutoff>:<agent>:<source>` 来源导入期初调整，双人签认、幂等防重。
6. **异常隔离**：manual_review、恒等式不一致、缺失行/重占用逐项建立负责人、建议动作与处理状态；不自动纳入。对比迁移前后各分项、净额、已付金额与来源 ID 集合，要求差异为零或有书面解释。
7. **灰度启用**：先一代理验证预览、生成、取消释放、付款凭证、快照、导出与审计；核对后扩容。旧周结持续关闭，系统任务仅告警。观察重复占用、状态冲突、负净额与未核对计数。
8. **归档/回滚门槛**：保存代理、旧/新批次映射、期初三项与净额、跳过清单、凭证、处理人与时间、备份 checksum。未发生 V2 付款时可停新写并恢复备份/配置；发生真实付款后禁止直接回库，先停写对账，以关联调整补偿并重放审计，避免丢失付款事实。

检查表：□ 自动/手动旧入口都关闭 □ 备份恢复演练 □ 旧待付逐单核验 □ 不重复导入期初 □ 异常隔离 □ 金额及来源集合一致 □ 双人签字 □ 灰度通过 □ 已付后补偿式回滚预案。

## 8. 编号验收

| 编号 | 场景与通过条件 |
|---|---|
| ACC-01 | 示例订单分别复算 280/560，商店840−40−300=500；通道90=代理60+平台30 |
| ACC-02 | 负调整、仅商店、仅提卡、净零方向分别正确；零不接受付款字段 |
| ACC-03 | 日期切换不改变累计和快照；明确 cutoff 与北京时间 |
| ACC-04 | 生成后新增100收益：累计600、旧批次500，付款后剩100，不全部清零 |
| ACC-05 | 同一源行两个并发生成只有一个成功，另一个409；事务无部分占用 |
| ACC-06 | 已纳入行源版本变化阻断付款；新行不阻断；取消重建保留旧快照 |
| ACC-07 | 重复付款幂等仅一次 paid/审计；状态 CAS、请求摘要冲突正确 |
| ACC-08 | draft/待付取消释放全部；paid/cleared取消失败；空批次禁生成 |
| ACC-09 | 退款/手续费差额关联原订单、收益行、批次；同单两次修正序号递增，旧快照不改 |
| ACC-10 | 代理跨归属404、调用写API403；系统不能标付；导出权限同详情 |
| ACC-11 | 所有生成/确认/取消/付款/更正审计有actor、IP、前后状态和来源 |
| ACC-12 | CSV 与页面同 snapshotHash/批次号/金额，防公式注入，中文正确；分页不漏重 |
| ACC-13 | migration幂等重跑不新增重复期初，旧线下已付不再次进候选，周结不复活 |
| ACC-14 | 390px/桌面方向金额可见；表转卡、明细可展开、键盘可操作、确认框可取消 |
| ACC-15 | 空/待核对/源变更/生成冲突/已清均有恢复动作，不隐式吞异常 |
| ACC-16 | 原型可切三视图，新增、快照、源变更、人民币登记/二次确认、零、取消、历史/审计/导出、重置可演示，无网络依赖 |
| ACC-17 | 副本迁移后旧 (order_id,type) 唯一索引不存在，旧调整 ID/金额/状态/归属不变；同订单同 fee_correction 类型新增序号2、3均成功，迁移重跑不重复历史行 |
| ACC-18 | 同业务事件同内容即使换请求幂等键也只一条调整/关联；同事件不同内容409；并发同序号仅一条成功，另返回 CORRECTION_SEQUENCE_CONFLICT，撤回不复用序号 |
| ACC-19 | 每条新调整仅从调整表纳入一次，corrections 不重复计金额；已结调整不能进入后续批次，未付取消后允许重建且最终仅结一次，旧快照始终不变 |
| ACC-20 | UNIQUE(actor_id,action,idempotency_key)：同三元键同 hash 返回首次结果，不同 hash（含不同目标批次）409；同操作者同动作不同键可独立成功，仍受事件与 claim 防重；事务失败无虚假幂等成功结果 |

生产验收 ACC-05/07/10/13/17～20 需要实际后端与迁移环境，静态原型不能证明数据库并发、真实鉴权或迁移已完成。
