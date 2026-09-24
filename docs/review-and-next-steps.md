# 本次改动复盘与后续开发建议

分支：`feat/redeem-guard-open-api-agent-identity`（未提交）
写给接手的 AI：按优先级从上往下做。每条都写了**现象 / 位置 / 改法 / 验收**。做完一条跑一次 `npx tsc --noEmit` 和 `pnpm test`。

---

## 0. 本分支已经做了什么

| 模块 | 内容 | 关键文件 |
| --- | --- | --- |
| 订单与卡密关系 | `orders` 新增 `issued_cdk_id / store_order_id / agent_id / code_prefix / code_last4 / client_ip / hidden`，启动时回填；后台订单列表改读 `issued_cdks` | `db/schema.ts`、`db/migrate-lib.ts` 的 `ensureRedeemGuardSchema`、`app/api/admin/route.ts` |
| 兑换防刷 | 本地查不到卡密直接拒绝；失败落库计数，按 IP / 邮箱封锁；批量按张计额度；预检通过后才抢锁 | `lib/redeem-guard.ts`、`lib/redeem-guard-core.ts`、`lib/orders.ts`、`app/api/public/cdk/*`、`app/api/recharge/*` |
| 代理身份 | `agents.shop_name / real_name`；代理改店名只写 `shop_name`；收益明细、代理列表显示真实身份 | `app/api/agent/storefront/route.ts`、`app/api/admin/earnings/stats/route.ts`、`components/admin-agents.tsx` |
| 开放 API | API Key（平台 / 代理）、7 个 `/api/v1/open/*` 接口、幂等键、代理后台「开放 API」页、`openapi.json` | `lib/open-api/*`、`app/api/v1/open/**`、`app/api/agent/api-keys`、`app/api/admin/api-keys`、`components/agent-api-panel.tsx` |

已验证：`tsc` 通过，`redeem-guard-core` 等 46 个单测通过。**没有**做过浏览器端到端验证，也没有针对数据库逻辑的测试。

---

## P0：上线前必须修（有回归或安全问题）

### P0-1 代理改店名后，店铺前台不显示新名字（本次引入的回归）

- **现象**：代理在「店铺装修」改名，现在只写 `agents.shop_name`，但前台和下单快照仍读 `display_name`，改了等于没改。
- **位置**：
  - `app/s/[slug]/page.tsx` 第 70、98 行 `agent.displayName`
  - `lib/agent-shop.ts` 第 77 行 `shopName: shop.agent.displayName`
  - `lib/agent-console.ts` 第 65 行（代理后台标题）
  - `lib/store-orders.ts`、`lib/notify-commerce.ts`、`lib/notify.ts` 里面向客户的店名
- **改法**：新增 `lib/agent-names.ts`：
  ```ts
  export function publicShopName(a: { shopName?: string | null; displayName: string }) {
    return (a.shopName || "").trim() || a.displayName;
  }
  ```
  上面所有**面向客户和代理自己**的位置改用 `publicShopName`。**面向超管**的位置（统计、结算、卡密查询）用第 P1-4 条的身份标签。全仓 `rg "displayName" apps/web/src` 逐个归类，不要漏。
- **验收**：代理改店名后，`/s/{slug}` 标题、订单页、通知文案立刻变成新名字；超管收益统计里这一行的主名字不变。

### P0-2 代理被禁用后，他的 API Key 仍然能用

- **位置**：`lib/open-api/auth.ts` 的 `requireApiKey`。
- **改法**：`ownerType === "agent"` 时再查一次 `agents.status`，不是 `active` 返回 `UNAUTHORIZED`。同时在 `app/api/admin/agents/[id]/route.ts` 里，禁用代理时把他所有 `api_keys` 标成 `revoked`（双保险）。
- **验收**：禁用代理后，他的 Key 调任意接口返回 401。

### P0-3 超管给代理建 Key 时可以勾选超出代理范围的权限

- **位置**：`app/api/admin/api-keys/route.ts`。
- **改法**：`ownerType === "agent"` 时，`scopes` 必须是 `AGENT_SCOPES` 的子集（与 `app/api/agent/api-keys/route.ts` 共用同一个常量，抽到 `lib/open-api/scopes.ts`）。`agentId` 必须指向一个存在且 active 的代理。
- **验收**：给代理 Key 传 `agents:read` 返回 400。

### P0-4 匿名批量兑换一次就用完一小时额度

- **现象**：`assertBatchCodeBudget` 在 `batch/validate` 和 `batch/submit` 里各扣一次。客户先校验 10 张再提交 10 张，就是 20 张，正好用光匿名的每小时 20 张额度，之后一小时内什么都做不了。
- **位置**：`app/api/recharge/batch/validate/route.ts`、`app/api/recharge/batch/submit/route.ts`、`lib/redeem-guard.ts`。
- **改法**：只在 `submit` 扣额度；`validate` 只做「额度够不够」的只读检查（新增 `checkBatchCodeBudget`，不写事件）。
- **验收**：匿名校验 10 张 + 提交 10 张后，还能再提交 10 张；第三次提交超额返回 429。

### P0-5 迁移把历史上正常的失败兑换单也隐藏了

- **现象**：`ensureRedeemGuardSchema` 每次启动都执行
  `UPDATE orders SET hidden = 1 WHERE kind='recharge' AND fulfill_status='failed' AND issued_cdk_id IS NULL`。
  回填只能匹配到卡**最近一次**的兑换单（`issued_cdks.redemption_order_id` 会被下一次兑换覆盖），所以真实客户用真卡兑换失败、之后又重新兑换过的旧失败单也会被隐藏。
- **改法**：
  1. 隐藏条件收紧为「`issued_cdk_id IS NULL AND upstream_plan = '' AND upstream_request_id IS NULL`」，也就是既没对上卡、也从没打到卡台的单。
  2. 这条 `UPDATE` 只跑一次：用 `settings` 记一个 `migration_hide_probe_orders_v1 = done`。
  3. 后台订单列表加一个「显示已隐藏」开关（查询参数 `include_hidden=1`），隐藏的单能找回来。
- **验收**：真实客户打到过卡台的历史失败单重新出现在订单列表；`attacker@evil.com`、`amp@test.com` 这类从没打到卡台的探测单仍然隐藏。

### P0-6 幂等键并发时会重复建单

- **现象**：`lib/open-api/idempotency.ts` 是「先查、处理完再存」。同一个 `Idempotency-Key` 的两个请求并发进来，都查不到记录，都会建单。
- **改法**：处理前先插入一条 `status = 0`、`response_json = ''` 的占位行（依赖 `(key_id, idem_key)` 唯一索引抢占）；抢不到的请求读已有行：`status = 0` 返回 `409 CONFLICT`「请求处理中」，否则回放。处理结束后 `UPDATE` 成真实结果。24 小时前的记录由定时任务清理。
- **验收**：用同一个 Key 并发打 5 次 `POST /redemptions`，只建一笔 RC 单。

---

## P1：功能补全（本次方案里说了但没做完）

### P1-1 防刷事件表没有清理，会无限增长

- `redeem_guard_events` 每次失败写 2～3 行，批量额度每张写 1 行，`global` 计数也在写。
- **改法**：在 `lib/sync-scheduler.ts`（或同类定时入口）里加每日任务：删除 30 天前的 `redeem_guard_events`、24 小时前的 `api_idempotency`、已过期超过 7 天的 `redeem_guard_blocks`。
- 批量额度不要逐张写行：改成一行带 `count` 字段，或者单独建 `redeem_budget(subject, window_start, used)` 表。

### P1-2 超管后台缺三个页面

接口或底层函数已经有了，只差界面：

1. **拦截记录**：列出当前封锁（`listRedeemBlocks`），带「解封」按钮（`releaseRedeemBlock`）。需要新增 `app/api/admin/redeem-guard/route.ts`（GET 列表、DELETE 解封）。再加一个近 24 小时失败事件列表，按 IP 聚合。
2. **开放 API 管理**：列出所有 Key（平台 + 各代理），能新建平台 Key、吊销任意 Key。接口 `app/api/admin/api-keys` 已有。
3. **代理真实姓名编辑**：`admin-agents.tsx` 的编辑弹窗加「真实姓名」输入框，接口 `PATCH /api/admin/agents/{id}` 已支持 `realName`。

### P1-3 收益导出和结算还显示店名

- `app/api/admin/earnings/export.xlsx/route.ts`、`app/api/admin/settlements/route.ts` 仍用 `agents.displayName`。
- **改法**：导出加列「代理ID、登录名、真实姓名、店名、收款人、收款方式、收款账号（解密）」；结算列表和确认弹窗显示收款人和收款账号。结算列表的问题在 `app/api/admin/settlements/route.ts` 第 38 行 `agentName: agents.displayName`。
- 代理自己的导出（`app/api/agent/earnings/export.xlsx`）**不能**出现 `real_name`。

### P1-4 身份标签逻辑散在三处

- `app/api/admin/route.ts`（订单列表）、`app/api/admin/earnings/stats/route.ts`、`components/admin-agents.tsx` 各拼了一遍「姓名 · @登录名 · 店铺名」，规则还不完全一致。
- **改法**：新增 `lib/agent-identity-core.ts`（纯函数，配单测）和 `lib/agent-identity.ts`（带 `agents LEFT JOIN users` 的查询）。三处全部改用它，卡密查询、用量统计也接上。

### P1-5 OpenAPI 描述太简陋

- `lib/open-api/spec.ts` 现在只有路径和一句 summary，导入 Apifox / Postman 后没有参数和返回结构。
- **改法**：每个接口补 `parameters`、`requestBody`、`responses`（含错误结构和错误码枚举）。建议用 zod 定义请求和返回 schema，路由和文档共用同一份，用 `zod-to-json-schema` 生成，避免文档和实现不一致。
- 代理后台说明页里的 curl 示例改成读当前站点地址（`window.location.origin`），不要写死「你的域名」。

### P1-6 兑换结果回调

- 代理现在只能轮询 `GET /redemptions/{no}`。
- **改法**：按原方案第 3.7 节做 `api_webhook_endpoints` / `api_webhook_deliveries`，事件先只做 `redemption.succeeded`、`redemption.failed`。触发点是 `driveRechargeOrder` 和 `applyUpstreamStatus` 进入终态时。签名 `X-Kaimi-Signature: t=...,v1=HMAC`，投递走现有 `background-jobs.ts`，指数退避 5 次。

### P1-7 开放 API 的小问题

- `requireApiKey` 每次请求都写 `last_used_at`：改成同一个 Key 一分钟内最多写一次（内存里记上次写入时间）。
- 开放 API 的限流是进程内的，多实例不共享；可以先接受，但在文档里写明。
- 代理 Key 通过 API 兑换时，`orders.client_ip` 里写的是 `key:12`，后台看起来像 IP。改成单独一列 `source`（`web` / `api:{keyId}`），`client_ip` 存真实 IP。
- `agent-api-panel.tsx` 的「最近使用」直接显示 ISO 时间，改用 `lib/datetime.ts` 里已有的 `formatDateTime`。

---

## P2：项目整体可以优化的地方（与本次无强关联）

### P2-1 后台订单列表一次取 200 条再在内存里过滤

- `app/api/admin/route.ts` 的 `section === "orders"`：搜索只能搜到最近 200 条，旧单查不到；CSV 导出也只有 200 条。
- **改法**：改成 SQL 条件 + 游标分页，搜索条件下推到 SQL（订单号、邮箱 `LIKE`，完整卡密走 `code_hash` 精确匹配）。CSV 导出流式输出，并补上新增的来源单号、代理两列。

### P2-2 `app/api/admin/route.ts` 太大

- 一个文件用 `section=` 分发十几种功能，已经近 700 行，改一处容易影响别处。
- **改法**：按功能拆成 `app/api/admin/orders/route.ts`、`cdks/route.ts`、`integration/route.ts` 等；前端 `admin/page.tsx` 的 `loadSection` 同步改路径。可以分几次做，每次拆一个 section。
- `app/admin/page.tsx` 也有 1100 多行，同样按 Tab 拆成组件。

### P2-3 数据库逻辑缺测试

- 现有测试基本都是纯函数。本次最关键的几条链路（未知卡密不建单、预检后抢锁、并发抢锁只成一笔、封锁升级、代理 Key 越权）都没有测试。
- **改法**：vitest 里用 `KAIMI_DATABASE_URL=file::memory:` 或临时文件库跑 `migrate`，写集成测试。卡台客户端用 mock（`getCardplatformClientById` 注入假实现）。

### P2-4 迁移是「每次启动全跑一遍」

- `migrate-lib.ts` 已经 1100 多行，所有 `ALTER` 和回填每次启动都执行，靠吞 `duplicate column` 错误保证幂等。随着数据量变大，回填类 `UPDATE` 会拖慢启动。
- **改法**：引入 `schema_migrations(version, applied_at)` 表，新迁移按版本号只执行一次。已有迁移不动，只对新增的走版本化。

### P2-5 仓库卫生

- 根目录有 `.shots/`、`.tmp-ref-*.png/jpg` 等截图临时文件未忽略，`git status` 很乱。加进 `.gitignore`，或者删掉。
- 多个文件是 CRLF 换行，git 会提示转换。加 `.gitattributes`：`* text=auto eol=lf`。
- `apps/web/.env.local` 里 `KAIMI_SECRET_KEY` 还是示例值 `please-change-this-long-random-string`，而且 `KAIMI_ADMIN_PASSWORD` 和库里真实密码不一致，容易误导。本地可以接受，但部署模板里要写清楚。

### P2-6 本地日志噪音

- 开发时每轮同步都报 `sellable plans sync failed CardplatformError: 当前 IP 不在白名单内`。建议本地没配有效卡台时跳过同步，或同一错误只打印一次，避免掩盖真正的错误。

---

## 建议执行顺序

1. P0-1 ～ P0-6（一个 PR，合并前必须完成）
2. P1-1、P1-2、P1-3、P1-4（一个 PR：后台补齐）
3. P1-5、P1-6、P1-7（一个 PR：开放 API 完善）
4. P2 按需分拆，每项单独 PR

每个 PR 的通用要求：

- 迁移写在 `migrate-lib.ts`，幂等；一次性的回填用 `settings` 记完成标记。
- 纯逻辑放 `*-core.ts` 并配单测。
- 只给现有接口加字段，不改已有字段含义。
- 改完在浏览器里过一遍：客户兑换（正确卡 / 错误卡 / 被封）、代理改店名、代理建 Key 并用 curl 调通 7 个接口、超管看订单和收益。
