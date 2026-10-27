/**
 * ADR-032 / ADR-080 单点登录前端入口。
 *
 * start/callback 两条路由在服务端只做 302 浏览器跳转、不返回 JSON 响应体，
 * 因此不参与生成客户端；这里只负责拼装同源跳转地址，
 * 组件仍不得直接使用 fetch 或 axios 调用后端。
 */
export const SSO_START_PATH = "/api/v1/auth/sso/start";

export function buildSsoStartUrl(returnTo: string): string {
  // 查询参数名必须与契约 SsoStartQueryRequest 的字段名完全一致（strict schema）。
  const params = new URLSearchParams({ returnTo });
  return `${SSO_START_PATH}?${params.toString()}`;
}

export const SSO_GENERIC_ERROR_MESSAGE =
  "登录失败，请重新登录；若持续失败请联系系统管理员。";

const SSO_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "idp-error":
    "统一身份认证返回了错误，请重新登录；若持续失败请联系系统管理员。",
  "issuer-mismatch":
    "统一身份认证响应与配置的签发者不一致，请联系系统管理员核查配置。",
  "state-invalid": "登录请求校验未通过，请重新登录。",
  "state-mismatch": "登录请求与当前浏览器不匹配，请重新登录。",
  "state-expired": "登录请求已超时，请重新登录。",
  "state-consumed": "该登录请求已被使用，请重新登录。",
  "missing-code": "统一身份认证没有返回授权码，请重新登录。",
  "token-exchange-failed":
    "无法完成身份令牌交换，请重新登录；若持续失败请联系系统管理员。",
  "token-invalid":
    "身份令牌校验未通过，请重新登录；若持续失败请联系系统管理员。",
  "group-metadata-failed":
    "无法读取统一身份认证的群组类型，请重新登录；若持续失败请联系系统管理员。",
  "account-conflict": "该统一身份账号与现有账号冲突，请联系系统管理员处理。",
  "account-disabled": "账号已停用，请联系系统管理员。",
  "account-unavailable": "账号当前不可用，请联系系统管理员。",
  "rate-limited": "登录尝试过于频繁，请稍后重试。",
  internal: "服务器暂时无法完成登录，请稍后重试。",
};

/**
 * 把回调带回的 sso_error 分类映射为固定文案；未识别的取值只返回通用提示，
 * 不回显任何服务端原文，避免把不可信输入带进页面。
 */
export function describeSsoError(
  reason: string | null | undefined,
): string | null {
  if (reason === null || reason === undefined || reason.trim().length === 0) {
    return null;
  }
  return SSO_ERROR_MESSAGES[reason] ?? SSO_GENERIC_ERROR_MESSAGE;
}

/**
 * 同源整页跳转进入单点登录入口（浏览器导航，不是 XHR）：
 * 服务端 302 到统一身份认证，或在 SSO 未启用时回落到本地隐藏入口。
 */
export function navigateToSsoStart(returnTo: string): void {
  window.location.replace(buildSsoStartUrl(returnTo));
}
