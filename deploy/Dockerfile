FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/upstream/package.json packages/upstream/
COPY packages/themes/package.json packages/themes/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @kaimi/web build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/packages ./packages
# 数据卷 kaimi_data 挂在 /app/apps/web/data；新卷会继承这里的属主
RUN mkdir -p /app/apps/web/data && chown -R node:node /app/apps/web/data
USER node
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
