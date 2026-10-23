# syntax=docker/dockerfile:1
#
# 生产 PostgreSQL 18.6 bootstrap 镜像（技术设计 v1.2.2 §11.1 / §11.2.1）。
# 基于官方 postgres:18.6 digest 构建，安装评审基线 PGroonga 相关包（版本与
# keyring SHA 固定），并把经评审的角色/bootstrap SQL 放入
# `/docker-entrypoint-initdb.d/`。镜像内不包含任何密码；010_passwords.sql 在
# 首建库时从 `/run/secrets/*` 读取。
FROM postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280

# 安装阶段只取必要依赖；wget 仅用于校验 keyring，gnupg 也不是数据库运行时所需，
# 安装完成后移除，避免把仅构建期工具带入长期运行镜像。
ARG GROONGA_KEYRING_SHA256=91677bc2f9f454ef6ddfc6afe40764e470e60d8a6b1921661fd32ae5228537c8
ARG PGROONGA_DEBIAN_VERSION=4.0.8-1
ARG LIBGROONGA_DEBIAN_VERSION=16.1.0-1

# Debian 会持续为系统包发布安全更新，而 digest 固定的 postgres 镜像不会因此
# 立即重建；不刷新就会被新公告卡住 Trivy 镜像门禁（实测 perl 的 CRITICAL 与
# gzip、libpcre2-8-0、libsqlite3-0 的 HIGH 使扫描失败；2026-10-21 又新增
# libcurl4t64 的 3 个 HIGH）。此处逐个点名升级而
# 不做整体 upgrade：官方 postgres 镜像已配置 PGDG 源，整体 upgrade 会在 PGDG
# 发布新补丁时把 PostgreSQL 18.6 基线悄悄带走。`--only-upgrade` 只升级已安装
# 的包：未安装的包跳过、已是最新的包不动，不安装新包、不删除任何包。
RUN apt-get update \
 && apt-get install -y --only-upgrade libssl3t64 openssl openssl-provider-legacy \
 && apt-get install -y --only-upgrade \
      gzip libpcre2-8-0 libsqlite3-0 libssh2-1t64 \
      perl perl-base libperl5.40 perl-modules-5.40 \
 && apt-get install -y --no-install-recommends -V ca-certificates lsb-release wget postgresql-common \
 && wget -q -O /usr/share/keyrings/groonga-archive-keyring.asc https://packages.groonga.org/debian/groonga-archive-keyring.asc \
 && echo "${GROONGA_KEYRING_SHA256}  /usr/share/keyrings/groonga-archive-keyring.asc" | sha256sum -c - \
 && printf '%s\n' \
      'Types: deb deb-src' \
      'URIs: https://packages.groonga.org/debian/' \
      'Suites: trixie' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/groonga-archive-keyring.asc' \
    > /etc/apt/sources.list.d/groonga.sources \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get update \
 && apt-get install -y --no-install-recommends -V \
      postgresql-18-pgdg-pgroonga=${PGROONGA_DEBIAN_VERSION} \
      libgroonga0=${LIBGROONGA_DEBIAN_VERSION} \
 && apt-get install -y --only-upgrade libcurl4t64 \
 && apt-get purge -y gnupg wget \
 && apt-get autoremove -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/local/bin/gosu

COPY database/bootstrap/000_roles.sql /docker-entrypoint-initdb.d/000_roles.sql
COPY database/bootstrap/010_passwords.sql /docker-entrypoint-initdb.d/010_passwords.sql
COPY database/bootstrap/020_pgroonga.sql /docker-entrypoint-initdb.d/020_pgroonga.sql
