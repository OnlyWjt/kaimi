# Kaimi

二级代理自托管的卡密兑换门户。客户在外部发卡店买码，回到本站校验卡密、提交 Session 或邮箱密码开通；你在后台对接上游 [danewcdk](https://cdk.danew.cc) Agent API、管库存和订单。

内部 `/shop` 发卡网默认关闭，只作调试。日常卖卡用「外观」里配置的购买外链。

## 相关推荐

| 项目 | 地址 |
| --- | --- |
| CDK 兑换系统 | https://cdk.danew.cc |
| 卡网 | https://card.danew.cc |
| 中转站 | https://claude.ai |
| 卡台 | https://www.avanfinity.com/invite/DC12B3E5DF |

## 功能

- 前台：首页、兑换、卡密查询、订单进度
- 兑换：先校验卡密识别套餐；Session 须预检通过才提交，也支持邮箱密码
- 后台：总览、订单、卡密、进货、接入上游、外观、使用说明
- 库存：未使用 / 占用中 / 已售出 / 已核销 / 已禁用；对账只动「未使用」，不误伤已售出
- 开通：Webhook 强制验签；服务端每分钟轮询未结束订单，并修复卡住的锁
- 可选：订单终态通知到 Webhook 或 Telegram

## 目录

```
apps/web              Next.js 15（前台 / 后台 / API / webhook）
packages/upstream     上游 Agent API 客户端
packages/themes       snow / aurora / ink / sakura
deploy/               Docker Compose + Caddy
.env.example          环境变量模板
方案.md               早期设计文档（部分已过时，以本 README 为准）
```

## 环境要求

- Node.js 20+
- [pnpm](https://pnpm.io/) 10（仓库已指定 `packageManager`）

## 本地启动

```bash
pnpm install
cp .env.example apps/web/.env.local
# 按需改 apps/web/.env.local
pnpm dev
```

默认端口 `3100`：

| 页面 | 地址 |
| --- | --- |
| 首页 | http://localhost:3100 |
| 兑换 | http://localhost:3100/recharge |
| 卡密查询 | http://localhost:3100/cdk |
| 订单进度 | http://localhost:3100/lookup |
| 后台 | http://localhost:3100/admin |
| Webhook | `POST /api/webhook` |

后台默认账号：`admin` / `kaimi-change-me`。上线前务必改掉 `KAIMI_ADMIN_PASSWORD` 和 `KAIMI_SECRET_KEY`。

第一次开店的步骤写在后台「使用说明」里：接入上游 → 填 Webhook 回调 → 同步库存 → 进货 → 改外观和外链。

## 环境变量

复制 `.env.example` 到 `apps/web/.env.local`（本地）或项目根目录 `.env`（Docker）。

| 变量 | 说明 |
| --- | --- |
| `KAIMI_UPSTREAM_BASE_URL` | 主站根地址，例如 `https://cdk.danew.cc` |
| `KAIMI_UPSTREAM_API_KEY` | 代理 Key，`ak_live_…` |
| `KAIMI_WEBHOOK_SECRET` | 主站下发的签名密钥，`whsec_…`。空值会拒绝回调 |
| `KAIMI_PUBLIC_BASE_URL` | 本站公网地址，用来生成 Webhook 回调 URL |
| `KAIMI_SECRET_KEY` | 本地加密用，请改成足够长的随机串 |
| `KAIMI_DATABASE_URL` | 默认 `file:./data/kaimi.db`（SQLite） |
| `KAIMI_ADMIN_USER` / `KAIMI_ADMIN_PASSWORD` | 后台登录 |
| `KAIMI_ALLOW_INSECURE_WEBHOOK` | 仅本地调试。设为 `1` 才允许空签名，生产不要开 |

上游配置也可以在后台「接入 danewcdk」里填写，会加密写入数据库。

## Docker

```bash
cp .env.example .env
# 填写上游与管理员密码
docker compose -f deploy/docker-compose.yml up -d --build
```

服务在 `3100`。前面可以用 Caddy 反代自己的域名。

## 客户怎么用

1. 在你配置的外部发卡店付款，拿到完整卡密
2. 打开本站「开始兑换」，校验卡密
3. 粘贴 ChatGPT Session 整页 JSON 并预检，或改填邮箱密码
4. 提交后用订单号在「订单进度」查看开通结果

Session 预检地址：<https://chatgpt.com/api/auth/session>

## 安全

- API Key 和 Webhook Secret 只存在服务端，不进浏览器
- Webhook 用原始字节 HMAC 验签，带时间窗和 `event_id` 幂等
- 卡密后台默认脱敏，点「显示」后才能复制
- 不要提交 `.env`、`.env.local`、`data/*.db`
- localtunnel 这类临时公网地址只适合自己测回调，不要当正式站点

## 许可

本仓库未附带开源许可证文件。发布或再分发前请自行补充许可声明。
