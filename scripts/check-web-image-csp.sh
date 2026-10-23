#!/usr/bin/env bash
# 生产 Web 镜像的逐响应 nonce CSP 与安全响应头冒烟验证（技术设计 v1.2.2 §7.5 / ADR-021）。
#
# 用法：
#   bash scripts/check-web-image-csp.sh [image]     # 默认 inpulse/web:ci
#
# 前置：docker 与 openssl。容器以 `--add-host api:127.0.0.1` 启动（Nginx 启动时
# 需要能解析上游名，API 连接失败不影响静态入口验证），TLS 证书用临时自签名证书
# 挂载到 /run/secrets（与生产 compose 相同的路径）。
#
# Windows Git Bash 本地运行时设置 `MSYS_NO_PATHCONV=1`（脚本内部用 cygpath 转换
# 宿主机路径，容器内路径必须保持原样，CI 的 Linux bash 不受影响）。
#
# 验证内容（针对真实构建出的镜像与真实 Nginx 配置）：
#   1. HTTP 对非 ACME 请求返回 308 到同主机 HTTPS；
#   2. 每个 HTML 响应生成新的 128 bit nonce，CSP 头与入口 meta/script 标签一致；
#   3. script-src / style-src 均无 unsafe-inline；
#   4. /api/v1 与健康检查的响应保留安全头与 no-store（不被 location 层 add_header 覆盖丢失）；
#   5. 客户端路由与 /index.html 走同一入口；哈希静态资源 immutable；
#   6. 条件请求不会得到带旧 nonce 的 304。
set -euo pipefail

# Git Bash 会把 `/CN=...`、容器内绝对路径等参数当宿主机路径做自动转换；这里统一
# 关闭自动转换，脚本内部对需要交给原生程序（docker/openssl/curl）的宿主机路径
# 显式使用 cygpath 转换。Linux 上这两个变量无副作用。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

IMAGE="${1:-inpulse/web:ci}"
PUBLIC_HOST="${WEB_CSP_PUBLIC_HOST:-test-inpulse.libiaorobot.com}"
HTTP_PORT="${WEB_CSP_HTTP_PORT:-18080}"
HTTPS_PORT="${WEB_CSP_HTTPS_PORT:-18443}"
CONTAINER="inpulse-web-csp-$$"

workdir="$(mktemp -d)"
nworkdir=""   # 原生路径副本（docker/openssl/curl 需要，见 to_native_path）
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$workdir" "$nworkdir"
}
trap cleanup EXIT

fail() {
  echo "[check-web-csp] ERROR: $*" >&2
  docker logs "$CONTAINER" 2>&1 | tail -n 40 >&2 || true
  exit 1
}

header() { # header <name> <header-file>
  grep -i "^$1:" "$2" | head -n 1 | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/\r$//'
}

to_native_path() { # Git Bash 下把 MSYS 路径转换为 Windows 原生路径，供 docker/openssl 使用
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

status_of() { # status_of <header-file>
  head -n 1 "$1" | tr -d '\r' | awk '{print $2}'
}

nonce_of() { # nonce_of <csp-policy>
  printf '%s' "$1" | sed -n "s/.*script-src 'self' 'nonce-\([0-9a-f]\{32\}\)'.*/\1/p"
}

expect_nonce() { # expect_nonce <headers> <body> <label>
  local csp nonce meta
  csp="$(header content-security-policy "$1")"
  nonce="$(nonce_of "$csp")"
  [ -n "$nonce" ] || fail "$3: script-src nonce (32 hex) missing in CSP: $csp"
  case "$csp" in
    *unsafe-inline*) fail "$3: CSP must not contain unsafe-inline" ;;
  esac
  case "$csp" in
    *"style-src 'self' 'nonce-$nonce'"*) ;;
    *) fail "$3: style-src must use the same nonce" ;;
  esac
  meta="$(grep -o 'property="csp-nonce" nonce="[^"]*"' "$2" | head -n 1 | sed 's/.*nonce="\([^"]*\)"/\1/')"
  [ "$meta" = "$nonce" ] || fail "$3: bootstrap meta nonce ($meta) must match CSP nonce ($nonce)"
  grep -q "nonce=\"$nonce\"" "$2" || fail "$3: script/style tags must carry the response nonce"
  if grep -q "__INPULSE_CSP_NONCE__" "$2"; then
    fail "$3: nonce placeholder must be fully replaced"
  fi
  printf '%s' "$nonce"
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"

# docker/openssl/curl 都是原生程序：Git Bash 下把工作目录转成 Windows 原生路径，
# 并让响应体统一写入临时文件（不用 /dev/null）。Linux 上为恒等转换。
nworkdir="$(to_native_path "$workdir")"
nh() { to_native_path "$workdir/$1"; }   # 供 curl -o/-D 使用的原生输出路径
scratch="$nworkdir/scratch/body"   # 可丢弃的响应体文件（不能用 /dev/null 或目录）
mkdir -p "$workdir/scratch"
printf '%s\n' 'inpulse-acme-probe' > "$workdir/acme-token"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -keyout "$(nh tls_key)" \
  -out "$(nh tls_cert)" \
  -subj "/CN=inpulse-web-csp-check" >/dev/null 2>&1 \
  || fail "openssl failed to generate the temporary self-signed certificate"
# 临时自签名私钥只服务本次冒烟：容器内 Nginx 以非 root（uid 101）运行，必须让
# 挂载后的密钥可被该用户读取；这里显式放宽到 644 并只挂载到本地临时目录。
chmod 644 "$workdir/tls_cert" "$workdir/tls_key"

docker run -d --name "$CONTAINER" \
  --add-host api:127.0.0.1 \
  -p "127.0.0.1:${HTTP_PORT}:8080" \
  -p "127.0.0.1:${HTTPS_PORT}:8443" \
  -v "$(nh tls_cert):/run/secrets/tls_cert:ro" \
  -v "$(nh tls_key):/run/secrets/tls_key:ro" \
  -v "$(nh acme-token):/usr/share/nginx/html/.well-known/acme-challenge/probe:ro" \
  "$IMAGE" >/dev/null

https="https://127.0.0.1:${HTTPS_PORT}"
http="http://127.0.0.1:${HTTP_PORT}"

site_curl() {
  curl -H "Host: $PUBLIC_HOST" "$@"
}

ready=0
for _ in $(seq 1 30); do
  if site_curl -fsSk -o "$scratch" -H 'Accept: text/html' "$https/"; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail "web image did not become ready on $https"

# 1. HTTP 入口 308 跳转到白名单内主机的 HTTPS；恶意 Host 不得进入 Location。
site_curl -sS -o "$scratch" -D "$(nh http_headers)" "$http/login" || true
[ "$(status_of "$workdir/http_headers")" = "308" ] || fail "HTTP entry must return 308, got $(status_of "$workdir/http_headers")"
grep -qi "^Location: https://${PUBLIC_HOST}/login" "$workdir/http_headers" || fail "HTTP entry must redirect to the canonical HTTPS host"
curl -sS -o "$scratch" -D "$(nh http_bad_host_headers)" -H 'Host: evil.example' "$http/login" || true
[ "$(status_of "$workdir/http_bad_host_headers")" = "421" ] || fail "HTTP entry must reject an untrusted Host with 421"
if grep -qi "^Location:" "$workdir/http_bad_host_headers"; then
  fail "an untrusted Host must not produce a redirect Location"
fi

# ACME challenge 不受隐藏文件规则影响。
site_curl -fsSk -D "$(nh acme_headers)" -o "$(nh acme_body)" "$https/.well-known/acme-challenge/probe"
[ "$(status_of "$workdir/acme_headers")" = "200" ] || fail "ACME challenge must remain reachable"

# 2. 入口 HTML：逐响应 nonce + 安全头 + no-store。
site_curl -fsSk -D "$(nh h1)" -o "$(nh body1)" -H 'Accept: text/html' "$https/"
[ "$(status_of "$workdir/h1")" = "200" ] || fail "entry HTML must return 200"
nonce1="$(expect_nonce "$workdir/h1" "$workdir/body1" "entry HTML")"
[ "$(header cache-control "$workdir/h1")" = "no-store" ] || fail "entry HTML must be no-store"
[ "$(header x-content-type-options "$workdir/h1")" = "nosniff" ] || fail "entry HTML must set X-Content-Type-Options"
[ "$(header x-frame-options "$workdir/h1")" = "DENY" ] || fail "entry HTML must set X-Frame-Options"
[ "$(header referrer-policy "$workdir/h1")" = "no-referrer" ] || fail "entry HTML must set Referrer-Policy"
header permissions-policy "$workdir/h1" | grep -q "camera=()" || fail "entry HTML must set Permissions-Policy"
header strict-transport-security "$workdir/h1" | grep -q "max-age=31536000" || fail "entry HTML must set HSTS"

# 3. 下一条响应必须换新 nonce，且不跨响应复用。
site_curl -fsSk -D "$(nh h2)" -o "$(nh body2)" -H 'Accept: text/html' "$https/"
nonce2="$(expect_nonce "$workdir/h2" "$workdir/body2" "second entry HTML")"
[ "$nonce1" != "$nonce2" ] || fail "nonce must not be reused across responses"

# 4. 客户端路由回退到同一入口位置（try_files -> /index.html）。
site_curl -fsSk -D "$(nh h3)" -o "$(nh body3)" -H 'Accept: text/html' "$https/projects/1/activity?tab=all"
[ "$(status_of "$workdir/h3")" = "200" ] || fail "SPA fallback must return 200"
expect_nonce "$workdir/h3" "$workdir/body3" "SPA fallback" >/dev/null
[ "$(header cache-control "$workdir/h3")" = "no-store" ] || fail "SPA fallback must be no-store"
[ "$(header x-content-type-options "$workdir/h3")" = "nosniff" ] || fail "SPA fallback must keep security headers"

# 5. 条件请求不能返回复用旧 nonce 的 304。
site_curl -fsSk -D "$(nh h4)" -o "$scratch" -H 'Accept: text/html' \
  -H "If-None-Match: \"$(header etag "$workdir/h1")\"" \
  -H "If-Modified-Since: $(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')" \
  "$https/"
[ "$(status_of "$workdir/h4")" = "200" ] || fail "conditional request must return 200, got $(status_of "$workdir/h4")"

# 6. 代理路径保留安全头与 no-store（API 未启动时为 502，仍必须带头）。
site_curl -sSk -D "$(nh h5)" -o "$scratch" "$https/api/v1/health/live" || true
[ "$(status_of "$workdir/h5")" = "502" ] || fail "API upstream is expected to be unreachable in this check"
[ "$(header x-content-type-options "$workdir/h5")" = "nosniff" ] || fail "proxied API response must keep security headers"
[ "$(header cache-control "$workdir/h5")" = "no-store" ] || fail "proxied API response must be no-store"
[ "$(header x-frame-options "$workdir/h5")" = "DENY" ] || fail "proxied API response must keep X-Frame-Options"

# 7. HTTPS 同样拒绝未知 Host、隐藏版本号并阻断敏感路径。
curl -sSk -D "$(nh h_bad_host)" -o "$scratch" -H 'Host: evil.example' "$https/" || true
[ "$(status_of "$workdir/h_bad_host")" = "421" ] || fail "HTTPS entry must reject an untrusted Host with 421"
server_header="$(header server "$workdir/h1")"
case "$server_header" in
  nginx|"") ;;
  */*) fail "Server header must not expose the nginx version: $server_header" ;;
  *) fail "unexpected Server header: $server_header" ;;
esac
for sensitive_path in /.git/config /.env /compose.yaml /secrets/ /api/openapi.json /robots.txt; do
  site_curl -sSk -D "$(nh h_sensitive)" -o "$scratch" "$https$sensitive_path" || true
  [ "$(status_of "$workdir/h_sensitive")" = "404" ] || fail "$sensitive_path must return 404, got $(status_of "$workdir/h_sensitive")"
  [ "$(header x-content-type-options "$workdir/h_sensitive")" = "nosniff" ] || fail "$sensitive_path 404 must keep security headers"
done

# 8. 哈希静态资源 immutable。
asset_path="$(grep -o '/assets/[^"]*\.js' "$workdir/body1" | head -n 1)"
[ -n "$asset_path" ] || fail "hashed asset path missing in entry HTML"
site_curl -fsSk -D "$(nh h6)" -o "$scratch" "$https$asset_path"
[ "$(status_of "$workdir/h6")" = "200" ] || fail "hashed asset must return 200"
header cache-control "$workdir/h6" | grep -q "immutable" || fail "hashed asset must be immutable"

echo "[check-web-csp] OK: per-response nonce CSP, security headers, no-store and immutable assets verified on $IMAGE"
