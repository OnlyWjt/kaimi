# 代理收益与平台毛利 详细设计

> 状态：已在分支 feat/agent-earnings-ledger 开始实现
> 日期：2026-09-28
> 范围：商城订单（`store_orders`）的代理收益、平台毛利、手续费、结算、通知、统计

---

## 1. 背景

### 1.1 触发问题

兑换通知 `RC202609271525BJFDPA8A79` 显示：售价 ¥145、本次收益 ¥125、代理收益 ¥0.12，看起来算错了。

排查结论：

- 公式本身没错：`代理收益 = 券后商品额 − 成本×数量 − 代理承担手续费`。
- 通知三个数字口径不一致：
  - 「售价」是券前挂牌价 `retail_price_cents`；
  - 「本次收益」其实是代理成本 `agent_cost_cents`（平台收入，不是利润）；
  - 「代理收益」是券后结果。
- 按 0.7% 费率反推，买家实付商品额约 ¥126，大概率用了 ¥19 左右的券。需要用第 7 节的核对接口在线上确认。

### 1.2 现有问题清单

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| P1 | 通知口径混乱 | `lib/notify-commerce.ts` | 看错账 |
| P2 | 「平台收益」= 代理成本合计，不是利润 | `lib/earnings-stats-core.ts:156`、`admin-earnings-stats.tsx` | 看不到平台真实赚多少 |
| P3 | 系统不记录上游进价 | 全局 | 算不出平台毛利 |
| P4 | `agent_earnings.payment_fee_cents` 存的是实付总额的手续费，而收益扣的是商品额部分的手续费。开票单上「毛收 − 成本 − 手续费 ≠ 收益」 | `fulfill-store-order.ts`、`reconcile.ts` | 对账对不上 |
| P5 | 收益有 5 个写入点，各自拼逻辑 | 见 4.3 | 以后改一处漏一处 |
| P6 | 网关回的真实手续费直接覆盖收益，没有合理性校验 | `lib/payments/reconcile.ts` | 字段异常时收益被改错 |
| P7 | 结算单直接加总 `earning_cents`，不做逐单验算 | `api/admin/settlements/route.ts` | 错账会原样进结算 |
| P8 | 代理订单接口不返回券和成本 | `api/agent/orders/route.ts` | 代理对不上账 |
| P9 | 兑换单支付标签叫「免支付」 | `app/admin/page.tsx:84` | 误以为白嫖 |

---

## 2. 已确认的业务决策

| 决策 | 结论 |
|---|---|
| 优惠券底线 | 只保证平台拿到完整的代理成本，代理利润不管。实现上沿用现有规则 `券后商品额 − 成本 − 代理手续费 ≥ 0`（见 2.1） |
| 手续费异常阈值 | `实际 > 估算 × 2` **且** `实际 − 估算 > 100 分`，判为异常，转人工 |
| 上游进价 | 要记录，后台首页一眼能看到平台毛利 |

### 2.1 为什么优惠券底线要含手续费

如果只要求 `券后商品额 ≥ 成本`，手续费会让代理收益变成负数，比如 −¥0.88。负收益进结算单后会抵扣这个代理其他订单的收益，本质上是平台替代理垫手续费，而且账面更乱。

所以底线定为代理收益 ≥ 0，也就是现在 `couponBelowCost` 的规则，保持不变。这样平台永远拿满成本，代理最差收益为 0。

---

## 3. 口径定义（全系统唯一）

以一单为单位，金额单位都是分，除非特别注明，都是**下单时快照**。

| 字段 | 含义 | 公式 / 来源 |
|---|---|---|
| `list_goods_cents` | 券前商品额 | 挂牌单价 × 数量（已有） |
| `coupon_discount_cents` | 券优惠 | 已有 |
| `goods_cents` | 券后商品额 | `list_goods − coupon_discount`（派生：`gross − invoice_surcharge`） |
| `invoice_surcharge_cents` | 开票加价，归平台 | 已有 |
| `gross_cents` | 买家实付 | `goods + invoice_surcharge`（已有） |
| `agent_cost_total_cents` | 代理成本合计 = 平台收入 | 成本单价 × 数量（已有） |
| `final_payment_fee_cents` | 渠道手续费总额 | 按 `gross` 算，或网关实收（已有） |
| **`agent_fee_cents`** | 代理承担的手续费 | 新增，见 4.2 |
| **`platform_fee_cents`** | 平台承担的手续费 | 新增，`final_payment_fee − agent_fee` |
| `agent_earning_cents` | 代理收益 | `goods − agent_cost_total − agent_fee`（已有，改为统一计算） |
| **`upstream_cost_unit_cents`** | 上游进价单价 | 新增，见第 5 节 |
| **`upstream_cost_total_cents`** | 上游进价合计 | 新增，单价 × 数量 |
| **`platform_profit_cents`** | 平台毛利 | 新增：`agent_cost_total + invoice_surcharge − upstream_cost_total − platform_fee` |

### 3.1 恒等式（任何时刻必须成立）

- **I1**：`goods = gross − invoice_surcharge`
- **I2**：`final_payment_fee = agent_fee + platform_fee`
- **I3**：`agent_earning = goods − agent_cost_total − agent_fee`
- **I4**：`platform_profit = agent_cost_total + invoice_surcharge − upstream_cost_total − platform_fee`（仅在上游进价已知时）
- **I5**：`gross = agent_earning + platform_profit + upstream_cost_total + final_payment_fee`，即买家付的每一分钱都有去处
- **I6**：`agent_earnings` 行上的 `gross/cost/agent_fee/earning` 与订单表一致，前提是该收益行未结算

### 3.2 什么能变，什么不能变

| 事件 | 允许变动 | 约束 |
|---|---|---|
| 调代理成本价、挂牌价、上游进价 | 不影响已下单 | 只影响新订单 |
| 网关回真实手续费 | 重算手续费、代理收益、平台毛利 | 收益行未进结算单；未触发异常阈值 |
| 手动「按当前费率重算」 | 同上 | 同上 |
| 人工确认异常手续费 | 同上 | 管理员操作，写审计日志 |
| 已返佣后发现错账 | 不改原行，另加一条调整项 | 走 `agent_earning_adjustments`，`type = fee_correction` |

---

## 4. 计算模块

### 4.1 新文件 `apps/web/src/lib/order-ledger-core.ts`

这是纯函数，不读数据库，所有写入点只能通过它算钱。

```ts
export type LedgerSnapshot = {
  quantity: number;
  grossCents: number;
  invoiceSurchargeCents: number;
  agentCostTotalCents: number;
  upstreamCostTotalCents: number | null; // null = 未配置
  feeRule: FeeRule;                      // 下单时的费率快照
};

export type LedgerResult = {
  goodsCents: number;
  finalPaymentFeeCents: number;
  agentFeeCents: number;
  platformFeeCents: number;
  agentEarningCents: number;
  platformProfitCents: number | null;
};

export function computeOrderLedger(
  s: LedgerSnapshot,
  opts?: { gatewayFeeCents?: number | null },
): LedgerResult;

/** 实际 > 估算×2 且 多出 > 100 分 */
export function isGatewayFeeAnomalous(estimatedCents: number, actualCents: number): boolean;

/** 结算前验算：订单 + 收益行 → 不一致项列表（空数组表示通过） */
export function verifyLedger(order: StoredOrderLedger, earning?: StoredEarningLedger): LedgerMismatch[];
```

### 4.2 手续费分摊规则（和现状一致，只是显式化）

```
feeOnGross = calculatePaymentFeeCents(gross, feeRule)
feeOnGoods = calculatePaymentFeeCents(goods, feeRule)

finalPaymentFee = gatewayFee ?? feeOnGross

if invoiceSurcharge > 0:
    agentFee = feeOnGoods                 # 代理只承担售价部分
else:
    agentFee = finalPaymentFee            # 无开票时代理承担全部（含网关实收）

platformFee = finalPaymentFee − agentFee  # 开票单上多出来的通道费归平台
```

边界：

- 开票单在网关实收小于 `feeOnGoods` 时，`platformFee` 会是负数，意思是平台少付了手续费。允许出现负数，I2 仍然成立。
- `agentEarning < 0`：拒绝写入。沿用现有做法，下单时报错，对账时转人工。

### 4.3 写入点改造

| 写入点 | 现状 | 改造后 |
|---|---|---|
| 下单 `lib/store-orders.ts` `createStoreOrder` | `quoteStorePayment` | `computeOrderLedger`，并写入新增列（`agent_fee`、`platform_fee`、上游进价快照、`platform_profit`） |
| 对账 `lib/payments/reconcile.ts` | `agentEarningCents` | `computeOrderLedger(…, { gatewayFeeCents })`；先做异常判定（见 6.1） |
| 重算 `lib/payments/recalculate.ts` | `agentEarningCents` | `computeOrderLedger` |
| 发卡 `lib/fulfillment/fulfill-store-order.ts` ×2 | 复制订单字段 | 复制订单字段，`payment_fee_cents` 改为复制 `agent_fee_cents`，另存 `total_fee_cents` |
| 人工处理 `api/admin/store-orders/[orderNo]/resolve` | 复制订单字段 | 同发卡 |

`quoteStorePayment` 保留给报价和券预览用，内部改为调用 `computeOrderLedger`，保证报价和落库完全一致。`agentEarningCents` 删掉。

---

## 5. 上游进价

### 5.1 来源

| 履约方式 | 进价来源 | 说明 |
|---|---|---|
| 卡台发卡 `cardplatform` | 套餐配置 `platform_plans.upstream_cost_cents` | 唯一来源，你在后台填。卡台回传的 `issued_cdks.upstream_fee_minor` 不参与计算、不展示 |
| 本地成品号 `local_account` | `finished_accounts.cost_cents`（导入时填），没填就用套餐配置 | 每批号进价可能不同 |

### 5.2 快照时机

- **下单时**：按套餐当前的 `upstream_cost_cents` 写入订单的 `upstream_cost_unit_cents` 和 `upstream_cost_total_cents`，`upstream_cost_source = 'plan'`。
- **本地成品号发货时**：如果分配到的账号带 `cost_cents`，用实际账号进价的合计覆盖订单上的上游进价，`source = 'finished_account'`。这一步在发货事务里做，同时重算 `platform_profit`。
- 套餐没配置进价时，`upstream_cost_* = NULL`，`source = 'unset'`，`platform_profit = NULL`。统计页单独提示「N 单未配置进价，毛利未计入」。

### 5.3 调进价

在后台「套餐与价格」页加一列「上游进价」，和全局成本价放在一起批量保存。改动只影响之后的新订单。保存时校验：

- `上游进价 ≤ 全局成本价`：只提示不阻止，因为可能故意亏本卖；
- 代理单独成本价低于上游进价的代理：保存后列出来，提醒这些代理每单平台亏钱。

---

## 6. 防护

### 6.1 网关手续费异常

在 `reconcile.ts` 拿到 `actualFee` 之后：

```
if actualFee !== null && isGatewayFeeAnomalous(order.estimatedPaymentFeeCents, actualFee):
    fee_reconcile_status = 'manual_review'
    actual_payment_fee_cents = actualFee        # 记录下来供人工参考
    final_payment_fee_cents / agent_fee / earning 保持估算值不动
    payment_fee_reconciliations.status = 'manual_review', error_message = '网关手续费异常偏高'
    发运维告警通知
    return
```

**人工处理**：新增接口 `POST /api/admin/store-orders/[orderNo]/fee-review`，参数为 `{ decision: 'accept_gateway' | 'keep_estimate', note }`：

- `accept_gateway`：按网关值调用 `computeOrderLedger`；收益为负就拒绝。
- `keep_estimate`：`final = estimated`，`fee_reconcile_status = 'unsupported'`，意思是按估算定稿。
- 两种都要写审计日志，并同步更新还没结算的收益行。

后台订单列表对 `manual_review` 的订单标黄，旁边放「处理手续费」按钮。

### 6.2 生成结算单前逐单验算

`POST /api/admin/settlements` 在事务里取到收益行后：

1. **跳过**订单 `fee_reconcile_status = 'manual_review'` 的收益行，不纳入本次结算。响应里返回 `skippedManualReview: [orderNo…]`，前端提示「N 单手续费待核对，已跳过」。
2. 对剩下每一行调用 `verifyLedger(order, earning)`。只要有一条不一致，**整张结算单拒绝生成**，返回 409 和不一致清单（订单号、哪条恒等式不成立、期望值和实际值）。
3. 结算单新增 `item_count` 字段，以及明细接口 `GET /api/admin/settlements/[id]/items`，返回每单的完整拆解：券前价、券、券后、成本、代理手续费、代理收益。明细可以导出 Excel 发给代理对账。

### 6.3 收益为负的统一拦截

`computeOrderLedger` 返回的 `agentEarningCents < 0` 时，所有写入点一律不写入：

- 下单：直接报错；
- 对账、重算：转人工。

现在下单和重算已经这样做了，对账也做了。改造后在同一个函数里保证，不再靠各处自觉。

---

## 7. 历史数据核对（上线第一步，只读）

### 7.1 接口 `GET /api/admin/earnings/audit`

只有管理员能调用，只读。它扫描所有 `pay_status = 'paid'` 的订单，按快照重算，输出：

```json
{
  "scanned": 312,
  "ok": 305,
  "issues": [
    {
      "orderNo": "KS2026...",
      "agent": "Polus",
      "kind": "formula_mismatch | order_earning_row_mismatch | fee_anomalous | low_earning",
      "expected": { "agentEarningCents": 1898, "agentFeeCents": 102 },
      "stored":   { "agentEarningCents": 12,   "paymentFeeCents": 1988 },
      "earningStatus": "settling",
      "settlementNo": "ST202609280205YSSK2BMALL"
    }
  ]
}
```

`low_earning` 只作提示，指收益低于 ¥1 的订单，用来确认是不是券造成的，不算错。

后台「代理返佣结算」卡片加一个「收益核对」按钮，调用这个接口并用表格展示结果。

### 7.2 错账修正规则

| 收益行状态 | 处理方式 |
|---|---|
| `pending`，没进结算单 | 在核对结果里点「按快照修正」，直接改订单和收益行 |
| `settling`，在待返佣结算单里 | 先撤销该结算单（现有能力），再修正，再重新生成 |
| `settled`，已返佣 | 不改原行，插入一条 `agent_earning_adjustments`，`type = 'fee_correction'`，金额 = 期望值 − 已付值，下期结算自动带上 |

---

## 8. 数据库变更

按现有 `migrate-lib.ts` 的 `addColumn` 方式增量加列，SQLite 不删列。

### 8.1 `platform_plans`

```sql
ALTER TABLE platform_plans ADD COLUMN upstream_cost_cents INTEGER;  -- NULL = 未配置
```

### 8.2 `finished_accounts`

```sql
ALTER TABLE finished_accounts ADD COLUMN cost_cents INTEGER;        -- NULL = 用套餐配置
```

### 8.3 `store_orders`

```sql
ALTER TABLE store_orders ADD COLUMN agent_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE store_orders ADD COLUMN platform_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE store_orders ADD COLUMN upstream_cost_unit_cents INTEGER;
ALTER TABLE store_orders ADD COLUMN upstream_cost_total_cents INTEGER;
ALTER TABLE store_orders ADD COLUMN upstream_cost_source TEXT NOT NULL DEFAULT 'unset';
                                   -- plan | finished_account | backfill | unset
ALTER TABLE store_orders ADD COLUMN platform_profit_cents INTEGER;
```

### 8.4 `agent_earnings`

```sql
ALTER TABLE agent_earnings ADD COLUMN agent_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_earnings ADD COLUMN total_fee_cents INTEGER NOT NULL DEFAULT 0;
```

`payment_fee_cents` 保留不删，语义从此固定为代理承担的手续费，新代码同时写 `agent_fee_cents` 和 `payment_fee_cents`，旧导出不受影响。

### 8.5 `agent_settlements`

```sql
ALTER TABLE agent_settlements ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
```

### 8.6 回填（迁移脚本里一次性执行，幂等）

1. 对所有 `store_orders` 按快照调用 `computeOrderLedger`，只写 `agent_fee_cents` 和 `platform_fee_cents`，**不改 `agent_earning_cents`**。
2. 对所有 `agent_earnings` 从订单复制 `agent_fee_cents`，并写 `total_fee_cents = order.final_payment_fee_cents`。
3. 上游进价不自动回填，历史订单保持 `unset`。后台提供「按当前进价补历史订单」按钮：选日期范围和套餐，写入时 `source = 'backfill'`，统计页标注「含回填估算」。
4. 回填后运行 7.1 的核对。不一致的订单**不自动改**，留给人工按 7.2 处理。

---

## 9. 展示改造

### 9.1 后台收益统计首页（一眼看到毛利）

顶部 4 张卡片改为：

| 卡片 | 主数字 | 副文案 |
|---|---|---|
| **平台毛利**（最大、放第一位） | `Σ platform_profit` | `毛利率 X%`（除以销售额）；有未配置进价的订单时加一行黄色提示「N 单未配置进价，未计入」 |
| 销售额 | `Σ gross` | `N 单 · 客单 ¥X` |
| 代理收益 | `Σ agent_earning` | `待结算 ¥X · 已返佣 ¥Y` |
| 成本与费用 | `Σ upstream_cost + Σ fee` | `上游 ¥X · 手续费 ¥Y` |

卡片下面加一条毛利拆解，一行文字即可：

```
平台毛利 ¥1,234.00 = 代理成本 ¥9,800.00 + 开票加价 ¥120.00 − 上游进价 ¥8,600.00 − 平台手续费 ¥86.00
```

趋势图增加「平台毛利」序列，原来的「平台收益」序列改名为「平台收入（代理成本）」。

分组表格（按代理、按套餐）各加两列：「上游进价」「平台毛利」。按套餐看，就能知道哪个套餐不赚钱。

`earnings-stats-core.ts` 的 `Money` 类型增加 `upstreamCents`、`platformFeeCents`、`profitCents`、`profitUnknownCount` 四个字段。原来的 `platformCents` 改名为 `revenueCents`。

### 9.2 后台订单列表

商城订单行展开后显示完整拆解（第 3 节的全部字段），异常手续费标黄。

兑换单的「免支付」标签改为：
- 能关联到商城单：显示「商城已付」，悬停时显示商城单号和支付状态；
- 关联不到：显示红色「无商城单」。

### 9.3 兑换成功通知

`NotifyPayload` 字段调整为：

```ts
{
  quantity: number;
  listGoodsCents: number;         // 挂牌总价
  couponCode?: string;
  couponDiscountCents?: number;
  goodsCents: number;             // 实付商品额
  agentCostTotalCents: number;    // 代理成本
  agentFeeCents: number;
  agentEarningCents: number;      // 整单
  upstreamCostTotalCents?: number | null;
  platformProfitCents?: number | null;
}
```

文案示例：

```
[Kaimi] 兑换成功  RC202609271525BJFDPA8A79
代理：Polus
开通账号：xxx@gmail.com
套餐：Plus（本单 1 张）
挂牌价：¥145.00
优惠券：MAN19  -¥19.00
实付商品额：¥126.00
代理成本：¥125.00
代理收益：¥0.12（已扣手续费 ¥0.88）
平台毛利：¥4.12（上游 ¥120.00）
```

- 一单多张时，每张兑换都发一次通知，显示整单金额，并注明「本单 N 张，这是第 k 张」。
- 通知只发到管理员的 Telegram 或 webhook，所以可以带上平台毛利。代理侧不会看到任何上游和毛利数据。

### 9.4 代理后台订单

`GET /api/agent/orders` 增加返回：`listGoodsCents`、`couponCode`、`couponDiscountCents`、`goodsCents`、`agentCostTotalCents`、`agentFeeCents`。

**不返回**上游进价和平台毛利。页面订单详情展示「挂牌价 − 券 = 实付 − 成本 − 手续费 = 收益」这条拆解。

### 9.5 导出

后台导出 Excel 增加「上游进价」「平台手续费」「平台毛利」列。代理导出不变，只把「手续费」列的含义明确为代理承担部分。

---

## 10. 测试

新增 `order-ledger-core.test.ts`，每个用例都断言 I1–I5：

| 用例 | 断言要点 |
|---|---|
| 无券、无开票 | 收益 = goods − cost − fee |
| 折扣券、满减券 | goods 为券后价；收益按券后算 |
| 券把收益压到恰好 0 | 允许 |
| 券把收益压到 −1 分 | 下单拒绝 |
| 开票单 | agent_fee 按 goods 算；platform_fee = 多出来的那部分 |
| 开票单，网关实收小于 feeOnGoods | platform_fee 为负，I2 仍然成立 |
| 一单 5 张 | cost、upstream 都乘以数量；固定费只收一次 |
| 网关手续费正常 | 覆盖估算 |
| 网关 = 估算×2+101 分 | 判为异常，不覆盖 |
| 网关 = 估算×3 但只多 80 分 | 不算异常（小单） |
| 上游进价未配置 | platform_profit = null；I4 跳过 |
| 下单后调成本价、挂牌价、进价 | 已下单订单不变 |

补充的集成测试：

- `settlements`：manual_review 被跳过；收益行被篡改 1 分时拒绝生成，并返回清单；
- `reconcile`：异常手续费转为 manual_review，收益行不变；
- 迁移回填：跑两次结果相同（幂等），`agent_earning_cents` 一个都不改；
- 通知格式快照测试。

---

## 11. 上线步骤

| 步骤 | 内容 | 可回滚 |
|---|---|---|
| 1 | 上线 7.1 核对接口和「收益核对」按钮，只读。在线上跑一次，确认 Polus 那张 ¥7.05 结算单和 ¥0.12 那单 | 是 |
| 2 | 根据核对结果人工修正错账（按 7.2） | — |
| 3 | 上线 `order-ledger-core`、加列、回填、5 个写入点改造、异常手续费转人工、结算前验算 | 加列不可逆，逻辑可回滚 |
| 4 | 后台配置各套餐上游进价；视情况回填历史订单 | 是 |
| 5 | 上线统计首页毛利卡片、通知新格式、代理订单拆解、兑换单标签 | 是 |

第 3 步和第 5 步可以合在一次发布里，但第 1 步必须先单独上线跑一次，拿到当前账目是否干净的结论。

---

## 12. 已定的简化

1. **卡台回传的 `fee_amount_minor`**：不用，上游进价只认后台配置。
2. **退款单的平台毛利**：不追踪上游能否退回。退款单毛利记为 0，不计入毛利合计，统计里只显示退款单数。
3. **开票加价**：10% 全部算平台毛利，不考虑税费等额外成本。
