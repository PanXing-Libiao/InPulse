/** SSO 登录失败分类；作为 `sso_error` 回跳参数与审计 payload 使用。 */
export type SsoLoginReason =
  | "idp-error"
  | "issuer-mismatch"
  | "state-invalid"
  | "state-mismatch"
  | "state-expired"
  | "state-consumed"
  | "missing-code"
  | "token-exchange-failed"
  | "token-invalid"
  | "group-metadata-failed"
  | "account-conflict"
  | "account-disabled"
  | "account-unavailable"
  | "rate-limited"
  | "internal";

/** 只携带分类与内部原因，绝不携带 state、code、token 或 Secret。 */
export class SsoLoginError extends Error {
  readonly reason: SsoLoginReason;

  constructor(reason: SsoLoginReason, cause?: unknown) {
    super(`SSO login failure: ${reason}`);
    this.name = "SsoLoginError";
    this.reason = reason;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
