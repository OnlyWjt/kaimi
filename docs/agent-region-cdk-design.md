# 付款地区卡密（美区 / 智利区）详细设计

> 状态：设计稿，未动代码
> 日期：2026-09-30（同日第二版：写入产品确认结论，重写 §7 页面设计）
>
> **已确认（2026-09-30）**
> 1. 默认区就是**菲区**（菲律宾，`payment_country` 为空）。买家、代理、管理员看到的名字统一叫「菲区」。
> 2. 地区变体的**平台成本、上游进价由管理员自己填**。系统只负责「没填不能上架」。
> 3. **续费套餐不做地区版**，平台后面会把续费套餐全部下架。同步时直接跳过续费档，不生成变体。
> 读者：后续负责实现的开发者 / AI。每个决定都写了理由，改动点精确到文件。
> 相关文档：`docs/多代理即时发卡系统详细设计.md`、`docs/agent-self-draw-design.md`（进行中，只在 §12 提一句）
> 参考实现：兄弟仓库 `danew_card_cdk`，提交 `4a298ca feat(cdk): sync upstream payment-region issuance through v1.4.22`

---

## 0. 一句话概述

卡台（SpaceX 旧协议 OpenAPI）已经支持**发码时指定付款地区**：`POST /gpt-direct/cdks` 多了一个 `payment_country` 字段，`GET /gpt-direct/plans` 多了一个 `payment_regions` 清单。码一旦发出，地区就**写死在这张码上**，兑换时卡台自己按这个地区付款。

本站的做法：**每个「套餐 × 地区」在 `platform_plans` 里是一行独立的「地区变体」**（例如 `plus:us`、`plus:cl`），带上 `upstream_plan_key = 'plus'` 和 `payment_country = 'US'`。定价、代理开关、优惠券、订单快照、收益、进价全部沿用现有按套餐的机制，一行不改。只有三处需要真正理解「地区」：**同步**（从卡台生成/下架变体）、**发卡**（把变体翻译成 `plan + payment_country`）、**店铺展示**（把同一套餐的几个地区合并成一个商品、用规格切换）。

---

## 1. 目标与非目标

### 1.1 目标

1. 平台能卖美区、智利区（以及卡台以后开放的其它地区）的卡密，且和现有默认区（菲律宾）卡密并存。
2. 每个地区**单独定价**：平台默认成本、上游进价、限价、代理成本覆盖、代理零售价、代理开关都按地区独立。
3. 买家在店铺里能清楚地看到、选到地区；订单页、查单页、兑换页都能看到这张码是哪个区的（码的文本本身看不出地区）。
4. 地区清单**以卡台下发为准**，本站不写死；卡台不再下发某个地区时自动停售。
5. **完全向后兼容**：没有配置任何地区变体时，行为与今天逐字节一致；已售订单、已发卡密、兑换流程不受影响。

### 1.2 非目标（一期不做）

- **不做「兑换时选地区」**。地区在发码时就定死了，兑换页不提供地区选择，也不往兑换请求里加字段（§8）。
- **不做 Avanfinity 协议的地区发码**。Avanfinity 没有 `payment_country`（`danew_card_cdk/backend/internal/provider/registry.go` 的 `SupportsPaymentCountry`），本站默认账户是 Avanfinity 时地区变体一律不可售。
- **不做「缺货自动改发默认区」**。改地区等于换商品，必须人工和买家确认（§9.3）。
- **不做优惠券「自动覆盖某套餐的所有地区（含以后新增的）」**。券存的仍是逐个变体，界面只提供「整组勾选」快捷键（§7.7）。
- **不做续费套餐的地区版**（已确认，续费套餐后续全部下架）。
- **不做自动拉取各地区的上游进价**。卡台接口目前不按地区下发实付金额，进价由管理员手填（§5.4）。

---

## 2. 卡台 / danew_card_cdk 里的事实（已核对源码）

### 2.1 能力来源

地区能力来自**卡台本身**，`danew_card_cdk` 只是先接上了。它的提交说明原文：

> Send payment_country only to the legacy card platform. Avanfinity does not support it, so dual-issue no longer treats both bindings as the selected region.

本站和 `danew_card_cdk` 调的是同一套卡台 OpenAPI（`/openapi/v1/gpt-direct/*`），所以直接按卡台字段接，**不要**再造一套本站自己的地区参数。

### 2.2 字段清单

| 位置 | 字段 | 含义 | 出处 |
|---|---|---|---|
| `GET /gpt-direct/plans` 响应 | `payment_regions: [{country, currency}]` | 卡台支持的付款地区。老版本卡台没有这个字段 → 视为空，只剩默认区 | `danew_card_cdk/backend/internal/cardplatform/client.go:241-256`、`:284-291` |
| `POST /gpt-direct/cdks` 请求 | `payment_country: string`（omitempty） | 这批码兑换时用哪个地区付款。**空 = 菲律宾（存量行为）** | 同文件 `:375-380`、`:518` |
| 同上 | 不传 `payment_currency` | 币种由卡台按自己的真相源补；本站猜错会被判「付款地区与币种不匹配」 | 同文件 `:377-379` 注释 |
| `POST /gpt-direct/cdks` 响应 `issued[]` | `id, code, plan, code_prefix, fee_amount_minor` | **不回传地区**。本站要自己记住请求时传了什么 | 同文件 `:392-398` |
| 预检 `POST /gpt-direct/preflight`（直充，非 CDK） | `payment_country` 默认 `PH`、`payment_currency` 默认 `PHP` | 说明默认区就是菲律宾比索 | `danew_card_cdk/docs/danew-openapi-zh.md:813-814`、`:838-839` |

`danew_card_cdk` 前端里出现过的地区码（仅作展示名映射，真实清单以卡台为准）：

```text
PH 菲律宾 / US 美国 / JP 日本 / CL 智利 / EG 埃及 / IN 印度 / KR 韩国
```

出处：`danew_card_cdk/frontend/src/views/admin/CDKeyManagement.vue` 的 `REGION_NAMES`。本期只打算开 **US、CL**，但设计按「任意卡台下发的地区」来做。

### 2.3 关键语义（必须照搬）

1. **空和 `PH` 是两回事**。`danew_card_cdk` 注释：「空 = 菲律宾（存量行为）。空和 'PH' 在这里是两件事：将来卡台若改默认地区，『没指定』和『明确指定了 PH』该走不同的路」。本站默认区变体的 `payment_country` 存空串，发码时**不传**该字段。
2. **地区和选卡偏好是两件独立的事**。`preferred_issuer / preferred_segment_*` 只是购码快照，兑换不读；`payment_country` 兑换时真的会读（「地区在卡台的兑换预检那一步就定死了」，`client.go:376-377`）。`danew_card_cdk` 修过一个 bug：「没配选卡、但指定了智利」时因为不传 pref 而静默退回菲律宾（`handler/cardplatform_cdk.go:250-256`）。本站 `issueMany` 必须在「没有选卡偏好但有地区」时也带上地区。
3. **不支持地区的卡台不能静默按菲律宾出码**。单台发码时主台不支持地区 → 直接 400（`handler/cardplatform_cdk.go:208-216`）。
4. **不在本站校验地区取值**。卡台 `payment_regions` 是唯一真相源；发了不支持的地区，卡台在发码这一步直接拒（`handler/cardplatform_cdk.go:146-149`）。本站只做「在不在最近一次同步的清单里」这一层软校验，用来决定能不能上架，不做第二份硬编码白名单。

### 2.4 danew_card_cdk 目前的范围（供对比）

- 只在**管理员批量发码**（`CardPlatformIssueCDKs`）里加了地区下拉。
- 代理人民币订单（`fulfillAgentOrder`）**没有**传地区——全仓 grep `PaymentCountry` 只出现在管理员发码与双发里。
- 价格没有按地区区分：`PlanInfo.serviceFeeUsdMinor` 仍是每个套餐一个值。

也就是说 `danew_card_cdk` 解决的是「站长手动买一批某区的码」；本站要解决的是「买家在店铺里自助买某区的码」，所以必须把地区做进商品和定价模型里，而不能只加一个发码参数。

---

## 3. 本站现状（已核对源码）

| 事实 | 位置 | 对本需求的影响 |
|---|---|---|
| 发码请求体只有 `plan / count / funding_confirmed / preferred_*` | `apps/web/src/lib/cardplatform/client.ts:225-261` | 要加 `payment_country` |
| `IssueCardPref` 只有 issuer/segment | `client.ts:34-38` | 要加 `paymentCountry` |
| `getPlans()` 只解析 `plans` 和 `registry`，丢掉 `payment_regions` | `client.ts:315-339` | 要把地区清单带出来 |
| 同步：先把所有 cardplatform 行 `cardplatform_sellable=false`，再按 key 逐个置回 | `apps/web/src/lib/cardplatform/plans.ts:15-50` | 变体行 key 不在卡台 `plans` 里，**不改的话每次同步都会被下架** |
| 新同步到的套餐一律 `enabled=false` 插入 | `plans.ts:39-47` | 变体沿用：自动生成但默认不上架 |
| 同步频率：后台调度每 180 秒一次 | `apps/web/src/lib/sync-scheduler.ts:148-166` | 卡台下架地区后最长约 3 分钟本站停售 |
| `platform_plans.plan_key` 唯一，允许字符 `[a-z0-9_:-]` | `apps/web/src/db/schema.ts:156-192`、`apps/web/src/app/api/admin/plans/route.ts:21` | 变体 key 用冒号：`plus:us` |
| 代理定价按 `plan_id` 一行 | `schema.ts:194-224`（`agent_plan_prices`） | 变体天然获得独立的成本覆盖 / 零售价 / 开关 |
| 优惠券按 `plan_key` 关联 | `schema.ts:264-278`（`agent_store_coupon_plans`）、`lib/coupons.ts:91-110` | 变体天然可单独选 |
| 下单：按 `plan_key` 取报价，快照 `plan_key_snapshot`，绑定默认卡台账户 | `apps/web/src/lib/store-orders.ts:63-85`、`:227-229`、`:280`、`:316` | 要额外快照 `upstream_plan_key` 与 `payment_country` |
| 发卡：`client.issueMany(order.planKeySnapshot, …)` | `apps/web/src/lib/fulfillment/fulfill-store-order.ts:160-174` | **这里直接把本站 key 当上游 key 用**，变体 key 发给卡台会被拒 |
| `issued_cdks` 无地区字段 | `schema.ts:444-483` | 要加 `payment_country`，用于展示 |
| 店铺：一个套餐 = 一个商品 = 一个规格，规格 id 就是 `planKey` | `apps/web/src/lib/agent-storefront-config.ts:449-500`、`apps/web/src/app/s/[slug]/page.tsx:100-118` | **规格 UI 已经是多选列表**，只需把同一套餐的多个地区合并成多个规格 |
| 结账用 `activeSpec.id` 作为 `planKey` 下单 / 算券 | `apps/web/src/components/agent-storefront.tsx:561`、`:609-619`、`:1207-1245` | 规格 id = 变体 `planKey`，结账链路零改动 |
| 内置封面按 `planKey` 精确匹配 | `agent-storefront-config.ts:400-418` | `plus:us` 匹配不到，要按 `base_plan_key` 回退 |
| 代理商品名覆盖按 `planKey` | `agent-storefront-config.ts:223-232` | 合并商品用基础 key 的覆盖名 |
| 兑换：按 `code_hash` 找到本站卡 → 用发卡时的账户 → 调卡台公开 `/api/v1/cdk/preview|preflight|redeem` | `apps/web/src/lib/cardplatform/redeem.ts:60-164` | 兑换请求不带地区，**不需要改** |
| 卡台协议只是个标签，两种协议共用同一个 `CardplatformClient` | `apps/web/src/lib/cardplatform/protocol.ts`、`config.ts:25-95` | 地区能力要按账户协议判断，Avanfinity 不传 |
| 选卡策略里的 `issuingArea` 默认 `"United States"` | `apps/web/src/lib/cardplatform/policy-logic.ts:49` | 这是**开卡持卡地区**，和付款地区不是一回事，不要混用（§11） |
| 开放 API `/api/v1/open/plans` 直接列 `platform_plans` 行 | `apps/web/src/app/api/v1/open/plans/route.ts` | 变体会自动出现，要补两个字段 |

---

## 4. 选型：变体行 vs 套餐属性

### 4.1 两个候选

**方案 A：地区变体 = 独立的 `platform_plans` 行（推荐）**

```text
platform_plans
  plan_key   base_plan_key  upstream_plan_key  payment_country  name
  plus       plus           plus               ''               Plus
  plus:us    plus           plus               US               Plus
  plus:cl    plus           plus               CL               Plus
  pro_20x    pro_20x        pro_20x            ''               Pro 20x
  pro_20x:us pro_20x        pro_20x            US               Pro 20x
```

**方案 B：地区是套餐上的属性**

新表 `platform_plan_regions(plan_id, country, cost, upstream_cost, enabled)` + `agent_plan_region_prices(agent_id, plan_id, country, retail, cost_override, enabled)`，订单、卡密、券、提卡都加 `country` 维度。

### 4.2 逐项对比

| 维度 | A 变体行 | B 属性 |
|---|---|---|
| 代理定价 | `agent_plan_prices` 按 `plan_id` 天然独立，**零改动** | 新表，代理后台、管理员授权、限价校验全部重写一遍 |
| 平台成本 / 上游进价 / 限价 | 每行自带 `global_cost_price_cents / upstream_cost_cents / max_retail_price_cents` | 要复制三列到新表，毛利告警（`api/admin/plans/route.ts:160-186`）要改 |
| 店铺商品卡 | 按 `base_plan_key` 分组成一个商品、多个规格；规格 id 仍是 `planKey`，结账不变 | 商品 id 不变，但规格 id 要变成 `planKey+country`，结账、报价、券接口都要加参数 |
| 优惠券 | 按 `plan_key` 勾选，**零改动** | 券要加地区维度或约定「券对所有地区生效」 |
| 订单 / 收益 / 结算 | `plan_key_snapshot` 已能区分；成本、收益全按订单快照算，**零改动** | 订单要加地区快照，所有按 `plan_key` 汇总的报表要改分组 |
| 上游进价差异 | 美区实付（USD）明显高于菲律宾区（PHP），每行一个进价正好 | 同样能做，但多一层 |
| 库存 / 可售 | `cardplatform_sellable` 按行，卡台下架某地区 = 下架那几行 | 要新增按地区的可售位 |
| 兑换 | 码本身绑定地区，兑换不看套餐行 | 同左 |
| 已有订单 / 卡密 | 旧行就是「默认区变体」，不动 | 同左，但需要回填 `country=''` |
| 开放 API / 提卡 | 自动出现新的 `plan_key`，只补说明字段 | 两处都要加参数 |
| 代价 | 同步和发卡要多一层 key 翻译；管理后台行数变多（用分组折叠解决） | 改动面约为 A 的 3 倍 |

### 4.3 结论

采用 **方案 A**。理由（按重要性）：

1. **本站的钱全是按「套餐行」算的**：代理成本、零售价、限价、上游进价、毛利、券、收益快照都挂在 `platform_plans` / `agent_plan_prices` 一行上。地区之间价格差异大（美区官方价 $20 起，菲律宾区按 PHP 计价），它在业务上就是「另一个商品」，做成另一行最贴合。
2. **结账链路零改动**：店铺规格 id 已经就是 `planKey`（`agent-storefront.tsx:561`、`:615`），报价、下单、券、发票都只认 `planKey`。
3. **需要理解地区的地方被压缩到三处**（同步、发卡、展示），其余几十处按 `plan_key` 工作的代码不用碰，回归风险最小。
4. **没有地区变体时行为完全不变**：默认区就是原来那一行，`upstream_plan_key` 为空时回退 `plan_key`，`payment_country` 为空时不传字段。

---

## 5. 数据模型

所有新增列都用 `migrate-lib.ts` 现有的 `addColumn`（吞 duplicate column）方式追加，带默认值，老数据无需回填也能正确工作。

### 5.1 `platform_plans` 新增列

```sql
ALTER TABLE platform_plans ADD COLUMN base_plan_key TEXT NOT NULL DEFAULT '';
-- 同一套餐的分组键。默认区行 = 自己的 plan_key；变体 = 基础套餐的 plan_key。
-- 空串 = 老数据，读取时按 plan_key 处理。

ALTER TABLE platform_plans ADD COLUMN upstream_plan_key TEXT NOT NULL DEFAULT '';
-- 发给卡台的 plan。空串 = 用 plan_key（老数据与默认区行）。

ALTER TABLE platform_plans ADD COLUMN payment_country TEXT NOT NULL DEFAULT '';
-- 卡台 payment_country，大写 ISO 两位码。空串 = 默认区（菲律宾），发码时不传。

ALTER TABLE platform_plans ADD COLUMN region_label TEXT NOT NULL DEFAULT '';
-- 地区中文名，管理员可改。空串时按 §7.0.1 的默认名（菲区 / 美区 / 智利区）。

ALTER TABLE platform_plans ADD COLUMN region_capable INTEGER NOT NULL DEFAULT 0;
-- 这个套餐「有没有地区概念」。同步时写：卡台套餐且不是点数档、不是续费档 → 1；其余 0。
-- 只控制显示（§7.0.3）：为 0 的套餐及其卡密不显示任何地区（点数档显示「菲区」会误导）。
-- 地区变体行恒为 1。本地成品号恒为 0。

ALTER TABLE platform_plans ADD COLUMN region_note TEXT NOT NULL DEFAULT '';
-- 可选的一句话地区说明（≤40 字），店铺选中该规格时显示，例如「以美元结算」。§7.2.1

CREATE INDEX IF NOT EXISTS platform_plans_base_idx ON platform_plans(base_plan_key, sort_order);
```

约束（代码里保证，不建唯一索引，避免迁移时老数据冲突）：

- 对 `fulfillment_kind = 'cardplatform'` 的行，`(coalesce(upstream_plan_key, plan_key), payment_country)` 唯一。
- `payment_country` 与 `upstream_plan_key` 在行创建后**不可修改**（管理后台不提供编辑入口，`POST /api/admin/plans` 的 schema 不接收这两个字段）。要换地区就是另一行。理由：已售订单用 `plan_key_snapshot` 回查时，行的语义不能被偷偷改掉。
- `local_account` 套餐（`finished_gpt`）永远没有地区变体。

变体 `plan_key` 生成规则：`${upstream_plan_key}:${country.toLowerCase()}`，例如 `plus:us`、`pro_20x:cl`。冒号在现有校验正则 `^[a-z0-9_:-]+$` 内；卡台自己的 key 不含冒号，不会撞车。代理后台 URL 里已经用 `encodeURIComponent(plan.planKey)`（`components/agent-sell.tsx:81`），冒号安全。

Drizzle 定义（`apps/web/src/db/schema.ts` 的 `platformPlans`）：

```ts
basePlanKey: text("base_plan_key").notNull().default(""),
upstreamPlanKey: text("upstream_plan_key").notNull().default(""),
paymentCountry: text("payment_country").notNull().default(""),
regionLabel: text("region_label").notNull().default(""),
regionCapable: integer("region_capable", { mode: "boolean" }).notNull().default(false),
regionNote: text("region_note").notNull().default(""),
```

### 5.2 `store_orders` 新增列

```sql
ALTER TABLE store_orders ADD COLUMN upstream_plan_key_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE store_orders ADD COLUMN payment_country_snapshot TEXT NOT NULL DEFAULT '';
```

下单时从变体行写入。发卡**只读快照**，不回查 `platform_plans`。理由：和 `plan_key_snapshot` / 成本快照的原则一致——订单付款后，平台改了套餐行不该影响这单发什么卡。老订单两列为空 → `upstream = plan_key_snapshot`、不传地区，行为与今天一致。

### 5.3 `issued_cdks` 新增列

```sql
ALTER TABLE issued_cdks ADD COLUMN payment_country TEXT NOT NULL DEFAULT '';
```

写入**本次发码请求里实际传给卡台的地区**（卡台响应不回传地区，§2.2）。用途只有展示：订单页、查单、代理「已售卡密」、管理员卡密查询、兑换页提示。老卡密为空 = 默认区。

### 5.4 地区清单缓存

不建表，用现有 `settings`：

```text
key   = cardplatform_payment_regions_{accountId}
value = {"syncedAt":"2026-09-30T05:00:00Z","regions":[{"country":"US","currency":"USD"},{"country":"CL","currency":"CLP"}]}
```

`accountId = 0` 表示环境变量账户（与 `config.ts:72-78` 一致）。只缓存**支持地区的协议**的账户；Avanfinity 账户写空数组。

另加一个平台设置，控制「哪些地区自动生成变体」：

```text
key   = cardplatform_region_whitelist
value = "US,CL"      # 默认值
```

理由：卡台可能一次下发 7 个地区，如果每个套餐 × 每个地区都自动建行，管理后台会被几十行停用的变体淹没。白名单外的地区只在管理后台「地区」面板里显示为「卡台支持、未启用」，管理员勾上才生成。

### 5.5 上游进价

卡台 `plans` 里的 `checkout_amount_minor / checkout_currency`（`danew_card_cdk/.../client.go:234-238`）只描述默认区，**没有按地区的实付金额**。因此：

- 变体创建时 `upstream_cost_cents = NULL`（毛利显示「未配置」，与现有语义一致，`schema.ts:167-168`）。
- `global_cost_price_cents = 0`、`enabled = false`。下单校验已经会拒绝成本 ≤ 0 的套餐（`store-orders.ts:100-105`），所以管理员不填价就不可能被误卖。
- **不要**从默认区行复制价格。美区比菲律宾区贵，复制过去等于默认亏钱上架。

---

## 6. 核心流程

### 6.1 同步：从卡台生成 / 下架变体

改 `apps/web/src/lib/cardplatform/plans.ts` 的 `syncDefaultCardplatformPlans()`：

```text
① client.getPlansWithRegions()  → { plans, regions }
   regions = 账户协议支持地区 ? resp.payment_regions : []
② 写 settings: cardplatform_payment_regions_{accountId}
③ 事务内：
   a. 所有 cardplatform 行 cardplatform_sellable = false        （现有逻辑）
   b. 对每个卡台 plan（现有逻辑）：
        upsert 默认区行 plan_key = plan.key
          新行额外写 base_plan_key = plan.key, upstream_plan_key = plan.key
          老行若 base_plan_key 为空则补上（一次性回填，幂等）
        sellable = plan.enabled
        region_capable = !(点数档 || 续费档)      ← 每次同步都重算，卡台改了分类也能跟上
   c. 对每个卡台 plan × regions 中的每个地区：
        if plan 是点数档 (registry.is_credit) → 跳过（§13 Q3）
        if plan 是续费档 → 跳过（已确认：续费套餐不做地区版，平台后续全部下架）
          判定：registry 元数据 requires_active_subscription === true；
          实现前用线上 /gpt-direct/plans 的真实报文核对字段名，拿不到就按 key/名字含 renew / 续费 兜底
        key = `${plan.key}:${country.toLowerCase()}`
        existing = find(key)
        if !existing and country ∈ whitelist:
            insert { plan_key: key, base_plan_key: plan.key, upstream_plan_key: plan.key,
                     payment_country: country, region_capable: true,
                     name: plan.name, sort_order: plan.sortOrder,
                     enabled: false, global_cost_price_cents: 0, upstream_cost_cents: NULL }
        if existing:
            update { cardplatform_sellable: plan.enabled, sort_order, raw_json, synced_at }
   d. 不在本次 regions 里的变体：保持 ③a 的 sellable=false（即自动停售），不删除
```

要点：

- **变体从不删除**。已售订单用 `plan_key_snapshot` 回查名字（`redeem.ts:52-58`）、`agent_plan_prices` 以 `plan_id` 关联，删除会让历史数据断链。卡台重新开放该地区时下一次同步自动恢复 sellable。
- 默认账户是 Avanfinity → `regions = []` → 所有变体 sellable=false，店铺自动不展示，下单被拒。这正是 `danew_card_cdk` 的「主台不支持就只剩默认」语义。
- 返回值加 `regions: string[]` 与 `variantsCreated`，管理后台同步按钮的提示里带上。

### 6.2 下单

改 `apps/web/src/lib/store-orders.ts`：

- `resolveStoreCheckout` 的 select 增加 `upstreamPlanKey`、`paymentCountry`（`:63-85`）。
- 可售判断不变（`cardplatform_sellable` 已经覆盖了地区是否在清单里）。
- 新增一个硬校验：`paymentCountry !== ''` 时，订单要绑定的卡台账户必须支持地区（§6.4 的 `accountSupportsPaymentCountry`）。不满足 → `unavailable("默认卡台账户不支持付款地区")`，买家看到「这个套餐暂时买不了，请联系店主」。理由：同步到下单之间管理员可能切换了默认账户。
- `insert(storeOrders)` 写入 `upstreamPlanKeySnapshot: offer.upstreamPlanKey || offer.planKey`、`paymentCountrySnapshot: offer.paymentCountry`（`:272-319`）。
- `product_name_snapshot` 与易支付商品名：`Plus（美区）`、`CDK Plus（美区）×2`；菲区同样写「Plus（菲区）」。拼法见 §7.0.4。

### 6.3 发卡

改 `apps/web/src/lib/fulfillment/fulfill-store-order.ts:160-174`：

```ts
const upstreamPlan = claimed.upstreamPlanKeySnapshot || claimed.planKeySnapshot;
const paymentCountry = claimed.paymentCountrySnapshot.trim().toUpperCase();
if (paymentCountry && !accountSupportsPaymentCountry(account)) {
  throw new CardplatformError({
    message: "订单绑定的卡台账户不支持付款地区，已停止发卡",
    errorCode: "CARDPLATFORM_REGION_UNSUPPORTED",
  });
}
const pref = await issuePrefFromAccount(account.id);
const cdks = await client.issueMany(upstreamPlan, remaining, idempotencyKey, {
  ...(pref ? { issuer: pref.issuer, segmentType: pref.segmentType, segmentKey: pref.segmentKey } : {}),
  ...(paymentCountry ? { paymentCountry } : {}),
});
```

- `requestSummaryJson` 加 `upstreamPlan`、`paymentCountry`，方便排障。
- 写 `issued_cdks` 时 `planKey` 仍写 `order.planKeySnapshot`（变体 key，保证「按套餐看卖了多少」统计正确），另写 `paymentCountry`。
- 幂等键规则不变：一单只会有一个地区，同一订单的续发请求体一致。

改 `apps/web/src/lib/cardplatform/client.ts`：

```ts
export type IssueCardPref = {
  issuer?: string;
  segmentType?: string;
  segmentKey?: string;
  /** 卡台 payment_country。空 = 默认区（菲律宾），此时请求里不带这个字段。 */
  paymentCountry?: string;
};

// issueMany body
...(pref?.paymentCountry?.trim()
  ? { payment_country: pref.paymentCountry.trim().toUpperCase() }
  : {}),
```

**注意**：不能写成「有选卡偏好才传 pref」。上面的调用把地区和选卡偏好合并成一个对象，地区单独存在时也会发出去（§2.3 第 2 条）。

### 6.4 协议判断

新增 `apps/web/src/lib/cardplatform/protocol.ts`：

```ts
/** 付款地区只存在于旧台 OpenAPI。Avanfinity 带上会被拒或被忽略后按菲律宾扣款。 */
export function supportsPaymentCountry(protocol: string) {
  return normalizeCardplatformProtocol(protocol) === "spacexcard-legacy";
}
```

`accountSupportsPaymentCountry(account)`：`account.id === 0`（环境变量账户）视为旧台；否则按 `account.protocol`。

### 6.5 地区失效时的处理

| 时机 | 现象 | 处理 |
|---|---|---|
| 同步时卡台不再下发某地区 | 变体 sellable=false | 店铺隐藏；代理后台显示「卡台已停售」；已付款订单不受影响（继续按快照发） |
| 买家已付款，发码时卡台拒绝该地区 | `issueMany` 抛业务错误 | 见 §9.3 |
| 默认账户换成 Avanfinity | 下次同步 regions=[] | 变体全部停售；在途订单绑定的是旧账户 id，按旧账户发 |

---

## 7. 页面设计

本节按「谁在哪个页面看到什么」逐页写，包含桌面、手机、空状态和异常状态。ASCII 图只表达结构与文案，样式沿用各页现有的 class（`km-sf-*`、`km-acp-*`、`km-panel`），不引入新设计语言。

### 7.0 通用规则

#### 7.0.1 地区命名（全站唯一来源：`lib/cardplatform/regions.ts` 的 `regionDisplay()`）

| `payment_country` | 中文名 | 英文名 | 徽标短码 | 说明 |
|---|---|---|---|---|
| `''`（空） | 菲区 | Philippines | PH | 已确认的默认区。卡台不传地区时就是菲律宾结账 |
| `US` | 美区 | United States | US | |
| `CL` | 智利区 | Chile | CL | |
| 其它 | `{country}区` | `{country}` | `{country}` | 白名单外的新地区，管理员上架前应改中文名 |

- `platform_plans.region_label` 非空时**覆盖中文名**。英文名一期固定走上表，不做英文覆盖。
- 默认区的行 `region_label` 也可以改，但默认值就是「菲区」，不需要改。
- 所有页面都调同一个函数，禁止在组件里自己写 `country === "US" ? "美区" : …`。

```ts
export type RegionDisplay = { country: string; code: string; zh: string; en: string };
export function regionDisplay(country: string, regionLabel = ""): RegionDisplay;
```

#### 7.0.2 地区徽标 `<RegionBadge>`（新组件 `components/region-badge.tsx`）

```text
 ┌────────────┐   ┌────────────┐   ┌──────────────┐
 │ PH  菲区   │   │ US  美区   │   │ CL  智利区   │
 └────────────┘   └────────────┘   └──────────────┘
   等宽两位码 + 名称；compact 版只显示「PH」「US」「CL」
```

- **不用国旗 emoji**。Windows 上国旗 emoji 渲染成两个字母，而且字体差异大。用等宽两位码更稳。
- 颜色：三种地区用三个低饱和底色区分（PH 中性灰、US 冷色、CL 暖色），取现有 CSS 变量派生，暗色主题下同样可读。颜色只是辅助，文字本身能区分。
- 两个尺寸：`size="sm"`（表格、卡密旁）、`size="md"`（规格行、筛选条）。
- `compact` 属性：只显示短码，`title` 提示完整名。用于手机商品卡、窄表格。

#### 7.0.3 什么时候显示地区

**卡台卡密一律显示地区，包括菲区。** 理由：地区在出卡时就写死在码上，买家、代理、管理员都需要随时知道一张码是哪个区的；「只在有多个地区时显示」会让同一个页面有时有标签有时没有，更难懂。老卡密 `payment_country=''` 就是菲区发的，标「菲区」是准确的。

判断依据是 `platform_plans.region_capable`（§5.1）：

| 场景 | 显示 |
|---|---|
| `region_capable=1` 的套餐（普通 ChatGPT 卡台套餐及其地区变体）的规格名 | 地区名（菲区 / 美区 / 智利区），不再用「预设规格」 |
| `region_capable=0` 的套餐：点数档、续费档（下架前）、本地成品号 | 不显示地区，规格名保持「预设规格」 |
| 本站发出的卡密，所属套餐 `region_capable=1`，或 `payment_country` 非空 | 地区徽标 |
| 本站发出的卡密，其它情况 | 不显示地区 |
| 非本站卡密（兑换页里查到的外部码） | 不显示地区（我们不知道） |

卡密所属套餐按 `issued_cdks.plan_key → platform_plans.plan_key` 查。各列表查询已经在按 `plan_key` 取套餐名，顺带多取一列即可。

> 如果上线后觉得只有菲区的商品显示「菲区」一词多余，只需把 §7.1.4 的规格名规则改一行：「同组只有菲区时显示预设规格」。其它页面不受影响。

#### 7.0.4 商品名与地区的拼法

| 位置 | 拼法 | 例子 |
|---|---|---|
| 店铺商品标题 | 只写套餐名 | Plus |
| 订单商品名快照 `product_name_snapshot`、易支付商品名 | 套餐名（地区） | Plus（美区） |
| 后台列表、通知、账单、CSV | 套餐名 · 地区 | Plus · 美区 |
| 英文 | `Plus · United States` | |

`lib/cardplatform/regions.ts` 同时导出 `planWithRegion(name, country, regionLabel, style: "dot" | "paren")`，各处统一调用。

---

### 7.1 买家：店铺商品列表 `/s/[slug]`

#### 7.1.1 合并规则

**一个基础套餐一个商品卡，地区是规格。** 理由：买家的心智是「我要买 Plus」，然后才是选哪个区；拆成三张同名卡，列表会很乱，还要靠标题区分。店铺已有规格选择 UI（`agent-storefront.tsx:1207-1250`），规格 id 就是 `planKey`，结账接口不用改。

#### 7.1.2 桌面商品卡

```text
┌────────────────────────┐   ┌────────────────────────┐
│                        │   │                        │
│      [Plus 封面]       │   │     [Pro 20x 封面]     │
│                        │   │                        │
├────────────────────────┤   ├────────────────────────┤
│ Plus                   │   │ Pro 20x                │
│ 官方直充               │   │ 官方直充               │
│ [PH][US][CL]           │   │ [PH]                   │  ← 只有菲区也显示，规则见 §7.0.3
│ ¥128.00 起   ⚡自动发货 │   │ ¥1288.00   ⚡自动发货  │  ← 单规格不写「起」（现有 priceFrom 逻辑）
└────────────────────────┘   └────────────────────────┘
```

- 地区徽标行用 `compact` 版，按 §7.1.4 的规格顺序排列，最多 4 个，多出显示「+2」。
- 价格仍然是「组内最低价 + 起」（现有 `:1080` 逻辑），不改。
- 启用地区筛选（§7.1.3）时，卡片价格改为**该地区的价格**，去掉「起」，徽标行只高亮该地区。

#### 7.1.3 地区筛选条（新增）

只有店里在售商品**合计出现两个及以上地区**时才出现，放在现有分类筛选条下方：

```text
 分类   [全部] [ChatGPT] [Codex]
 地区   [全部地区] [PH 菲区] [US 美区] [CL 智利区]
```

- 与分类筛选是「且」的关系。
- 选中某地区：只显示包含该地区规格的商品；卡片价格显示该地区价；打开详情时自动选中该地区规格。
- 状态写进 URL `?region=us`（`ph` 表示菲区），便于代理把「美区专用链接」发给客户；同时记到 `localStorage["km-sf-region:{slug}"]`，下次打开同一家店自动带上。URL 优先于 localStorage。
- 「全部地区」清掉 URL 参数和本地记忆。
- 筛选后没有商品：显示空状态「这个地区暂时没有在售商品」+ 按钮「看全部地区」。

#### 7.1.4 规格顺序与规格名

1. 组内排序：菲区永远第一；其余按 `sort_order`，再按 `payment_country` 字母序。
2. 规格名：卡台套餐取 `regionDisplay().zh / en`；本地成品号保持「预设规格 / Standard」。
3. 组的名字、描述、封面、分类都取**组内菲区行**；组内没有菲区行（例如菲区被停售了）时取排序第一的行。

#### 7.1.5 手机商品列表

```text
┌──────────────────────────────┐
│ 分类 [全部][ChatGPT][Codex]→ │  ← 横向滚动
│ 地区 [全部][PH][US][CL]    → │  ← 手机只显示短码，节省宽度
├──────────────┬───────────────┤
│ [Plus 封面]  │ [Pro 封面]    │
│ Plus         │ Pro 20x       │
│ PH US CL     │ PH            │
│ ¥128 起      │ ¥1288         │
└──────────────┴───────────────┘
```

---

### 7.2 买家：商品详情与规格选择

#### 7.2.1 桌面详情

```text
┌ Plus ──────────────────────────────────────────────────────────────┐
│ [封面]            Plus                                             │
│                   官方直充 · 官方渠道                              │
│                   ¥168.00 CNY                                      │  ← 随选中规格变化
│                                                                    │
│                   选择付款地区                                     │  ← 所有规格都是地区时，标题从「选择规格」改成这个
│                   ┌──────────────────────────────────────────────┐ │
│                   │ [PH] 菲区                 有货 ⚡自动  ¥128.00 │ │
│                   ├──────────────────────────────────────────────┤ │
│                   │ [US] 美区  ✓              有货 ⚡自动  ¥168.00 │ │  ← 选中态：现有 km-sf-spec-row 的 active 样式
│                   │      以美元结算                                │ │  ← region_note，选中时才展开显示
│                   ├──────────────────────────────────────────────┤ │
│                   │ [CL] 智利区               有货 ⚡自动  ¥138.00 │ │
│                   └──────────────────────────────────────────────┘ │
│                                                                    │
│                   ┌ ⓘ ─────────────────────────────────────────┐   │
│                   │ 你选的是【美区】卡密。付款地区在出卡时写进 │   │
│                   │ 卡密，兑换时按美区结账，买错不能换区。     │   │
│                   │ 不确定选哪个，先问店主。                   │   │
│                   └────────────────────────────────────────────┘   │
│                                                                    │
│                   数量 [- 1 +]                                     │
│                   邮箱 [____________________]                      │
│                   [ 购买 美区 · ¥168.00 ]                          │  ← 按钮带地区与小计
└────────────────────────────────────────────────────────────────────┘
```

- **提示框**只在组内有两个及以上地区时出现，文案里的地区名随选中规格变化。只有菲区的商品不出现提示框（没有选错的可能）。
- **`region_note`**（§5.1 新增的可选列，管理员填，例如「以美元结算」「适合美区 Apple ID」）：非空才显示，只在选中的规格下展开一行，避免列表太长。
- **购买按钮**文案带地区：`购买 {地区} · {小计}`。数量变化时小计同步变。
- **默认选中哪个规格**，优先级从高到低：
  1. URL `?plan=plus:us`（精确到规格，新增，代理可以发直达链接）；
  2. 地区筛选条 / URL `?region=us`；
  3. 本店 localStorage 记住的上次地区；
  4. 菲区；
  5. 第一个规格。
  命中的规格不在这个商品里时往下一级找。

#### 7.2.2 下单前确认

店铺现有的下单确认弹窗（`.shots/sf-zh-modal.png` 那一步）里加**强提醒**：醒目的地区横幅，外加一个必须勾选的确认框，不勾就不能付款。

```text
┌ 确认订单 ─────────────────────────────────────┐
│ ┌───────────────────────────────────────────┐ │
│ │  付款地区   [US] 美区                      │ │  ← 横幅：警示底色 + 大号字，放在弹窗最上面
│ │  兑换时按美区结账，付款后不能换区、不能退换 │ │
│ └───────────────────────────────────────────┘ │
│ 商品      Plus                                │
│ 数量      2                                   │
│ 邮箱      buyer@example.com                   │
│ 合计      ¥336.00                             │
│                                               │
│ [ ] 我已确认购买的是【美区】卡密，买错不能换区 │  ← 默认不勾，文案里的地区名随订单变化
│                                               │
│                  [返回修改]  [去付款]（置灰）  │  ← 勾选后才可点
└───────────────────────────────────────────────┘
```

规则：

| 项 | 规则 |
|---|---|
| 什么时候要勾 | 商品组内有 **≥2 个在售地区**时，所有地区（包括菲区）都要勾。理由：只要有选错的可能就要确认，买菲区的人也可能本来想买美区 |
| 什么时候不要勾 | 商品只有一个地区，或者是 `region_capable=0` 的套餐（点数档、成品号）：只显示「付款地区」一行，不显示横幅，也不要求勾选 |
| 记不记住 | **不记住**。每次打开确认弹窗都重新勾，包括同一个买家连续下单 |
| 改地区后 | 用户点「返回修改」换了地区，再次打开时勾选状态重置 |
| 没勾就点付款 | 按钮本身是置灰的；如果用户点了置灰按钮，确认框抖动一下、变红框，下方出现「请先确认付款地区」 |
| 横幅颜色 | 菲区用中性警示色，美区、智利区等非默认地区用更醒目的警示色（非默认地区选错的代价更高） |
| 服务端 | `POST /api/public/store-orders` 增加 `regionConfirmed: true` 字段。商品组有多个地区时不带这个字段 → 400「请确认付款地区」。防止老前端缓存或脚本绕过勾选。服务端用下单时的套餐行判断「组内在售地区数」，与前端同一规则 |
| 留痕 | `store_orders` 不加列；在下单的审计 / 日志 metadata 里记 `regionConfirmed: true`，出现纠纷时可以查 |

**详情页也要配合**：选中非菲区规格时，§7.2.1 的提示框换成警示色；购买按钮上方的小计行写成「美区 · ¥168.00」。确认弹窗是最后一道关，详情页负责提前让人注意到。

#### 7.2.3 手机详情（底部弹层）

```text
┌──────────────────────────────┐
│ ── (拖动条)                  │
│ [封面缩略] Plus              │
│            ¥168.00           │
│ 选择付款地区                 │
│ ┌──────────────────────────┐ │
│ │ [PH] 菲区        ¥128.00 │ │
│ │ 有货 · ⚡自动             │ │  ← 手机规格行两行排版
│ ├──────────────────────────┤ │
│ │ [US] 美区 ✓      ¥168.00 │ │
│ │ 有货 · ⚡自动 · 以美元结算 │ │
│ ├──────────────────────────┤ │
│ │ [CL] 智利区      ¥138.00 │ │
│ │ 有货 · ⚡自动             │ │
│ └──────────────────────────┘ │
│ ⓘ 美区卡密按美区结账，买错   │
│   不能换区。                 │
│ 数量 [- 1 +]  邮箱 [______]  │
├──────────────────────────────┤
│ 美区 · ¥168.00   [ 购买 ]    │  ← 吸底栏，左侧写明地区
└──────────────────────────────┘
```

#### 7.2.4 停售与缺货

- 卡台停售的地区（`cardplatform_sellable=false`）**不出现在规格列表里**（店铺查询本来就过滤了）。不做灰显，理由是买家对「暂停」的规格没有任何可操作项。
- 组内所有地区都停售 → 整个商品从列表消失（与今天单套餐停售一致）。
- 用户通过 `?plan=plus:cl` 直达、但智利区刚停售 → 按 §7.2.1 的优先级落到下一个规格，并在提示框上方显示一行小字「智利区暂停销售，已为你切到菲区」。

#### 7.2.5 英文店铺文案

| 中文 | English |
|---|---|
| 选择付款地区 | Choose payment region |
| 你选的是【美区】卡密… | This is a **United States** code. The payment region is fixed when the code is issued and used at redemption. It can't be changed after purchase. |
| 购买 美区 · ¥168.00 | Buy · United States · ¥168.00 |
| 付款地区 | Payment region |
| 兑换时按美区结账，付款后不能换区、不能退换 | Redeemed as United States. Region can't be changed or refunded after payment. |
| 我已确认购买的是【美区】卡密，买错不能换区 | I confirm this is a **United States** code and the region can't be changed. |
| 请先确认付款地区 | Please confirm the payment region first |
| 全部地区 | All regions |
| 这个地区暂时没有在售商品 | Nothing on sale in this region right now |
| 智利区暂停销售，已为你切到菲区 | Chile is paused. Switched to Philippines. |

#### 7.2.6 实现要点（店铺）

`app/s/[slug]/page.tsx:100-118` 目前是 `sellablePlans.map(planToProduct)`，改成 `plansToProducts(sellablePlans, …)`，放在 `lib/agent-storefront-config.ts`：

1. 按 `basePlanKey || planKey` 分组，组内按 §7.1.4 排序。
2. 每组一个 `StorefrontProduct`：`id = basePlanKey || planKey`；名字、描述、封面、分类按 §7.1.4 第 3 条取。
3. `specs = 组内每行 → { id: planKey, name: 规格名, priceCents: retailPriceCents, auto: true, stock: null, region: { country, code, zh, en, note } }`。`StorefrontSpec` 类型加可选 `region` 字段；本地成品号没有这个字段。
4. `coverFromPlan` 先查 `PLAN_COVERS[planKey]`，查不到再查 `PLAN_COVERS[basePlanKey]`（`agent-storefront-config.ts:411-418`）。
5. 代理商品名覆盖 `productNames` 按 `basePlanKey` 查。
6. `agent-storefront.tsx`：规格行渲染 `<RegionBadge>`；`specs.every(s => s.region)` 时标题改为「选择付款地区」；提示框、按钮文案、确认弹窗、地区筛选条、URL 参数都在这个组件里。
7. 老链接兼容：之前的 URL 若带单规格商品的 id（`plus`），现在 `plus` 是组 id，照样打开。

---

### 7.3 买家：订单结果页（付款后 / 订单号打开）

```text
┌ 订单 KM20260930xxxx ─────────────────────── 已发卡 ┐
│ Plus（美区） × 2                        ¥336.00    │
│ 付款地区 [US] 美区                                  │  ← 整单一个地区，放在标题下
│                                                      │
│ 卡密                                   [复制全部]    │
│ ┌──────────────────────────────────────────────────┐ │
│ │ GPTD-AB12-CD34-EF56-XXXX   [US]   [复制]         │ │  ← 每张码旁再标一次，截图外发也不丢信息
│ │ GPTD-GH78-IJ90-KL12-YYYY   [US]   [复制]         │ │
│ └──────────────────────────────────────────────────┘ │
│ ⓘ 这是美区卡密，兑换时按美区结账。                  │
│                                   [ 去兑换 → ]       │
└──────────────────────────────────────────────────────┘
```

- 数据：订单级地区来自 `store_orders.payment_country_snapshot`；卡密级来自 `issued_cdks.payment_country`。两者正常情况下一致，卡密级优先（排障时能看出不一致）。
- 「复制全部」**只复制码**，一行一个，不带地区文字。买家复制后多半直接粘去兑换，带了文字反而要手动删。
- 菲区订单同样显示「付款地区 [PH] 菲区」，底部提示改成「这是菲区卡密。」，不写结账币种。
- 发卡中 / 发卡失败状态：地区行照常显示，便于买家找店主时说清楚买的是哪个区。

手机：同结构，卡密行里「[US]」放到码的下一行左侧，「复制」按钮保持在右侧。

### 7.4 买家：邮箱查单 / 订单列表

```text
┌ 用 buyer@example.com 查到 3 个订单 ────────────────────────┐
│ 09-30 14:02  Plus（美区）× 2     [US]   ¥336.00   已发卡 > │
│ 09-28 20:11  Plus（菲区）× 1     [PH]   ¥128.00   已发卡 > │
│ 09-20 09:40  Pro 20x × 1         [PH]   ¥1288.00  已发卡 > │  ← 老订单：快照为空，显示 PH
└────────────────────────────────────────────────────────────┘
```

- 老订单的 `product_name_snapshot` 没有地区后缀，不回写，徽标列负责补上地区信息。
- 点进去就是 §7.3。

### 7.5 买家：兑换页 `/recharge`

预检摘要（`summarizePreview`，`redeem.ts:187-199`）增加 `paymentCountry`、`regionLabel`。本站卡密从 `issued_cdks.payment_country` 读；非本站卡密不返回，页面不显示这一行。

```text
┌ 卡密信息 ──────────────────────────────────┐
│ 卡密      GPTD-AB12…XXXX                   │
│ 状态      未使用                           │
│ 套餐      Plus                             │
│ 付款地区  [US] 美区                        │  ← 新增
│                                            │
│ ⓘ 这张卡密按美区结账，与你账号所在地无关。  │  ← 仅非菲区显示
│                              [ 下一步 ]     │
└────────────────────────────────────────────┘
```

- 兑换流程本身不变（§8），这里只是让买家在兑换前看清楚。
- 兑换失败时，若卡台错误信息里带地区 / 币种字样，错误框下方追加一行「这张是美区卡密，如有疑问请联系售卡店铺」。不做任何自动处理。

---

### 7.6 代理：售价设置 `/agent/sell`（`components/agent-sell.tsx`）

**更正上一版**：代理在这个页面**只能改零售价**，不能自己开关套餐。「开不开放给某个代理」是管理员在「代理管理」里勾的（`agent_plan_prices.enabled`），页面上的「未开放」就是管理员没勾。这一点地区版本不改变。

#### 7.6.1 桌面

```text
┌ 在售套餐 ─────────────────────────── 只能填在成本和上限之间 [保存售价] ┐
│ 套餐 / 地区        成本       可填               零售价       状态      │
├─────────────────────────────────────────────────────────────────────────┤
│ Plus                                   店里显示为一个商品，3 个地区规格  │  ← 组标题行，不可编辑
│   [PH] 菲区        ¥118.00    ¥118.00 – ¥200.00  [ 128.00 ]   可售      │
│   [US] 美区        ¥150.00    ¥150.00 – ¥260.00  [ 168.00 ]   可售      │
│   [CL] 智利区      ¥125.00    ¥125.00 – ¥220.00  [ 138.00 ]   平台暂时缺货│
├─────────────────────────────────────────────────────────────────────────┤
│ Pro 20x                                                                  │
│   [PH] 菲区        ¥1180.00   不限价             [ 1288.00 ]  可售      │
│   [US] 美区        —          —                  [   —    ]   未开放    │  ← 管理员没给这个代理勾，灰行
└─────────────────────────────────────────────────────────────────────────┘
```

- 分组依据 `basePlanKey`；组内顺序同 §7.1.4。
- 组标题行右侧写「店里显示为一个商品，N 个地区规格」，N 只算状态为「可售」的行。N=0 时写「店里暂不显示」。
- 状态沿用现有 `planStatus()` 的三态（可售 / 平台暂时缺货 / 未开放），不新增状态。
- 只有一个地区的组：仍显示组标题行 + 一行菲区，保持版式一致。
- 本地成品号套餐不分组、不显示徽标，保持今天的单行。
- 「保存售价」逻辑不变（逐个 `PATCH /api/agent/plans/{planKey}`，`planKey` 已 `encodeURIComponent`，冒号安全）。报错文案里的套餐名改用「Plus · 美区」。

#### 7.6.2 新地区刚开放时

管理员给代理开放了一个新地区后，代理第一次打开售价页，页面顶部显示一次性提示条（按 `planKey` 记在 localStorage，关掉就不再出现）：

```text
┌ ⓘ 新开放：Plus · 美区、Plus · 智利区。零售价已按成本预填，建议改成你的售价再保存。 [知道了] ┐
```

零售价预填规则沿用现有授权逻辑（`/api/admin/plans/grant` 写入 `agent_plan_prices` 时的默认零售价），本设计不改。

#### 7.6.3 手机

表格保持横向滚动（现有 `overflow-x-auto`）；组标题行固定在左侧列宽内，不跟随横滚，方便看清当前是哪个套餐。

### 7.7 代理：优惠券编辑 `/agent/sell/coupon`（`components/agent-coupon-composer.tsx`）

适用套餐选择器按组展示，多一个「整组」快捷勾选：

```text
适用套餐
┌──────────────────────────────────────────────────────┐
│ Plus      [✓ 全部地区]  [✓ PH 菲区] [✓ US 美区] [✓ CL 智利区] │
│ Pro 20x   [  全部地区]  [✓ PH 菲区]                   │
│ 成品号    [  预设规格]                                │
└──────────────────────────────────────────────────────┘
```

- 「全部地区」只是界面快捷键：勾上 = 勾上该组当前所有可售地区；组内全勾上时它自动显示为勾选。**存进数据库的仍然是逐个 `planKey`**，券的校验逻辑（`coupons.ts`）不改。
- 后来新开放的地区**不会**自动加进老券。理由：新地区成本不同，券面额可能直接让它亏本。券列表里对「组内有地区没被勾」的券显示提示 pill「Plus 新增了智利区，未包含」，点进去可以补勾。这个提示放进现有 `item.warnings`，沿用「提醒，不拦」的样式。
- 券卡片上的套餐 chip：组内全选时合并成一个「Plus（全部地区）」；否则逐个显示「Plus · 美区」。

### 7.8 代理：已售卡密 `/agent/codes`（`components/agent-codes.tsx`）与订单列表

```text
┌ 已售卡密 ──────────────────────── 地区 [全部 ▾] 状态 [全部 ▾] [导出 CSV] ┐
│ 时间         订单            套餐     地区     卡密            状态       │
│ 09-30 14:02  KM2026…01       Plus     [US]     GPTD-AB12…XXXX  未使用     │
│ 09-30 14:02  KM2026…01       Plus     [US]     GPTD-GH78…YYYY  已兑换     │
│ 09-28 20:11  KM2026…88       Plus     [PH]     GPTD-QW12…ZZZZ  已兑换     │
└──────────────────────────────────────────────────────────────────────────┘
```

- 新增「地区」列和地区筛选（选项只列出本代理实际卖过的地区）。
- 「套餐」列显示基础套餐名，不再带地区（地区单独一列，便于排序筛选）。
- CSV 增加 `payment_region` 列，值用中文名（菲区 / 美区 / 智利区），同时加 `payment_country` 列（PH 写成空串以外的 `PH`，便于表格软件筛选）。
- 代理的订单列表、概览页「最近订单」里商品名用 `product_name_snapshot`（新订单已是「Plus（美区）」），后面加 `sm` 徽标。

### 7.9 代理：店铺装修里的商品名 / 封面覆盖

- 商品名覆盖按基础套餐（`basePlanKey`）一条，编辑框旁写「作用于 Plus 的所有地区」。地区不能单独改名（§13 Q8）。
- 商品列表预览（装修页右侧的店铺预览）直接复用 §7.1 的合并结果，代理能看到最终效果。

### 7.10 买家 / 代理：卡密状态查询 `/cdk`、`/s/[slug]/cdk`（`components/cdk-lookup-form.tsx`）

查询结果里「套餐」下面加一行「付款地区」，规则同 §7.5：本站码显示徽标，外部码不显示。`/api/cdk/lookup` 响应加 `paymentCountry`、`regionLabel`。

---

### 7.11 管理员：套餐价格与上限（`components/plan-default-prices.tsx`）

这是地区功能的主控制台。管理员在这里看卡台给了哪些地区、给变体**自己填成本**、上架。

#### 7.11.1 顶部「卡台地区」面板（新增，在套餐表上方）

```text
┌ 卡台付款地区 ──────────────────────────────────────── 上次同步 13:02 [立即同步] ┐
│ 默认卡台账户：主账户（旧台协议，支持付款地区）                                   │
│                                                                                   │
│ 卡台现在支持：  [PH] 菲区（默认，始终可用）                                       │
│                 [✓] [US] 美区   USD                                               │
│                 [✓] [CL] 智利区 CLP                                               │
│                 [ ] [JP] JP区   JPY    ← 白名单外，勾上并保存后才生成 JP 版本      │
│                                                                   [保存地区设置]  │
│ ⓘ 勾选的地区会给每个非续费、非点数套餐生成一个「待定价」版本，默认不上架。        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

其它状态：

| 状态 | 面板显示 |
|---|---|
| 默认账户是 Avanfinity | 「默认卡台账户是 Avanfinity 协议，不支持付款地区。已有的地区版本全部自动停售。」地区勾选框禁用 |
| 卡台没下发 `payment_regions` | 「卡台暂未提供付款地区（可能未升级）。」 |
| 某个已勾选地区这次同步没出现 | 该行显示「卡台已停售」灰标，勾选状态保留 |

#### 7.11.2 「待定价」提醒条

同步新生成变体后，套餐表上方出现：

```text
┌ ⚠ 有 4 个地区版本等你填成本：Plus · 美区、Plus · 智利区、Pro 20x · 美区、Pro 20x · 智利区   [只看待定价] ┐
```

「只看待定价」把表格过滤到成本为 0 的变体行。所有变体都填了成本后提醒条消失。

#### 7.11.3 分组套餐表

```text
┌ 套餐价格与上限 ────────────────────────────────────────────────────────────────────────────────────────────┐
│ 套餐 / 地区          规格名      卡台   店铺分类    默认成本     上游进价     零售价上限   平台可售  开放              │
├────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ Plus  plus         3 个地区 · 2 个已启用        [ChatGPT ]                                     [整组开放给全部代理] │  ← 组行
│   [PH] 菲区          [菲区    ]  可售               [118.00]     [112.00]     [200.00]     [✓]启用  [开放给全部代理]  │
│   [US] 美区          [美区    ]  可售               [150.00]     [142.00]     [260.00]     [✓]启用  [开放给全部代理]  │
│        plus:us  地区说明 [以美元结算            ]                                                              │  ← 变体第二行：key + region_note
│   [CL] 智利区 待定价 [智利区  ]  可售               [  0.00]!    [      ]     [      ]     [ ]启用                    │  ← 成本为 0：输入框红框，启用框禁用
│        plus:cl  地区说明 [                      ]                                                              │
├────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Pro 20x  pro_20x   2 个地区 · 1 个已启用        [ChatGPT ]                                                  │  ← 折叠态
├────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   Codex 点数 500     —           可售   [Codex   ]  [45.00]      [42.00]      [      ]     [✓]启用  [开放给全部代理]  │  ← 点数档：不分组、无地区
│   成品号             —           本地库存 [成品号 ] [60.00]      [      ]     [      ]     [✓]启用               │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  [保存价格和上限]  [把当前进价补到历史订单]  [把已启用套餐开放给全部代理]
```

逐列说明：

| 列 | 组行 | 菲区行 | 地区变体行 |
|---|---|---|---|
| 套餐 / 地区 | 折叠箭头 + 基础名 + `base_plan_key` | 徽标 + 地区名 | 徽标 + 地区名；成本为 0 时追加「待定价」橙色 pill |
| 规格名 | 「N 个地区 · M 个已启用」 | `region_label` 输入框，占位「菲区」 | `region_label` 输入框，占位为 §7.0.1 的默认中文名 |
| 卡台 | — | 可售 / 不可售 | 可售 / 卡台已停售（灰） |
| 店铺分类 | **输入框只在组行**，保存时写入组内所有行 | 只读，显示组的分类 | 同左 |
| 默认成本 | — | 输入 | 输入，**必填**。0 或空时红框 |
| 上游进价 | — | 输入 | 输入，可空（空 = 毛利「未配置」，只提示不拦） |
| 零售价上限 | — | 输入 | 输入，可空 |
| 平台可售（启用） | — | 勾选 | 勾选；成本为 0 时禁用，悬停提示「先填默认成本」 |
| 开放 | 「整组开放给全部代理」：只开放组内已启用的行 | 现有按钮 | 现有按钮 |

- 变体行的第二行放 `plan_key`（等宽小字）和「地区说明」输入框（`region_note`，≤40 字，店铺规格选中时显示，§7.2.1）。
- 「地区」（`payment_country`）和 `upstream_plan_key` 在界面上**只读、不提供编辑**（§5.1 约束）。
- 默认全部组展开。组数超过 8 个时默认折叠，只展开有「待定价」的组。折叠状态记在 localStorage。
- 分类只在组行编辑的理由：店铺是按组合并成一个商品的，组内分类不一致时商品该归哪一类说不清。
- 校验与告警：
  - 前端：变体勾选启用且成本 ≤ 0 → 阻止保存，定位到该行。
  - 后端 `PUT /api/admin/plans` 做同样校验，报错 `Plus · 智利区 请先填默认成本再启用`。
  - 沿用现有「上游进价高于默认成本」告警（`api/admin/plans/route.ts:160-168`），文案带地区。
  - 新增一条**只提示**的告警：变体成本低于同组菲区成本时提示「美区成本比菲区还低，确认没填错？」。不拦截，因为管理员可能确实有更便宜的渠道。

#### 7.11.4 手机

管理后台手机端保持横向滚动表格，不做卡片化改造（管理员主要在桌面操作）。

### 7.12 管理员：代理管理里的「默认价格」与单个代理的套餐（`components/admin-agents.tsx`）

`admin-agents.tsx` 有两张套餐表：代理默认价格（`:540-612`）和单个代理的可售套餐编辑（`:748-800`）。两张都改成与 §7.11.3 相同的分组结构，但只保留各自原有的列：

```text
单个代理：张三的可售套餐
┌───────────────────────────────────────────────────────────────┐
│ 套餐 / 地区          卡台        代理成本      零售价上限   开放  │
│ Plus                                                  [整组勾选]│
│   [PH] 菲区          可售        [118.00]      [200.00]    [✓]   │
│   [US] 美区          可售        [150.00]      [260.00]    [✓]   │
│   [CL] 智利区        可售        平台未启用                [ ]禁用│  ← 平台层没启用的变体不能单独开给代理
│ Pro 20x                                                         │
│   [PH] 菲区          可售        [1180.00]     [      ]    [✓]   │
└───────────────────────────────────────────────────────────────┘
```

- 代理列表的「可售套餐」列（`:626`）把同组合并显示：「Plus（菲区/美区）、Pro 20x（菲区）」。
- 平台层 `platform_plans.enabled=false` 的变体在这里显示「平台未启用」，开放勾选禁用。

### 7.13 管理员：订单、卡密、统计

| 页面 | 改动 |
|---|---|
| 订单列表 / 订单详情 | 商品名后加 `sm` 徽标；订单详情「发卡请求」里显示 `upstreamPlan`、`paymentCountry`（排障用） |
| 发卡失败订单 | `lastErrorCode = CARDPLATFORM_REGION_UNAVAILABLE / UNSUPPORTED` 显示中文「卡台拒绝了美区发码」「卡台账户不支持付款地区」 |
| 卡密查询 Tab | 结果加「付款地区」行；列表加地区列与地区筛选 |
| 概览 / 销量统计 | 按套餐统计时默认**按基础套餐合计**，可展开看各地区（「Plus 42 张：菲区 30 / 美区 10 / 智利区 2」） |
| 收益与结算 | 不改（按订单金额算，与地区无关） |

### 7.14 通知（Telegram / 其它渠道）

所有带套餐名的通知统一用「套餐 · 地区」（§7.0.4），菲区也写：

```text
[Kaimi] 新订单已发卡
店铺：阿明的小店
套餐：Plus · 美区 × 2
金额：¥336.00
```

新增一条运维告警（§9.3 第 4 条）：

```text
[Kaimi] 地区发码被卡台拒绝
套餐：Plus · 智利区
订单：KM20260930xxxx
卡台返回：<错误信息>
已自动触发套餐同步，智利区将在同步后停售。
```

### 7.15 状态总表（给实现和测试对照）

| 状态 | 管理员套餐表 | 代理售价页 | 店铺 | 已付款订单 |
|---|---|---|---|---|
| 同步刚生成，未填成本 | 「待定价」，启用框禁用 | 看不到 | 不显示 | — |
| 填了成本，未启用 | 普通行，未勾 | 看不到 | 不显示 | — |
| 已启用，未开放给代理 | 已勾 | 「未开放」灰行 | 不显示 | — |
| 已开放给代理 | 已勾 | 「可售」，可改零售价 | 作为规格显示 | 按快照发卡 |
| 卡台停售该地区 | 「卡台已停售」 | 「平台暂时缺货」 | 规格消失 | 在途订单仍按快照发卡，失败走 §9.3 |
| 默认账户换成 Avanfinity | 面板红字提示，全部变体停售 | 「平台暂时缺货」 | 只剩菲区 | 绑定旧账户的订单按旧账户发 |
| 管理员取消启用 | 未勾 | 看不到 | 规格消失 | 已付款订单照发 |

---

## 8. 兑换：地区是否影响 `/recharge`

**不影响兑换流程，码本身绑定地区。**

- 卡台把 `payment_country` 存在 CDK 上，兑换预检那一步按它定死付款地区（`danew_card_cdk/.../client.go:376-377` 注释）。
- 本站兑换走卡台公开 `/api/v1/cdk/preview → preflight → redeem`（`client.ts:463-491`），请求体里没有、也**不应该加**地区字段。本站在兑换时再传一次地区，要么被忽略，要么和码上的地区冲突。
- 兑换路由按 `issued_cdks.cardplatform_account_id` 选账户（`redeem.ts:60-74`），地区卡密一定是旧台账户发的，自然打回旧台。
- 本站唯一的改动是**展示**（§7.5）。

---

## 9. 库存、售罄与异常

### 9.1 库存展示

卡台对 CDK 发码不下发库存数（`plans` 里没有 stock，发码是即时生成）。本站今天对卡台套餐一律 `stock: null` + 「有货」（`agent-storefront-config.ts:486`、`:498`），地区变体沿用。**「能不能卖」只由 `cardplatform_sellable` 决定**，而它来自「该地区在不在最近一次 `payment_regions` 里 且 套餐 `enabled`」。

### 9.2 代理开了一个卡台没货的地区

代理本来就不能自己开套餐（§7.6）。卡台停售的变体在代理售价页显示「平台暂时缺货」；店铺查询条件要求 `cardplatform_sellable=true`（`app/s/[slug]/page.tsx:49-52`），下单再校验一次（`store-orders.ts:92-98`）。已经开放的变体在卡台停售后，下一次同步（≤3 分钟）自动从店铺消失，管理员给代理的开放状态保留，卡台恢复后自动重新上架。

### 9.3 已付款但卡台拒绝该地区（竞态）

同步间隔内卡台下架地区、或卡台余额不足以覆盖该地区的资金上限时，发码会被拒。今天的逻辑是：非超时错误 → `paid_undelivered` → 按退避重试 → 重试用尽 → `unknown`（`fulfill-store-order.ts:303-343`、`:599-616`）。

新增：

1. 识别地区类错误：`errorCode` 含 `REGION` / `COUNTRY`，或消息含「地区」「country」「currency」→ `lastErrorCode = "CARDPLATFORM_REGION_UNAVAILABLE"`。**上游确切错误码待确认**（§13 Q5），先按关键词匹配，拿到真实错误码后收紧。
2. 地区类错误**仍走重试**（卡台可能只是短暂下架），但同时触发一次 `syncDefaultCardplatformPlans()`，让店铺尽快停售，避免更多买家下单。
3. 用尽重试后照现有逻辑进 `unknown`，管理员在订单列表看到错误码，线下联系买家：退款，或经买家同意后人工补发默认区（一期无按钮，§13 Q6）。
4. 触发一条运维通知（复用 `lib/notify.ts` 的 `dispatchNotifyText`），文案「美区卡密发码被卡台拒绝，已自动停售该地区」。

---

## 10. 向后兼容

| 对象 | 保证 |
|---|---|
| 已有 `platform_plans` 行 | 新列默认空串。`upstream_plan_key=''` → 用 `plan_key`；`payment_country=''` → 不传地区；`base_plan_key=''` → 按 `plan_key` 分组。首次同步时回填 `base_plan_key / upstream_plan_key`，幂等 |
| 已有订单 | 两个快照列为空 → 发卡与今天完全一致。在途的 `paid_undelivered` 订单续发时同样 |
| 已发卡密 | `payment_country=''` = 菲区，显示「PH 菲区」徽标（§7.0.3）；兑换流程不变 |
| 卡台未升级（无 `payment_regions`） | `regions=[]`，不生成变体，行为不变 |
| 默认账户是 Avanfinity | 同上 |
| 开放 API | 默认区行 `plan_key` 不变；变体是新增 key，老客户端不认识就不会用 |
| 店铺 | 同组只有一个规格时结构与今天一致；**唯一可见变化**是卡台套餐的规格名从「预设规格」变成「菲区」，并多一个 PH 徽标（有意为之，§7.0.3） |

---

## 11. 与选卡配置的关系（`app/admin/card-selection`）

- 选卡配置（`account_card_selection_rules`、`site_redeem_policy_*`）决定**用哪张虚拟卡去付**；付款地区决定**在哪个国家的 ChatGPT 结账页、用什么币种付**。两者独立，一期不联动。
- `policy-logic.ts:49` 的 `issuingArea: "United States"` 是开卡时的持卡地区，**不是**付款地区，不要拿它推断或覆盖 `payment_country`。
- 卡台是否会因为付款地区自动挑选合适的卡段（例如美区只用某些 BIN），由卡台负责；本站不做「地区 → 卡头」映射（§13 Q7）。
- 选卡配置页不需要改动。

---

## 12. 与进行中的「代理自助提卡」的关系

提卡侧的完整地区设计已经写进 `docs/agent-self-draw-design.md` **§16「付款地区」**，本节只列两边共用的东西：

| 共用件 | 位置 | 说明 |
|---|---|---|
| 地区命名 | `lib/cardplatform/regions.ts` 的 `regionDisplay()`、`planWithRegion()` | 提卡台、提卡账本、账单、对账文本、TG 通知都调它 |
| 地区徽标 | `components/region-badge.tsx` | 提卡台、账本表格复用 |
| 发卡目标翻译 | `lib/cardplatform/issue-target.ts` 的 `issueTargetFromSnapshot()`、`accountSupportsPaymentCountry()` | 商城发卡与提卡出卡共用，保证两边传给卡台的 plan / 地区规则一致 |
| 地区错误识别 | `lib/cardplatform/issue-target.ts` 的 `isRegionIssueError()` | 两边都用它映射 `CARDPLATFORM_REGION_UNAVAILABLE` |
| `issued_cdks.payment_country` | §5.3 | 提卡写入时同样填 |

**建议的合并顺序**：先合地区 P0 + P1（数据列、发卡传地区、`issue-target.ts`），再合提卡。这样提卡从第一天起就是地区感知的，不用返工。如果提卡先合，就按提卡文档 §16.8 的「后接入清单」补。

---

## 13. 产品问题

### 13.1 已确认

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 默认区对买家怎么叫？ | **菲区**。所有卡台套餐、卡密都显示地区，菲区也显示（§7.0.3）。管理员仍可用 `region_label` 改名 |
| Q2 | 美区、智利区的平台成本和上游进价谁定？ | **管理员自己填**。变体创建时成本 0、进价空、不上架；成本不填不能启用（§7.11.3）。平台承担卡台按地区实付的差价（与今天一致） |
| Q3 | 点数档、续费档要不要地区版？ | 点数档不做；**续费档也不做**，平台后续会把续费套餐全部下架。同步时两种都跳过（§6.1） |

### 13.2 仍待确认（每条都给了默认方案，不阻塞实现）

| # | 问题 | 默认方案 |
|---|---|---|
| Q4 | 除了 US、CL，卡台以后下发的 JP / KR 等要不要自动出现在管理后台？ | 只在「地区」面板里显示为可勾选，白名单默认 `US,CL`，勾上才生成变体 |
| Q5 | 卡台拒绝不支持地区时的确切 `error_code` 是什么？ | 先按关键词识别（§9.3），拿到真实值后改为精确匹配 |
| Q6 | 地区发码失败、买家已付款时，要不要做「改发菲区」的后台按钮？ | 一期不做，人工联系买家后退款或线下补发 |
| Q7 | 美区 / 智利区是否需要特定卡头？选卡配置要不要按地区区分？ | 不区分，交给卡台。若实测美区失败率高，再单独立项「地区 → 选卡规则」 |
| Q8 | 同一个代理的商品名覆盖，要不要允许按地区单独改名？ | 不允许，商品名按基础套餐；地区只体现在规格名上 |
| Q9 | 开放 API 客户是否需要按地区下单？ | 开放 API 目前没有下单接口（只有 `orders` 列表），`/api/v1/open/plans` 补 `base_plan_key / payment_country` 两个字段即可 |

---

## 14. API 变更清单

| 接口 | 变更 |
|---|---|
| `POST /api/admin/cardplatform/sync-plans` | 响应加 `regions: string[]`、`variantsCreated: number` |
| `GET /api/admin/plans` | 列表项自带新列（Drizzle 直接返回），前端分组 |
| `POST /api/admin/plans` | schema **不接收** `upstreamPlanKey / paymentCountry / basePlanKey`（防止手工改地区语义）；接收 `regionLabel`、`regionNote` |
| `PUT /api/admin/plans` | 批量项接收 `regionLabel`、`regionNote`（≤40 字）；变体 `enabled=true` 时校验 `globalCostPriceCents > 0`；组行改分类时后端把同 `base_plan_key` 的行一起改 |
| `GET /api/cdk/lookup` | 本站码加 `paymentCountry`、`regionLabel` |
| 店铺 URL | 新增 `?region=us|cl|ph` 与 `?plan=plus:us`，纯前端参数 |
| `GET /api/admin/cardplatform/regions`（新增） | 返回缓存的地区清单、`syncedAt`、白名单 |
| `PUT /api/admin/cardplatform/regions`（新增） | 保存白名单 `{ whitelist: ["US","CL"] }`，保存后立即触发一次同步 |
| `GET /api/agent/plans` | 列表项加 `basePlanKey / paymentCountry / regionLabel` |
| `PUT /api/agent/plans/[planKey]` | 无变化（`planKey` 可含冒号，调用方已 `encodeURIComponent`） |
| `POST /api/public/store-orders` | 仍按 `planKey` 下单；新增 `regionConfirmed: boolean`。商品组有 ≥2 个在售地区时必须为 `true`，否则 400「请确认付款地区」（§7.2.2） |
| `POST /api/public/store-orders/quote` | 无变化 |
| 订单查询 / 邮箱查单响应 | 每张卡密加 `paymentCountry`、`regionLabel` |
| 兑换预检摘要 | 加 `regionLabel` |
| `GET /api/v1/open/plans` | 每项加 `base_plan_key`、`payment_country`（空串 = 默认区）；`openapi.json` 与 `lib/open-api/agent-docs.ts` 同步 |
| `GET /api/v1/open/cdks` | 每项加 `payment_country` |

---

## 15. 文件改动清单

| 文件 | 改动 |
|---|---|
| `apps/web/src/db/schema.ts` | `platformPlans` +6 列（含 `region_capable`、`region_note`）、`storeOrders` +2 列、`issuedCdks` +1 列、`platform_plans_base_idx` |
| `apps/web/src/db/migrate-lib.ts` | 对应 `addColumn` 与索引 |
| `apps/web/src/lib/cardplatform/client.ts` | `IssueCardPref.paymentCountry`；`issueMany` 发 `payment_country`；新增 `getPlansWithRegions()`（或让 `getPlans` 返回 `{ plans, regions }` 并改调用方） |
| `apps/web/src/lib/cardplatform/protocol.ts` | `supportsPaymentCountry()` |
| `apps/web/src/lib/cardplatform/regions.ts`（新） | 地区缓存读写、白名单；纯函数 `regionDisplay()`、`planWithRegion()`、`sortRegionSpecs()`（可在客户端组件引用，不能 import db） |
| `apps/web/src/lib/cardplatform/issue-target.ts`（新） | `issueTargetFromSnapshot({ planKeySnapshot, upstreamPlanKeySnapshot, paymentCountrySnapshot })` → `{ plan, paymentCountry }`；`accountSupportsPaymentCountry()`；`isRegionIssueError()` |
| `apps/web/src/components/region-badge.tsx`（新） | `<RegionBadge country regionLabel size compact />`（§7.0.2） |
| `apps/web/src/components/admin-agents.tsx` | 两张套餐表分组、代理列表可售套餐合并显示（§7.12） |
| `apps/web/src/components/agent-storefront-settings.tsx` | 商品名覆盖按基础套餐，文案「作用于所有地区」（§7.9） |
| `apps/web/src/components/cdk-lookup-form.tsx`、`app/api/cdk/lookup/route.ts` | 付款地区行（§7.10） |
| `apps/web/src/lib/notify-commerce.ts` | 套餐名统一「套餐 · 地区」；地区发码失败告警（§7.14） |
| `apps/web/src/lib/cardplatform/plans.ts` | §6.1 变体生成 / 停售 / 回填 |
| `apps/web/src/lib/store-orders.ts` | 选出新列、协议硬校验、写快照、商品名带地区、`regionConfirmed` 校验（组内在售地区数 ≥2 时必填） |
| `apps/web/src/lib/fulfillment/fulfill-store-order.ts` | 用快照发卡、写 `issued_cdks.payment_country`、地区错误识别与触发同步 |
| `apps/web/src/lib/agent-storefront-config.ts` | `plansToProducts()` 分组；封面按 base 回退；多地区标签与说明 |
| `apps/web/src/app/s/[slug]/page.tsx` | 查询加新列，改用 `plansToProducts` |
| `apps/web/src/components/agent-storefront.tsx` | 规格行显示地区名（数据已由上一步提供）；详情里的地区提示段落；订单卡密旁的地区标签 |
| `apps/web/src/lib/agent-console.ts` | `listAgentConsolePlans` 返回新字段 |
| `apps/web/src/components/agent-sell.tsx` | 按基础套餐分组、组标题行、新开放提示条（§7.6） |
| `apps/web/src/components/agent-coupon-composer.tsx` | 分组选择器 +「全部地区」快捷勾选、券卡 chip 合并、新地区未包含提醒（§7.7） |
| `apps/web/src/components/agent-codes.tsx` | 地区列、地区筛选、CSV 两列（§7.8） |
| `apps/web/src/components/plan-default-prices.tsx` | 地区面板、待定价提醒条、分组表格、`region_label / region_note` 编辑、分类只在组行、上架校验（§7.11） |
| `apps/web/src/app/api/admin/plans/route.ts` | schema 调整、上架校验 |
| `apps/web/src/app/api/admin/cardplatform/sync-plans/route.ts` | 响应字段 |
| `apps/web/src/app/api/admin/cardplatform/regions/route.ts`（新） | GET / PUT |
| `apps/web/src/lib/cardplatform/redeem.ts` | `summarizePreview` 加地区 |
| 订单查询相关 lib（`lib/store-orders.ts` 的查询函数） | 卡密带 `paymentCountry` |
| `apps/web/src/app/api/v1/open/plans/route.ts`、`open/cdks/route.ts`、`lib/open-api/agent-docs.ts`、`open/openapi.json/route.ts` | 新字段与文档 |

不改：`redeem.ts` 的兑换请求、`policy.ts` / 选卡配置、收益与结算、`coupons.ts` 的校验逻辑、`issued-status*`、webhook。

---

## 16. 测试

沿用 `apps/web/src/lib/core.test.ts` 里 mock `fetch` 的写法（`:362-498` 已有 `issueMany` 的用例）。

**卡台客户端**

1. `issueMany("plus", 1, key, { paymentCountry: "us" })` → 请求体含 `payment_country: "US"`，不含 `payment_currency`。
2. 无选卡偏好、只有地区 → 仍带 `payment_country`（回归 `danew_card_cdk` 修过的那个 bug）。
3. `paymentCountry` 为空或只有空白 → 请求体**没有** `payment_country` 键。
4. `getPlansWithRegions` 解析 `payment_regions`；字段缺失 / 格式错 → `regions = []`。

**同步**

5. 卡台返回 `plus` + regions `[US, CL, JP]`、白名单 `US,CL` → 生成 `plus:us`、`plus:cl`，都是 `enabled=false`、成本 0、进价 NULL；不生成 `plus:jp`。
6. 再同步一次 regions `[US]` → `plus:cl` 的 `cardplatform_sellable=false`，行仍在；`plus:us` 仍 sellable。
7. 点数档 `credit500` 不生成变体。
8. 账户协议为 Avanfinity → regions 视为空，所有变体 sellable=false。
9. 老数据 `base_plan_key=''` 的行在同步后被回填；重复同步不产生重复行。
10. 变体行被管理员改过的 `name / region_label / 价格` 不被同步覆盖。

**下单与发卡**

11. 变体下单 → `store_orders.upstream_plan_key_snapshot='plus'`、`payment_country_snapshot='US'`、`plan_key_snapshot='plus:us'`。
12. 发卡请求 `plan='plus'`、`payment_country='US'`；`issued_cdks.plan_key='plus:us'`、`payment_country='US'`。
13. 老订单（两个快照为空）发卡请求与改动前完全一致（快照对比请求体）。
14. 订单绑定账户为 Avanfinity 且有地区 → 抛 `CARDPLATFORM_REGION_UNSUPPORTED`，不调用卡台。
15. 卡台返回地区类错误 → `lastErrorCode = CARDPLATFORM_REGION_UNAVAILABLE`，触发同步。
16. 变体成本为 0 时下单被拒。

**店铺**

17. `plansToProducts`：同组三行 → 一个商品三个规格，菲区在前，规格 id 为各自 `planKey`，最低价正确。
18. 同组只有一行 → 除规格名为「菲区」、带 `region` 字段外，其余与改动前 `planToProduct` 的输出一致（快照测试）；本地成品号完全一致。
18a. `regionDisplay`：`''` → 菲区 / Philippines / PH；`US` → 美区；`CL` → 智利区；`JP` → JP区；`region_label` 覆盖中文名、不影响英文名。
18b. 店铺默认选中规格的优先级（§7.2.1）：`?plan` > `?region` > localStorage > 菲区 > 第一个；指向已停售规格时降级。
18c. 续费档（`requires_active_subscription`）不生成变体。
18d. 地区确认：组内有 ≥2 个在售地区时，下单不带 `regionConfirmed` → 400，带 `true` → 成功；组内只有一个地区、点数档、成品号不要求。前端：未勾选时「去付款」置灰；返回修改换地区后勾选重置。
19. `plus:us` 没有专属封面 → 用 `plus` 的封面。
20. 代理对 `plus` 的商品名覆盖作用于合并后的商品。

**迁移**

21. 在已有数据库上连跑两次迁移不报错，老行新列为默认值。

---

## 17. 分期上线

| 阶段 | 内容 | 上线后可见变化 |
|---|---|---|
| P0 只读 | 客户端解析 `payment_regions`、同步写缓存、管理后台显示「卡台地区：US CL …」 | 无业务变化，用来确认线上卡台确实下发了地区、币种是什么 |
| P1 平台能卖 | 迁移、变体生成 / 停售、下单快照、发卡传地区、协议校验、错误识别、管理后台分组表格与白名单 | 管理员可以给变体定价并上架；代理暂时在旧的平铺列表里看到「Plus（美区）」式的独立行也能开卖 |
| P2 体验 | 店铺按规格合并、代理后台分组、订单页 / 查单 / 兑换页 / 已售卡密显示地区、券显示名 | 买家看到一个商品多个地区 |
| P3 周边 | 开放 API 字段与文档、运维通知、（若已合并）提卡接入 | — |

上线步骤建议：

1. 部署 P0，观察一个同步周期，确认 `settings.cardplatform_payment_regions_{id}` 里有 US / CL。
2. 部署 P1，**先用管理员自己的测试店铺**上架 `plus:us`，买一张、兑换一次，核对卡台后台这张码的付款地区与实扣币种，并据此填 `upstream_cost_cents`。
3. 核对无误后给代理授权变体。
4. 部署 P2。

回滚：P1 之后如需回滚，把所有变体 `enabled=false` 即可停售；已售地区卡密的兑换不依赖本站代码（地区在卡台上），回滚代码也不影响买家兑换。新增列保留无害。
