/**
 * 本地开发（明文 HTTP + 127.0.0.1）专用降级：浏览器会丢弃带 Secure 的
 * __Host- Cookie，导致 SSO state 与 Session 无法保存。仅在显式设置
 * INPULSE_DEV_INSECURE_COOKIES=1 且非生产环境时启用；生产始终使用
 * __Host- + Secure。
 */
const insecureDevCookies =
  process.env["INPULSE_DEV_INSECURE_COOKIES"] === "1" &&
  process.env["NODE_ENV"] !== "production";

const COOKIE_NAME_PREFIX = insecureDevCookies ? "inpulse-dev-" : "__Host-";

export const PREAUTH_COOKIE_NAME = COOKIE_NAME_PREFIX + "preauth";
export const SESSION_COOKIE_NAME = COOKIE_NAME_PREFIX + "session";
/** ADR-032：SSO state 与发起浏览器的绑定 Cookie，只存一次性 state 明文。 */
export const SSO_STATE_COOKIE_NAME = COOKIE_NAME_PREFIX + "sso-state";
export const PREAUTH_MAX_AGE_SECONDS = 9 * 60;
export const AUTH_CSRF_MAX_AGE_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_MAX_AGE_SECONDS = 8 * 60 * 60;
export const SESSION_ABSOLUTE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_AUTH_CSRF_TOKENS = 4;

export type HeaderValue = string | readonly string[] | undefined;
export type HttpHeaderBag = Readonly<Record<string, HeaderValue>>;

export interface CsrfRequestHeaders {
  readonly origin: string | undefined;
  readonly referer: string | undefined;
  readonly host: string | undefined;
  readonly secFetchSite: string | undefined;
  readonly secFetchMode: string | undefined;
  readonly secFetchDest: string | undefined;
}

export interface CsrfRequestInput {
  readonly cookieHeader: string | undefined;
}

export interface CsrfSetCookie {
  readonly name: string;
  readonly value: string | null;
  readonly maxAgeSeconds?: number;
}

export type SameOriginFailure =
  | "missing-host"
  | "missing-origin-and-referer"
  | "cross-origin"
  | "cross-site"
  | "unsupported-sec-fetch-mode"
  | "unsupported-sec-fetch-dest";

export function getHeader(
  headers: HttpHeaderBag,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

export function parseCookieHeader(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === name) {
      return value.length === 0 ? undefined : value;
    }
  }
  return undefined;
}

/**
 * 构造带安全属性的 Cookie。匿名预认证使用 `__Host-preauth`；
 * 认证 Session 使用 `__Host-session`，两者都禁止 Domain 与 JS 读取。
 */
export function buildCookie(cookie: CsrfSetCookie): string {
  const value = cookie.value ?? "";
  const maxAge = cookie.value === null ? 0 : cookie.maxAgeSeconds;
  const segments = [
    `${cookie.name}=${value}`,
    "HttpOnly",
    ...(insecureDevCookies ? [] : ["Secure"]),
    "SameSite=Lax",
    "Path=/",
  ];
  if (maxAge !== undefined) {
    segments.push(`Max-Age=${maxAge}`);
  }
  return segments.join("; ");
}

function requestHeaders(headers: HttpHeaderBag): CsrfRequestHeaders {
  return {
    origin: getHeader(headers, "origin"),
    referer: getHeader(headers, "referer"),
    host: getHeader(headers, "host"),
    secFetchSite: getHeader(headers, "sec-fetch-site"),
    secFetchMode: getHeader(headers, "sec-fetch-mode"),
    secFetchDest: getHeader(headers, "sec-fetch-dest"),
  };
}

function parseExternalUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * GET /auth/csrf 的同源与 Fetch Metadata 纵深防御：
 * Origin/Referer 存在时精确校验，缺失本身不拒绝；
 * Fetch Metadata 存在时必须属于安全方法允许的取值。
 */
export function sameOriginValidationError(
  headers: HttpHeaderBag,
): SameOriginFailure | undefined {
  const request = requestHeaders(headers);
  const candidate = request.origin ?? request.referer;
  if (candidate !== undefined) {
    if (!request.host) {
      return "missing-host";
    }
    const scheme =
      getHeader(headers, "x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
    const expected = `${scheme}://${request.host}`;
    const parsed = parseExternalUrl(candidate);
    if (!parsed || parsed.origin !== expected) {
      return "cross-origin";
    }
  }

  if (
    request.secFetchSite !== undefined &&
    request.secFetchSite !== "same-origin" &&
    request.secFetchSite !== "none"
  ) {
    return "cross-site";
  }
  if (
    request.secFetchMode !== undefined &&
    request.secFetchMode !== "cors" &&
    request.secFetchMode !== "navigate"
  ) {
    return "unsupported-sec-fetch-mode";
  }
  if (
    request.secFetchDest !== undefined &&
    request.secFetchDest !== "empty" &&
    request.secFetchDest !== "document"
  ) {
    return "unsupported-sec-fetch-dest";
  }
  return undefined;
}

/**
 * 非安全请求的同源校验：外部可见 Origin/Referer 至少存在一个，优先 Origin，
 * 其余逻辑与 GET CSRF 签发一致。该函数用于登录等写操作。
 */
export function mutationSameOriginValidationError(
  headers: HttpHeaderBag,
): SameOriginFailure | undefined {
  const origin = getHeader(headers, "origin");
  const referer = getHeader(headers, "referer");
  if (
    (origin?.trim().length ?? 0) === 0 &&
    (referer?.trim().length ?? 0) === 0
  ) {
    return "missing-origin-and-referer";
  }
  return sameOriginValidationError(headers);
}
