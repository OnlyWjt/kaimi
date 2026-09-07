#!/usr/bin/env sh
# 部署入口。存在的唯一理由：docker 网桥地址每台机器都不一样，写死过一次，绑到本机不存在
# 的地址上容器直接起不来，网关跟着回 502。这里现算，不让人去猜。
#
# 应用只绑在网桥地址上：宿主机和其他容器（1Panel 的 OpenResty、现成的 nginx）连得进来，
# 公网连不进来。这很重要——直连应用端口的请求可以随便伪造 X-Forwarded-For，按 IP 的限流
# 会形同虚设。
#
# 用法和 docker compose 一样，参数原样透传：
#   ./deploy/up.sh up -d --build
#   ./deploy/up.sh ps
#   ./deploy/up.sh logs -f kaimi
#
# 可选环境变量：
#   KAIMI_BIND_ADDR          手动指定绑定地址，跳过自动探测
#   KAIMI_COMPOSE_PROJECT    compose 项目名，默认 deploy。改它会换掉数据卷名字，
#                            换之前先按 README 把卷复制过去，否则等于开了一个空库。
set -eu

cd "$(dirname "$0")/.."

if [ -z "${KAIMI_BIND_ADDR:-}" ]; then
  KAIMI_BIND_ADDR=$(
    docker network inspect bridge \
      --format '{{ with index .IPAM.Config 0 }}{{ .Gateway }}{{ end }}' 2>/dev/null || true
  )
fi

if [ -z "${KAIMI_BIND_ADDR:-}" ]; then
  echo "探测不到 docker 网桥地址。用 ip -4 addr show docker0 查出来，再 KAIMI_BIND_ADDR=x.x.x.x $0 $* 重跑。" >&2
  exit 1
fi

echo "应用绑定 ${KAIMI_BIND_ADDR}:3100 —— 反向代理请填 http://${KAIMI_BIND_ADDR}:3100"

KAIMI_BIND_ADDR="${KAIMI_BIND_ADDR}" exec docker compose \
  -p "${KAIMI_COMPOSE_PROJECT:-deploy}" \
  -f deploy/docker-compose.yml \
  "$@"
