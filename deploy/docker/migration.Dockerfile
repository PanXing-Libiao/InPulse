# syntax=docker/dockerfile:1
#
# 生产 migration/ops 镜像（技术设计 v1.2.2 §11.1）。
# 与 API 同 commit 构建，runtime 仅保留迁移所需生产依赖并运行编译后的迁移入口。
# 迁移 SQL 被复制到 `dist/migrations`，与编译后 `dist/src/migrate.js` 的
# `../migrations` 相对路径一致，因而无需在运行时保留 tsx。
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS builder
WORKDIR /workspace

ENV CI=true
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY}
RUN corepack enable

# 与 API 镜像同构：依赖清单先复制，安装层不随源码变化失效；新增 workspace 包时
# 必须同步补充这里的 manifest 行。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY database/package.json database/
COPY apps/api/package.json apps/api/
COPY apps/e2e/package.json apps/e2e/
COPY apps/web/package.json apps/web/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/eslint-config/package.json packages/eslint-config/

RUN pnpm install --frozen-lockfile --registry "$COREPACK_NPM_REGISTRY"

COPY . .

# `--config.node-linker=hoisted`：默认（isolated）的 legacy deploy 会把 workspace
# 包以符号链接指向 /workspace，runtime 阶段不存在该目录，镜像内模块解析会失败；
# hoisted 布局把全部依赖（含 workspace 包）复制进 /out，运行树完全自包含。
RUN pnpm --filter @inpulse/database build \
 && pnpm deploy --legacy --filter @inpulse/database --prod --config.node-linker=hoisted /out

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /out/package.json ./package.json
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/migrations ./dist/migrations

# 官方 Node 镜像自带 npm/corepack，Trivy 会在 runtime 中报告其全局工具链漏洞；
# Migration 只运行编译后的 Node 入口，不需要任何包管理器，因此从运行时删除。
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Debian 会持续为系统包发布安全更新，而 digest 固定的官方 Node 镜像不会因此
# 立即重建；不刷新就会被新公告卡住 Trivy 镜像门禁（实测 libpcre2-8-0 的两个
# HIGH 使 CI 失败）。此镜像只带 Node，没有需要按版本确认的服务器二进制，因此
# 直接升级全部已安装的包；`upgrade`（不是 dist-upgrade）只升级已安装的包，
# 不安装新包、不删除任何包。
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && chown -R 10001:10001 /app

USER 10001:10001
CMD ["node", "dist/src/migrate.js"]
