# 买家邮件模板：管理员设模板，代理二次编辑

> 版本：v1.0（2026-10-20）
> 状态：已实现（分支 feat/mail-templates），静态原型见 `docs/mail-template/index.html`
> 下文 `src/...` 均指 `apps/web/src/...`

---

## 0. 结论

| 问题 | 决定 |
|---|---|
| 格式 | 发 HTML 邮件，同时附自动生成的纯文本版（`multipart/alternative`） |
| 售后联系 | 代理可以改，但至少留一个有效的微信 / QQ / Telegram |
| 链接 | 可以写任意链接，链接里也能用变量（代理自己系统的查单页） |
| 平台模板更新后 | 已经自定义过的代理模板不变；没自定义过的跟着平台走 |
| 外观 | 主色、页头跟平台统一，代理不能改 |
| 语言 | 本期只有中文 |

工作量约 3 天：HTML 骨架 + 渲染 1 天，后端 + 校验 0.5 天，两个界面 1.5 天。

---

## 1. 范围

kaimi 以店铺名义发给买家的 4 封信，现在都是代码里拼的纯文本：

| key | 邮件 | 触发 | 现在的位置 |
|---|---|---|---|
| `delivery` | 发货邮件（卡密 / 账号） | 发货完成 | `mail.ts` `sendDeliveryMail` |
| `order_links` | 查单链接 | 买家在店铺按邮箱找订单 | `mail.ts` `sendOrderLinksMail` |
| `coupon_notice` | 邀请券到账 | 邀请的好友下单成功 | `referrals-mail.ts` |
| `coupon_remind` | 邀请券快到期 | 券 3 天内到期 | `referrals-mail.ts` |

另有一个共用区块 `after_sales`（售后联系），见 §4。

发票邮件由 Folio 发，不在本期范围。

---

## 2. 代理只管内容，外观由平台定

- **外观**：HTML 骨架（页头店名、内容卡片、卡密框、按钮、页脚）写在代码里，表格布局 + 内联样式，宽 600px，手机自动收窄。不放外链图片。
- **内容**：代理用一种简单格式写正文，系统同时生成 HTML 版和纯文本版。

| 写法 | 效果 |
|---|---|
| 空一行 | 分段 |
| `**文字**` | 加粗 |
| `[文字](https://...)` | 带文字的链接 |
| 直接写网址 | 自动变链接 |
| `---` | 分隔线 |
| `{{变量}}` | 订单数据或一整块内容 |

链接里可以用变量：`[查看订单](https://我的站/order?no={{order_no}})`。

标题只能是纯文本 + 普通变量。

---

## 3. 变量

**普通变量**（一段文字）

| 变量 | 内容 | 可用于 |
|---|---|---|
| `{{shop}}` | 店名 | 全部 |
| `{{order_no}}` | 订单号 | 发货 |
| `{{product}}` | 商品名 | 发货 |
| `{{quantity}}` | 数量 | 发货 |
| `{{paid_at}}` | 付款时间（北京时间） | 发货 |
| `{{buyer_email}}` | 买家邮箱 | 全部 |
| `{{query_url}}` | 这一单的平台查单链接 | 发货 |
| `{{coupon_code}}` `{{coupon_scope}}` `{{coupon_expires_at}}` `{{shop_url}}` | 券码、可用范围、到期时间、店铺地址 | 邀请券 |

**区块变量**（一整块带样式的内容，为空时连同所在位置一起去掉）

| 变量 | HTML 版 | 纯文本版 |
|---|---|---|
| `{{items}}` | 每张一个等宽字体框，方便复制 | 每行一张 |
| `{{after_sales}}` | 带标题的联系方式框，Telegram 可点 | 现在的「售后联系」段落 |
| `{{invite}}` | 浅色提示框 + 邀请链接 | 现在的文字 |
| `{{order_links}}` | 每单一行 +「查看」按钮 | 每单两行 |
| `{{coupon_usage}}` | 券码框 + 使用说明 | 现在的文字 |

**必须保留**（缺了不能保存；不认识的变量也不能保存）

| 模板 | 必留 |
|---|---|
| `delivery` | `{{items}}` `{{after_sales}}` |
| `order_links` | `{{order_links}}` `{{after_sales}}` |
| `coupon_notice` / `coupon_remind` | `{{coupon_code}}` 或 `{{coupon_usage}}` |

---

## 4. 售后联系：能改，至少留一个

`{{after_sales}}` 的内容是一个单独设置的区块，所有邮件共用：

- 标题、说明文字随便改。
- 联系方式：默认列出店铺装修里的联系方式，可以取消勾选；也可以新增「只在邮件里用」的联系方式。
- 保存时用 `contactValueError` 校验格式，至少要有一个格式正确的微信 / QQ / Telegram（和「没有售后联系方式不能接单」同一条规则）。
- 正文里的 `{{after_sales}}` 不能删。联系方式只能从这里出，系统才判断得了「至少留一个」。

邮件发出时，勾选的店铺联系方式取**当时**店铺装修里的值，代理改了店铺联系方式邮件自动跟着变。

---

## 5. 三层模板

```
系统默认（代码，等于现在的文案）→ 平台模板（管理员）→ 代理模板（代理）
```

- 发信时取第一个存在的：代理 → 平台 → 系统默认。
- 代理点「自定义」时把**当时的**平台模板复制一份。之后管理员改平台模板不影响他。
- 管理员每种模板一个「允许代理修改」开关。关掉后代理那份保留但不生效，代理后台只显示预览。
- 上线时系统默认模板渲染出的纯文本版和现在的邮件文字一致，只有空行不同：原来发货邮件、查单链接的店名和第一行挨着，现在统一空一行。

---

## 6. 数据

新表 `mail_templates`：

| 列 | 说明 |
|---|---|
| `id` | |
| `agent_id` | 0 = 平台，> 0 = 代理 |
| `template_key` | `delivery` / `order_links` / `coupon_notice` / `coupon_remind` / `after_sales` |
| `subject` | 纯文本，≤ 120 字（`after_sales` 为空） |
| `body` | 正文，≤ 5000 字（`after_sales` 存说明文字） |
| `config_json` | 只有 `after_sales`：`{ title, contacts: [{ source: "shop", type }, { source: "mail", type, value }] }` |
| `agent_editable` | 只对平台行有意义，默认 1 |
| `updated_by`、`created_at`、`updated_at` | |

唯一索引 `(agent_id, template_key)`。增删改都写审计日志（`mail_template.update` / `mail_template.reset`）。

---

## 7. 渲染

`src/lib/mail-template-core.ts`（纯函数）：

```ts
TEMPLATE_DEFS: Record<TemplateKey, { label; variables; blocks; required; defaultSubject; defaultBody }>
validateTemplate(key, { subject, body }): string[]          // 错误列表
validateAfterSales(config, shopContacts): string | null
renderMail(key, template, vars, blocks): { subject, html, text }
```

- 先把正文按行解析成段落 / 分隔线 / 区块，再分别输出 HTML 和纯文本，两边内容一致。
- 所有变量值、代理写的文字先转义再进 HTML。
- 链接只允许 `http:` / `https:`，变量替换**之后**再检查一次（防 `{{buyer_email}}` 之类拼出 `javascript:`）。
- 区块为空：去掉该行，并合并前后多出的空行。

`src/lib/mail-layout.ts`：HTML 骨架，入参 `{ shop, contentHtml, preheader }`。

`mail.ts` / `referrals-mail.ts`：拼字符串改成「准备变量 → `renderMail()` → `sendMail({ subject, html, text })`」。开关、重试、发件人、回复邮箱逻辑不动。

---

## 8. 接口

| 接口 | 作用 |
|---|---|
| `GET/PUT /api/admin/mail-templates` | 平台模板读写、`agent_editable` 开关 |
| `POST /api/admin/mail-templates/preview` | 用示例数据渲染 |
| `POST /api/admin/mail-templates/test` | 发测试邮件 |
| `GET /api/admin/mail-templates/agents` | 改过模板的代理列表 |
| `DELETE /api/admin/mail-templates/agents/[agentId]/[key]` | 重置某个代理 |
| `GET/PUT/DELETE /api/agent/mail-templates` | 代理读、存、恢复平台模板 |
| `POST /api/agent/mail-templates/preview`、`/test` | 预览、发测试（只发自己填的邮箱，每天 10 次） |

---

## 9. 界面

- **代理**：「通知」页「发给买家的邮件」卡片里加「邮件模板」，标签页：发货邮件 / 查单链接 / 邀请券 / 售后联系。左边编辑，右边预览（沙箱 iframe，可切 HTML / 纯文本）。
- **管理员**：「通知」页邮件配置下面加「邮件模板」，同样的编辑器，外加「允许代理修改」「恢复系统默认」、改过模板的代理列表。

---

## 10. 风险

- 进垃圾箱：骨架简单、不放外链图片、HTML 和纯文本内容一致。发信域名要配好 SPF / DKIM。
- 代理写违规 / 钓鱼内容：审计日志；管理员可重置任一代理、可整体关掉「允许代理修改」。

---

## 11. 测试

- 默认模板的纯文本版和现在的文字一致（四封信 + 有无售后 / 邀请的组合，忽略空行）。
- 三层取模板顺序；关掉 `agent_editable` 后代理模板不生效。
- 必留变量、未知变量、长度校验。
- 售后联系：一个有效微信 / QQ / TG 都没有时不能保存；店铺联系方式改了邮件跟着变。
- HTML 转义；`javascript:` 链接被拦（含变量拼出来的）；区块为空时去掉多余空行。
