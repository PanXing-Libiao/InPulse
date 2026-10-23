# syntax=docker/dockerfile:1
#
# 生产 Web 镜像（技术设计 v1.2.2 §11.1）。
# builder 执行 Vite 生产构建；runtime 使用 nginx-unprivileged（固定 1.30.4 digest），
# 监听 8080/8443，静态托管 dist 并将 API/健康检查反向代理到 `api` 服务。
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

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @inpulse/web build

FROM nginxinc/nginx-unprivileged:1.30.4@sha256:cb92301e719d6639028de775fe8b28e15f58343aca5e5372001311958aafb300 AS runtime

# nginx-unprivileged 镜像默认已以 UID/GID 101 启动。只有 root 才能写
# /var/lib/apt/lists/partial，因此安装 curl 前临时切回 root，装完再恢复非 root。
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Debian 会持续为系统包发布安全更新，而 digest 固定的基础镜像不会因此立即重建；
# 不刷新就会被新公告卡住 Trivy 镜像门禁（实测 perl-base 的 CRITICAL 与 gzip、
# libpcre2-8-0、libsqlite3-0、libssh2-1t64 的 HIGH 使扫描失败；2026-10-08 又新增
# libheif 的 CVE-2026-84450/CVE-2026-84451 与 openssl 的 CVE-2026-75804/
# CVE-2026-84782 共 12 个 HIGH；2026-10-21 又新增 libexpat1 的 5 个 HIGH）。这里逐个点名
# 升级而不用整体 upgrade，以保证 nginx 仍停在 1.30.x 评审基线；`--only-upgrade`
# 只升级已安装的包：未安装的包跳过、已是最新的包不动，不安装新包、不删除任何包。
# 项目只使用标准静态托管和反向代理；GeoIP、image-filter、njs、xslt 动态模块
# 未被 nginx.conf 加载，却会带入 libxml2、libtiff、libx11 等额外攻击面，故移除。
RUN apt-get update \
 && apt-get install -y --only-upgrade \
      gzip libexpat1 libpcre2-8-0 libsqlite3-0 libssh2-1t64 \
      perl perl-base libperl5.40 perl-modules-5.40 \
      libheif1 libheif-plugin-dav1d libheif-plugin-libde265 \
      libssl3t64 openssl openssl-provider-legacy libexpat1 \
 && apt-get purge -y \
      nginx-module-geoip nginx-module-image-filter nginx-module-njs nginx-module-xslt \
 && apt-get autoremove -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/docker/nginx-security-headers.conf /etc/nginx/snippets/inpulse-security-headers.conf
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html

USER 101:101
EXPOSE 8080 8443
