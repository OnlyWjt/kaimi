# Kaimi

多代理即时发卡门户。客户在代理店铺付款后，平台按 [danew_card_cdk](https://cdk.danew.cc) 同一套卡台 OpenAPI 即时发码；客户回到本站兑换时，走卡台 public CDK 接口（preview / preflight / redeem / result）。不再对接 danewcdk Agent API。

## 相关推荐

| 项目 | 地址 |
| --- | --- |
| CDK 兑换系统 | https://cdk.danew.cc |
| 卡网 | https://card.danew.cc |
| 中转站 | https://claudec.ai |
| 卡台 | https://www.avanfinity.com/invite/DC12B3E5DF |

## 功能

- 前台：代理店铺、兑换、卡密查询、订单进度
- 兑换：卡台 preview 识别套餐；Session 须卡台 preflight 通过才提交，也支持邮箱密码
- 后台：总览、订单、卡密、接入卡台、商务配置、外观、使用说明
- 发码：支付成功后调用卡台 OpenAPI 即时出码
- 开通：服务端轮询卡台 result；可选终态通知到 Webhook 或 Telegram

## 目录

```
apps/web              Next.js 15（前台 / 后台 / API）
packages/themes       snow / aurora / ink / sakura
deploy/               Docker Compose + Caddy
.env.example          环境变量模板
docs/多代理即时发卡系统详细设计.md
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
后台默认账号：`admin` / `kaimi-change-me`。上线前务必改掉 `KAIMI_ADMIN_PASSWORD` 和 `KAIMI_SECRET_KEY`。

第一次开店：后台「接入卡台」加主台/备台、协议、Webhook 和选卡策略，再去商务配置设易支付、代理成本和可售套餐。

## 环境变量

复制 `.env.example` 到 `apps/web/.env.local`（本地）或项目根目录 `.env`（Docker）。

| 变量 | 说明 |
| --- | --- |
| `KAIMI_PUBLIC_BASE_URL` | 本站公网地址 |
| `KAIMI_SECRET_KEY` | 本地加密用，请改成足够长的随机串 |
| `KAIMI_CRON_SECRET` | 后台任务 Cron 的 Bearer 密钥（至少 24 位）；外部调度器每分钟 `POST /api/internal/jobs` |
| `KAIMI_DATABASE_URL` | 默认 `file:./data/kaimi.db`（SQLite） |
| `KAIMI_ADMIN_USER` / `KAIMI_ADMIN_PASSWORD` | 后台登录 |
| `CARD_API_BASE` / `CARD_API_KEY` | 可选。没有后台卡台账户时的环境变量兜底，和 danew_card_cdk 同名 |

卡台地址、协议、OpenAPI Key 和 Webhook Secret 在后台「接入卡台」填写，会加密写入数据库。回调路径为 `/api/v1/webhooks/cardplatform/{账户ID}`。

## Docker

```bash
cp .env.example .env
# 填写管理员密码，卡台在后台「接入卡台」配置
docker compose -f deploy/docker-compose.yml up -d --build
```

服务在 `3100`。前面可以用 Caddy 反代自己的域名。

## 客户怎么用

1. 打开代理店铺链接付款，支付成功后即时拿到卡密
2. 打开本站「开始兑换」，校验卡密（卡台 preview）
3. 粘贴 ChatGPT Session 整页 JSON 并预检（卡台 preflight），或改填邮箱密码
4. 提交后用订单号在「订单进度」查看开通结果

Session 预检地址：<https://chatgpt.com/api/auth/session>

## 数据库备份

本地 SQLite 文件默认在 `apps/web/data/kaimi.db`。上线前先演练一次复制恢复：

```bash
# 备份
cp apps/web/data/kaimi.db apps/web/data/kaimi.db.bak

# 恢复（停服务后）
cp apps/web/data/kaimi.db.bak apps/web/data/kaimi.db
```

生产环境应把该文件纳入定时备份，并至少恢复一次确认可用。

## 安全

- 卡台 API Key 只存在服务端，不进浏览器
- 卡密后台默认脱敏，点「显示」后才能复制
- 不要提交 `.env`、`.env.local`、`data/*.db`
- localtunnel 这类临时公网地址只适合自己测回调，不要当正式站点

## 许可

本仓库未附带开源许可证文件。发布或再分发前请自行补充许可声明。
