# 代理店铺（二级代理 Storefront）产品设计文档

> 版本：v0.1（2026-09-08） · 状态：设计评审中
> 静态预览：`/preview/storefront`（配置驱动演示稿，未接真实下单）

---

## 1. 背景与目标

平台支持二级代理以 `/s/[slug]` 形式开店卖货。当前代理店只是一个简版下单页（`StoreCheckout`），代理只能改主题和零售价，店铺没有品牌感、没有客服入口、没有查单能力。

**目标：**

1. 给二级代理一个"拿得出手"的店铺首页：Hero、搜索、统计、邮箱查单、商品网格、商品详情弹窗、页脚客服。
2. 店铺表现由**后台自定义选项**驱动，代理可装修自己的店，平台保留商品与价格的管控权。
3. 支持中/英双语切换。
4. 全部视觉走现有主题令牌（`--km-*`），代理选主题即换肤。

**非目标（本期不做）：** 代理自建商品（只能卖平台套餐）、购物车多件结算、独立域名绑定、店铺 SEO 自定义。

---

## 2. 现状盘点

### 2.1 数据模型（Drizzle + SQLite，`apps/web/src/db/schema.ts`）

| 表 | 与店铺相关的字段 | 缺口 |
|---|---|---|
| `agents` | `displayName`、`currentSlug`、`themeId`、`status`、`notes`；结算三列空置 | 无 slogan / logo / 联系方式 / 语言 / 公告等装修字段 |
| `platform_plans` | `planKey`、`name`、`description`、`coverUrl`、`globalCostPriceCents`、`maxRetailPriceCents`、`enabled`、`sortOrder`、`cardplatformSellable` | 无双语文案、无规格（specs）概念、无"自动发货"标记 |
| `agent_plan_prices` | `agentId`×`planId`、`costOverrideCents`、`retailPriceCents`、`enabled` | 代理只能改价，不能改文案/排序 |
| `storefronts` | 有 `logoUrl`/`contacts`/`announcement`/`homeBanner` 等预留列 | 仅平台店使用，代理店不经过它 |

### 2.2 后台现有自定义能力

| 角色 | 已有能力 | 入口 |
|---|---|---|
| 超管 | 建代理（用户名/显示名/slug/勾选套餐）、启停、重置密码、默认成本价与零售价上限、代理套餐开关与成本覆盖 | `/admin?tab=agents` |
| 超管 | 整站外观（siteName/siteTheme/shopEnabled）、平台店文案 | `/admin` appearance |
| 代理 | 改 slug、选主题、改各套餐零售价、改密码 | `/agent`（`agent-dashboard.tsx`） |

### 2.3 前台现状

- `/s/[slug]`：取 `agents` + 可售套餐 join → 渲染 `StoreCheckout`（简版）。
- `/preview/storefront`：新版 `AgentStorefront` 静态预览，**已改为 `StorefrontConfig` 配置驱动**，即本文档的页面稿。

---

## 3. 页面设计

### 3.1 信息架构（从上到下）

```
┌────────────────────────────────────────────────────┐
│ 吸顶区：Logo+店名 │ 导航胶囊 │ 查单/主题/语言按钮      │
│ 公告条（可关，代理自定义文案）                        │
├────────────────────────────────────────────────────┤
│ Hero：徽标 chip + 大标题 + 副标题（均可自定义/可关）    │
│ 大圆角搜索框（可关）                                 │
│ 统计卡片 ×N（可关，数值+文案自定义，3~4 个为宜）        │
├────────────────────────────────────────────────────┤
│ 邮箱查单卡（可关）：邮箱输入 + 查询按钮               │
├────────────────────────────────────────────────────┤
│ 商品中心：标题 + 分类胶囊（全部/AI 对话/…）            │
│ 商品网格 3 列：图标/名称/副标题/标签/¥起价/库存/购买   │
├────────────────────────────────────────────────────┤
│ 页脚：品牌+slogan │ 便捷链接 │ 联系客服（多条自定义）  │
│ 版权行                                             │
└────────────────────────────────────────────────────┘

商品详情 = 独立整页（不是弹窗）：
┌────────────────────────────────────────────────────┐
│ 面包屑：首页 / 商品中心 / {商品名}                    │
├──────────────────────┬─────────────────────────────┤
│                      │ 分类 · CHATGPT               │
│   商品主图（大图卡）   │ 商品名（大标题）              │
│   标语 + 规格标记      │ 徽标：官方直充/自动发货/有库存 │
│                      │ 价格 1100.00 CNY（大号强调色）│
│                      │ 选择规格（竖排卡片+库存+发货标）│
│                      │ 商品描述（正文段落）           │
│                      │ 购买数量（步进器）             │
│                      │ 联系邮箱（输入框+提示）        │
│                      │ 通栏购买按钮（含金额）         │
├──────────────────────┴─────────────────────────────┤
│ 详细资讯（整宽卡片）                                 │
│ 🎁 商品说明 / ✅ 账号建议 / 📌 使用说明 / ⚠️ 质保说明   │
│ 每段为「加粗小标题：正文」多行，兑换网站为可点链接      │
├────────────────────────────────────────────────────┤
│ ← 返回商品列表                                      │
└────────────────────────────────────────────────────┘
```

### 3.2 关键交互

| 交互 | 说明 |
|---|---|
| 导航胶囊 | 平滑滚动到对应区块；"联系客服"仅在配置了联系方式时出现 |
| 搜索框 | 实时过滤商品（匹配中/英文名与副标题），与分类筛选叠加 |
| 商品卡 → 详情页 | 点击进入整页详情（回到顶部）；面包屑、"返回商品列表"、ESC 均可回列表；详情页里点顶部导航会先回列表再滚到目标区块 |
| 规格选择 | 竖排单选，选中态主题色描边；每条显示该规格库存与"自动发货"徽标 |
| 数量步进 | 1 ~ 该规格库存上限；价格与按钮金额实时联动，两位小数 |
| 邮箱必填 | 未填邮箱时购买按钮禁用（卡密发往该邮箱） |
| 语言切换 | 🌐 按钮中/EN 互切；仅启用多语言时显示；系统文案平台内置，店铺内容取代理填的双语文案 |
| 主题 | 代理后台选定主题；预览页色板仅演示用，不进生产 |

---

## 4. 自定义选项设计（核心）

### 4.1 选项总表

**开放给二级代理**（代理后台"店铺装修"表单）：

| 选项 | 类型 | 默认值 | 双语 | 说明 |
|---|---|---|---|---|
| 店铺名称 `shopName` | 文本 | 创建时的 displayName | 否 | 头部/页脚/版权/弹窗标题 |
| Logo 字母 `logoLetter` | 单字符 | 店名首字母 | 否 | 圆形徽标；P2 升级图片上传 |
| 店铺标语 `slogan` | 文本 | 空 | ✅ | 页脚品牌区 |
| 主题 `themeId` | 9 选 1 | snow | — | 已有能力，保留 |
| 公告 `announcement` | 开关 + 文本 | 关 | ✅ | 吸顶区下方横条 |
| Hero 区 `hero` | 开关 + chip/标题/副标题 | 开，平台默认文案 | ✅ | 全部留空则用平台默认 |
| 统计卡片 `stats` | 开关 + 最多 4 组(数值+文案) | 开：累计订单/好评率/24h 发货 | ✅ | **不含"在售商品"列**（已按需求移除） |
| 搜索框 `searchEnabled` | 开关 | 开 | — | |
| 邮箱查单 `queryEnabled` | 开关 | 开 | — | 关闭后导航"订单查询"同时隐藏 |
| 联系客服 `contacts` | 列表(类型+称呼+值)，最多 5 条 | 空 | 称呼✅ | 类型：Telegram / 邮箱 / 微信 / QQ / 自定义链接；TG 与邮箱自动转链接，微信/QQ 纯展示 |
| 默认语言 `defaultLang` | zh / en | zh | — | |
| 启用语言 `languages` | zh+en / 仅 zh | 仅 zh | — | 仅 zh 时前台不显示切换按钮 |
| 零售价 `retailPriceCents` | 每套餐数值 | 平台建议价 | — | 已有能力，保留；不得超过平台上限 |
| 套餐上下架 `enabled` | 每套餐开关 | 平台分配时开 | — | 已有（`agent_plan_prices.enabled`），保留 |

**平台（超管）保留管控：**

| 选项 | 说明 |
|---|---|
| 套餐目录 / 成本价 / 零售价上限 | `platform_plans` + 代理套餐弹窗，现有能力 |
| 套餐名称 / 规格定义 / 商品说明 | P2 前由平台统一维护；P2 允许代理做"文案覆盖" |
| 代理启停 / 全局销售开关 / 单笔最大数量 | 现有能力 |
| 支付渠道（支付宝/微信） | 现有能力 |
| 系统界面文案（导航/按钮/弹窗标签等） | 平台内置双语，不开放修改 |

### 4.2 设计决策

- **店铺内容双语、系统文案内置**：代理只填自己店的内容（标语/公告/客服称呼），按钮、导航等 chrome 文案平台统一翻译，避免代理面对几十个翻译框。
- **统计卡片去掉"在售商品"**：在售数量随套餐上下架波动，对买家无决策价值，已从默认配置移除；代理可自行加回同类自定义项（数值+文案完全自由）。
- **联系方式结构化存储**而非自由文本：类型决定图标与跳转协议（`t.me/`、`mailto:`），微信/QQ 防爬只展示文本。
- **配置与商品分离**：装修配置一张表，商品仍走 `platform_plans × agent_plan_prices`，代理不碰商品定义，平台管控权不变。

---

## 5. 数据模型改动

新建 `agent_storefronts` 表（不动 `agents` 主表，装修配置独立演进）：

| 列 | 类型 | 默认 | 对应选项 |
|---|---|---|---|
| `agent_id` | integer PK → agents.id | — | 一对一 |
| `slogan_zh` / `slogan_en` | text | `""` | 标语 |
| `logo_letter` | text(1) | `""` | Logo 字母（空=店名首字母） |
| `announcement_enabled` | integer(bool) | 0 | 公告开关 |
| `announcement_zh` / `announcement_en` | text | `""` | 公告文案 |
| `hero_json` | text(JSON) | 平台默认 | Hero 开关+chip+标题+副标题 |
| `stats_json` | text(JSON) | 默认 3 项 | 统计卡片 |
| `search_enabled` | integer(bool) | 1 | 搜索框 |
| `query_enabled` | integer(bool) | 1 | 邮箱查单 |
| `contacts_json` | text(JSON) | `[]` | 联系客服列表 |
| `default_lang` | text | `"zh"` | 默认语言 |
| `languages_json` | text(JSON) | `["zh"]` | 启用语言 |
| `updated_at` | text | now | — |

JSON 列理由：hero/stats/contacts 为结构化数组，SQLite 无 schema 约束需求，读写都在服务端完成校验（zod）。

P2 追加：`agent_plan_prices` 增加 `display_override_json`（代理覆盖商品副标题/标签，不碰名称与说明）。

---

## 6. 后台改动

### 6.1 代理后台 `/agent` 新增"店铺装修"卡片

表单分区（与选项总表一一对应）：

1. **基础**：店铺名称、Logo 字母、标语（中/英两个输入框）
2. **公告**：开关 + 文案（中/英）
3. **Hero**：开关 + chip/标题/副标题（中/英，留空提示"使用平台默认"）
4. **统计卡片**：开关 + 可增删的数值/文案行（最多 4）
5. **功能开关**：搜索框、邮箱查单
6. **联系客服**：可增删行（类型下拉 + 称呼 + 值），拖拽排序
7. **语言**：默认语言 + 启用语言
8. **实时预览**：右侧 iframe 预览 `/s/[slug]?preview=1`，保存前可见效果

API：`GET/PATCH /api/agent/storefront`（zod 校验，仅本人代理）。

### 6.2 超管侧

- 代理列表增加"店铺装修"只读查看（排查投诉用）。
- 可选：敏感词过滤在保存 API 层做（公告/标语/客服称呼）。

---

## 7. 前台接入方案

`/s/[slug]/page.tsx` 从 `StoreCheckout` 切换到 `AgentStorefront`：

1. 查 `agents` + `agent_storefronts`（无记录则用平台默认配置兜底，老代理无感升级）。
2. 查可售套餐（现有 join 逻辑不变），映射为 `StorefrontProduct[]`：
   - `name/subtitle` ← `platform_plans`（P2 支持代理覆盖）
   - `specs` ← 套餐的规格定义（需在 `platform_plans.cardplatformRawJson` 或新列中维护规格数组；过渡期单规格）
   - `stock` ← `cdk_pool` 计数（现有逻辑）
   - 价格 ← `agent_plan_prices.retailPriceCents`
3. 组装 `StorefrontConfig` 传入 `<AgentStorefront config={...} />`（非 preview 模式，无色板）。
4. 下单：弹窗"立即购买"→ 复用现有下单 API（邮箱+套餐+数量），支付渠道沿用现有 `channels`。
5. 查单：`POST /api/shop/query` 按邮箱查 `store_orders`（现有接口，确认返回卡密字段即可）。

---

## 8. i18n 方案

- **系统文案**：`AgentStorefront` 内置 zh/en 字典（现已实现）；若后续页面增多再迁 `next-intl`。
- **店铺内容**：配置字段存 zh/en 两份；代理只填中文时，英文界面回退显示中文（`text[lang] || text.zh`）。
- `<html lang>` 随 `defaultLang` 输出。

---

## 9. 分期计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 静态页面稿（配置驱动组件 + 主题适配 + 双语 + 商品详情页） | ✅ 已完成，`/preview/storefront` 可看 |
| P1 | `agent_storefronts` 建表 + 代理后台装修表单 + `/s/[slug]` 接入真实套餐与下单/查单 | ✅ 已完成，见下方 §11 |
| P2 | 商品文案覆盖、Logo 图片上传、公告富文本、敏感词过滤、超管只读查看 | 待开发 |
| P3 | 独立域名、分享卡片（OG 图）、店铺访问统计 | 规划 |

---

## 10. 开放问题

1. **规格（specs）数据从哪来**：平台套餐目前是一对一价格，参考图的"独享月卡/共享月卡/季卡"需要平台侧先建规格模型，还是把每个规格拆成独立 `planKey`？（倾向后者，零 schema 改动，P1 即可上）
2. **统计卡片的数值**：代理手填（可能夸大）还是平台按真实订单算（不可改）？倾向：默认项由平台算真实值，代理只能改文案或换成自定义项。
3. **微信/QQ 客服**是否允许代理填（合规/投诉风险），还是仅开放 Telegram + 邮箱？
4. 代理改店名是否需要超管审核（防冒充官方）？

---

## 11. P1 实现记录

### 落地文件

| 文件 | 作用 |
|---|---|
| `apps/web/src/db/migrate-lib.ts` | DDL 里新增 `agent_storefronts`，随 `bootDb()` 自动建表 |
| `apps/web/src/db/schema.ts` | drizzle 表定义 `agentStorefronts` |
| `apps/web/src/lib/agent-storefront-config.ts` | 装修配置类型、平台默认文案、zod 校验、行↔配置转换、套餐→商品映射 |
| `apps/web/src/app/api/agent/storefront/route.ts` | `GET/PATCH`，`requireAgent()` 鉴权，upsert 写入 |
| `apps/web/src/components/agent-storefront-settings.tsx` | 代理后台「店铺装修」表单 |
| `apps/web/src/components/agent-storefront.tsx` | 前台组件，接真实下单/查单 API |
| `apps/web/src/app/s/[slug]/page.tsx` | 组装配置并渲染新店铺 |
| `apps/web/src/app/preview/storefront/demo.ts` | 静态预览假数据（不参与线上） |

### 与设计稿的偏差（有意）

- **规格模型**：按开放问题 1 的结论走「一个 `planKey` = 一个商品 = 一个规格」，零 schema 改动。详情页的规格列表因此只有一行「预设规格」，与参考图一致。多规格等平台侧建规格模型后再展开。
- **库存**：代理店走卡台即时发卡，没有本地 `cdk_pool` 可数，所以 `stock` 传 `null`，前台显示「现货 / 有库存」而不是具体件数。
- **统计卡片**：默认为空（代理不填就不显示），没有实现"平台算真实值"，避免代理手填夸大数字的同时也不引入新的统计口径。
- **停售兜底**：`agent.status !== "active"` 或平台停售时，仍渲染原来的简版提示页，不把装修页挂在没货的店上。
- **商品详情文案**：`商品说明` 取平台套餐 description，`使用说明 / 质保说明` 用平台统一文案，代理不可改（P2 再开放覆盖）。

### 复用的既有链路（未改动）

- 下单：`POST /api/public/store-orders` → `createStoreOrder` → 易支付 `payUrl` → `window.location.href` 跳转
- 查单：`GET /api/public/store-orders?slug&email` → 结果行链接到 `/shop/order/{orderNo}?qt=`
- sessionStorage 键沿用 `kaimi-store-email`、`kaimi-order-token:{orderNo}`、`kaimi-last-store-order`
- 数量上限 `getMaxOrderQuantity()`、支付渠道 `payment_channel_configs`、停售闸门 `getStoreSalesGate()`

### 老代理升级

`agent_storefronts` 无记录时 `rowToSettings(null)` 返回全默认值，前台用平台文案兜底，无需数据迁移。
