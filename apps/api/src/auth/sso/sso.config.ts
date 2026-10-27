import { readFileSync } from "node:fs";

/** NestJS DI token：SSO 接入配置（仅 SSO_ENABLED 时才注册）。 */
export const SSO_CONFIG = Symbol("SSO_CONFIG");

/** NestJS DI token：已就绪的 OIDC 客户端。 */
export const SSO_OIDC_CLIENT = Symbol("SSO_OIDC_CLIENT");

/** 立镖 Casdoor OIDC 接入配置（ADR-032）。 */
export interface SsoConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUrl: string;
  readonly stateTtlSeconds: number;
  readonly discoveryTtlSeconds: number;
  readonly requestTimeoutMs: number;
  /** Casdoor 目录导入使用的组织 owner；未配置时仅关闭主动导入。 */
  readonly importOrganization?: string | undefined;
}

export interface SsoConfigLoadResult {
  readonly config: SsoConfig | undefined;
  /** 已启用但配置非法时的分类原因；只用于启动日志，不含任何 Secret。 */
  readonly invalidReason: string | undefined;
}

/** 一次性登录材料有效期上限必须与数据库 CHECK 一致（15 分钟）。 */
export const SSO_STATE_TTL_SECONDS = 10 * 60;
const SSO_DISCOVERY_TTL_SECONDS = 10 * 60;
const SSO_REQUEST_TIMEOUT_MS = 10_000;

export function ssoEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env["SSO_ENABLED"]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * 读取 SSO 配置。未设置 `SSO_ENABLED` 时视为关闭（本地与 CI 默认）；
 * 已启用但缺少 issuer/client id/Secret 文件、Secret 为空或不可读、重定向
 * 地址非法时返回 invalid 原因并 fail closed：SSO 不可用，回落本地隐藏入口，
 * 绝不接受明文 Secret 环境变量兜底。
 */
export function loadSsoConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SsoConfigLoadResult {
  if (!ssoEnabled(env)) {
    return { config: undefined, invalidReason: undefined };
  }
  try {
    const issuer = normalizeIssuer(env["SSO_ISSUER"]);
    const clientId = required(env, "SSO_CLIENT_ID");
    const clientSecret = readClientSecret(env);
    const redirectUrl = normalizeRedirectUrl(env["SSO_REDIRECT_URI"]);
    return {
      config: {
        issuer,
        clientId,
        clientSecret,
        redirectUrl,
        stateTtlSeconds: SSO_STATE_TTL_SECONDS,
        discoveryTtlSeconds: SSO_DISCOVERY_TTL_SECONDS,
        requestTimeoutMs: SSO_REQUEST_TIMEOUT_MS,
        importOrganization: optionalImportOrganization(
          env["CASDOOR_IMPORT_ORGANIZATION"],
        ),
      },
      invalidReason: undefined,
    };
  } catch (error) {
    return {
      config: undefined,
      invalidReason: error instanceof Error ? error.message : "invalid",
    };
  }
}

function required(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when SSO is enabled`);
  }
  return value;
}

function optionalImportOrganization(
  raw: string | undefined,
): string | undefined {
  const value = raw?.trim() ?? "";
  if (value.length === 0) return undefined;
  if (value.length > 100 || value.includes("/") || value !== value.trim()) {
    throw new Error(
      "CASDOOR_IMPORT_ORGANIZATION must be a single Casdoor organization owner",
    );
  }
  return value;
}

function normalizeIssuer(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, "") ?? "";
  if (value.length === 0) {
    throw new Error("SSO_ISSUER is required when SSO is enabled");
  }
  const parsed = parseUrl(value);
  if (parsed === undefined || parsed.protocol !== "https:") {
    throw new Error("SSO_ISSUER must be an absolute https URL");
  }
  return value;
}

/**
 * 回调地址沿用 OIDC 的 `redirect_uri` 术语命名为 `SSO_REDIRECT_URI`：它是公开
 * 地址而非 Secret；`scripts/check_secrets.mjs` 把所有 `*_URL` 键视为必须指向
 * `/run/secrets/*` 的敏感变量，改名可避免该误判而不放宽门禁本身。
 */
function normalizeRedirectUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  const parsed = parseUrl(value);
  if (
    parsed === undefined ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !parsed.pathname.endsWith("/api/v1/auth/sso/callback")
  ) {
    throw new Error(
      "SSO_REDIRECT_URI must be an absolute URL ending with /api/v1/auth/sso/callback",
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("SSO_REDIRECT_URI must not contain query or fragment");
  }
  return value;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * 读取 Client Secret 文件。生产只接受 `/run/secrets/` 直接子路径；
 * 本地/集成测试必须显式设置 `NODE_ENV=test` 与 `SSO_CLIENT_SECRET_TEST_PATH=1`
 * 才允许临时路径；其余情况一律 fail closed。
 */
export function readClientSecret(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const path = required(env, "SSO_CLIENT_SECRET_FILE");
  const allowTestPath =
    env["NODE_ENV"] === "test" && env["SSO_CLIENT_SECRET_TEST_PATH"] === "1";
  if (!allowTestPath && !path.startsWith("/run/secrets/")) {
    throw new Error("SSO_CLIENT_SECRET_FILE must be under /run/secrets/");
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error("SSO_CLIENT_SECRET_FILE is not readable");
  }
  if (content.length === 0) {
    throw new Error("SSO_CLIENT_SECRET_FILE is empty");
  }
  return content;
}
