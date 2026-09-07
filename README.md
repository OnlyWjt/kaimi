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
./deploy/up.sh up -d --build
```

`up.sh` 的参数原样透传给 `docker compose`，`ps` / `logs -f kaimi` / `down` 都照常用。它只多做一件事：算出本机 docker 网桥地址，让应用**只绑在那个地址上**——宿主机和其他容器（1Panel 的 OpenResty、现成的 nginx）连得进来，公网连不进来。网桥段每台机器都不一样，写死过一次，绑到不存在的地址上容器直接起不来、网关跟着回 502，所以这个值不该由人去猜。

改了代码就必须带 `--build`。镜像是在构建阶段跑 `pnpm build` 把产物烤进去的，容器不读服务器上的源码目录，少了 `--build` 只会拿旧镜像重起一个容器。

启动时会打印一行 `应用绑定 x.x.x.x:3100`，那就是反向代理该填的地址。

绕过 `up.sh` 直接 `docker compose` 也能跑，但那时会绑 `0.0.0.0`，必须用防火墙挡掉公网访问 3100，否则外部可以绕过代理直连应用、随便伪造 `X-Forwarded-For`，按 IP 的限流形同虚设。

**宿主机 80/443 还空着**，想用自带的 Caddy 自动签证书：

```bash
DOMAIN=kaimi.example.com ./deploy/up.sh --profile caddy up -d --build
```

**宿主机已经有网关**（1Panel 的 OpenResty、现成的 nginx），就别启用自带 Caddy，它会抢不到 80/443 导致整次部署失败。在已有网关里把域名反代到启动时打印的那个地址，并确认它转发了真实来源，nginx/OpenResty 的写法是：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

然后在 `.env` 里加一行，让限流按这个头认客户端，而不是去数 XFF 的跳数：

```
KAIMI_CLIENT_IP_HEADER=x-real-ip
```

按 IP 的限流只在"公网无法绕过代理直连 3100"时才有意义，所以别把 `KAIMI_BIND_ADDR` 改成 `0.0.0.0`。

### 网关回 502

502 是网关自己生成的，意思只有一个：它连不上后端。请求根本没进到本站（进来了报错会是 500 和本站的错误页）。按这个顺序查：

```bash
./deploy/up.sh ps                                     # 容器在跑吗，PORTS 那列绑的是哪个地址
curl -s -o /dev/null -w '%{http_code}\n' http://<绑定地址>:3100/   # 宿主机直连通不通
docker exec <网关容器名> curl -s -o /dev/null -w '%{http_code}\n' http://<绑定地址>:3100/
docker logs --tail 30 <网关容器名> 2>&1 | grep -i "upstream\|refused\|timed out"
```

第三条最关键：它从**网关容器内部**发起，也就是 502 真正发生的位置。网关自己是容器时，反代目标写 `127.0.0.1:3100` 必然失败——那个 `127.0.0.1` 是网关容器自己。

用 `curl 127.0.0.1` 测网关是没用的：不带 Host 头和 TLS SNI 会落到默认站点，默认站点通了不代表你域名那个 vhost 通了。要带上真实域名测。

### compose 项目名和数据卷

数据在 named volume 里，卷名带 compose 项目名前缀。项目名默认取目录名 `deploy`，所以是 `deploy_kaimi_data`。

同一台机器上别的 stack 也叫 `deploy` 时，会互相认成 orphan，在这个目录里执行 `down --remove-orphans` 会顺手删掉邻居的容器。想换成独立项目名，必须先把卷复制过去，否则新项目名等于挂上一个空库：

```bash
docker volume create kaimi_kaimi_data
docker run --rm -v deploy_kaimi_data:/from -v kaimi_kaimi_data:/to alpine sh -c 'cp -a /from/. /to/'
KAIMI_COMPOSE_PROJECT=kaimi ./deploy/up.sh up -d
```

`KAIMI_ADMIN_USER` / `KAIMI_ADMIN_PASSWORD` 只在库里一个管理员都没有时才生效。已经有管理员了，改 `.env` 不会改密码，要在后台改。反过来说，如果部署时报「首次生产部署必须配置至少 12 位的 KAIMI_ADMIN_PASSWORD」，说明这个库是空的——如果你预期它有数据，先用 `docker volume ls | grep kaimi` 确认是不是挂错了卷。

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
