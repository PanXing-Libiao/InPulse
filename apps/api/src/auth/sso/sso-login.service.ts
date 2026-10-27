import { createHash, createHmac } from "node:crypto";

import { AuditWritePort } from "../../audit/audit.port.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import { LoginRateLimitService } from "../auth-rate-limit.service.js";
import { LoginError } from "../login.error.js";
import type { VersionedHmacKeyring } from "../keyring.js";
import { PostgresUserCredentialRepository } from "../user-credential.repository.js";
import { PostgresUserSessionRepository } from "../user-session.repository.js";
import {
  issueAuthenticatedSession,
  type IssuedAuthenticatedSession,
} from "../session-issue.js";
import { PostgresSessionCsrfTokenRepository } from "../session-csrf-token.repository.js";
import { SessionTokenService } from "../session-token.service.js";
import type { SessionTtlPolicy } from "../session-ttl.policy.js";
import {
  generateOpaqueToken,
  constantTimeEqual,
  isValidOpaqueToken,
} from "../token.js";
import {
  SESSION_COOKIE_NAME,
  SSO_STATE_COOKIE_NAME,
  parseCookieHeader,
  type CsrfSetCookie,
} from "../csrf.http.js";
import {
  InvalidCasdoorGroupPathError,
  normalizeCasdoorGroupPaths,
} from "../../organizations/casdoor-group-path.js";
import type {
  OrganizationSyncPort,
  SsoOrganizationSyncResult,
} from "../../organizations/organization-sync.port.js";
import { PostgresSsoLoginAttemptRepository } from "./sso-login-attempt.repository.js";
import type { SsoIdTokenClaims, SsoOidcClient } from "./sso-oidc.client.js";
import { SsoCasdoorGroupClient } from "./sso-casdoor-group.client.js";
import {
  PostgresSsoUserRepository,
  type SsoUserRecord,
} from "./sso-user.repository.js";
import type { SsoConfig } from "./sso.config.js";
import { SsoLoginError, type SsoLoginReason } from "./sso.error.js";
import { DEFAULT_SSO_RETURN_TO, normalizeReturnTo } from "./sso-return-to.js";
import {
  loginErrorLocation,
  SsoGateway,
  type SsoCompleteInput,
  type SsoCompleteResult,
  type SsoStartInput,
  type SsoStartResult,
} from "./sso-gateway.js";

/** 从 state 派生 nonce 与 PKCE verifier 的 HMAC 用途前缀（域分离）。 */
const SSO_MATERIAL_PURPOSE = "inpulse-sso-login-v1";
const LOGIN_NAME_MAX_LENGTH = 100;
const NAME_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 320;
const SUBJECT_MAX_LENGTH = 200;

/**
 * 立镖 Casdoor OIDC 单点登录的纵切片（ADR-032）。
 *
 * 安全语义：
 * - state 明文只出现在 URL 与 `__Host-sso-state` Cookie，数据库只存 Hash；
 *   nonce 与 PKCE verifier 由服务端用同一 keyring 从 state 派生，不落库；
 * - 换取 token 与 JWKS 验签一律在数据库事务之外执行；
 * - state 在换取 token 前一次性消费，并发回调只有一个能成功；
 * - 只把 sub/Name/DisplayName/Email 映射到本地账号，Casdoor 的 isAdmin 等
 *   其余 claim 一律不得影响 InPulse 权限；
 * - 成功与失败都 302 回应用或登录页，不向浏览器返回 token、Secret 或堆栈。
 */
export class SsoLoginService extends SsoGateway {
  readonly enabled = true;

  constructor(
    private readonly unitOfWork: PostgresUnitOfWork,
    private readonly attempts: PostgresSsoLoginAttemptRepository,
    private readonly users: PostgresSsoUserRepository,
    private readonly organizationSync: OrganizationSyncPort,
    private readonly credentials: PostgresUserCredentialRepository,
    private readonly sessions: PostgresUserSessionRepository,
    private readonly csrfTokens: PostgresSessionCsrfTokenRepository,
    private readonly tokens: SessionTokenService,
    private readonly rateLimit: LoginRateLimitService,
    private readonly audit: AuditWritePort,
    private readonly config: SsoConfig,
    private readonly oidc: SsoOidcClient,
    private readonly groupDirectory: SsoCasdoorGroupClient,
    private readonly ttl: SessionTtlPolicy,
    private readonly keyring: VersionedHmacKeyring,
  ) {
    super();
  }

  async start(input: SsoStartInput): Promise<SsoStartResult> {
    const state = generateOpaqueToken();
    const hash = this.tokens.hash(state);
    const returnTo = normalizeReturnTo(input.returnTo);
    const expiresAt = new Date(Date.now() + this.config.stateTtlSeconds * 1000);
    await this.unitOfWork.run((tx) =>
      this.attempts.create(tx, {
        stateHash: hash.hash,
        stateHashKeyVersion: hash.keyVersion,
        returnTo,
        expiresAt,
      }),
    );

    const nonce = this.derive(state, hash.keyVersion, "nonce");
    const codeVerifier = this.derive(state, hash.keyVersion, "verifier");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");
    const location = await this.oidc.buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge,
    });
    return {
      location,
      cookies: [
        {
          name: SSO_STATE_COOKIE_NAME,
          value: state,
          maxAgeSeconds: this.config.stateTtlSeconds,
        },
      ],
    };
  }

  /** 回调永远返回 302；失败按分类回登录页并写审计，不向浏览器泄露内部原因。 */
  async complete(input: SsoCompleteInput): Promise<SsoCompleteResult> {
    try {
      return await this.completeOrThrow(input);
    } catch (error) {
      const reason = reasonOf(error);
      await this.recordFailure(input, reason);
      return {
        location: loginErrorLocation(reason),
        cookies: [clearStateCookie()],
      };
    }
  }

  private async completeOrThrow(
    input: SsoCompleteInput,
  ): Promise<SsoCompleteResult> {
    if (input.error !== undefined) {
      throw new SsoLoginError("idp-error");
    }
    if (
      input.iss !== undefined &&
      !issuerMatches(input.iss, this.config.issuer)
    ) {
      throw new SsoLoginError("issuer-mismatch");
    }
    const state = input.state;
    if (state === undefined || !isValidOpaqueToken(state)) {
      throw new SsoLoginError("state-invalid");
    }
    const cookieState = parseCookieHeader(
      input.cookieHeader,
      SSO_STATE_COOKIE_NAME,
    );
    if (
      cookieState === undefined ||
      !constantTimeEqual(Buffer.from(state), Buffer.from(cookieState))
    ) {
      throw new SsoLoginError("state-mismatch");
    }

    const attempt = await this.consumeAttempt(state, input.clientIp);
    const code = input.code;
    if (code === undefined || code.trim().length === 0) {
      throw new SsoLoginError("missing-code");
    }

    const idToken = await this.exchange(
      code,
      state,
      attempt.stateHashKeyVersion,
    );
    const claims = await this.verify(
      idToken,
      state,
      attempt.stateHashKeyVersion,
    );
    const organizationGroups = await this.resolveOrganizationGroups(
      claims.groups,
    );
    const issued = await this.issueSession(claims, organizationGroups, input);
    return {
      location: attempt.returnTo ?? DEFAULT_SSO_RETURN_TO,
      cookies: [
        clearStateCookie(),
        {
          name: SESSION_COOKIE_NAME,
          value: issued.sessionToken,
          maxAgeSeconds: this.ttl.absoluteMaxAgeSeconds,
        },
      ],
    };
  }

  private async consumeAttempt(state: string, clientIp: string) {
    try {
      return await this.unitOfWork.run(async (tx) => {
        await this.rateLimit.assertIpAllowed(tx, clientIp);
        const candidates = this.tokens.hashCandidates(state);
        const attempt = await this.attempts.findByStateHashes(
          tx,
          candidates.map((candidate) => candidate.hash),
        );
        if (attempt === undefined) {
          throw new SsoLoginError("state-invalid");
        }
        if (attempt.consumedAt !== null) {
          throw new SsoLoginError("state-consumed");
        }
        if (attempt.expiresAt.getTime() <= Date.now()) {
          throw new SsoLoginError("state-expired");
        }
        const consumed = await this.attempts.consumeOnce(tx, attempt.id);
        if (!consumed) {
          throw new SsoLoginError("state-consumed");
        }
        return attempt;
      });
    } catch (error) {
      if (error instanceof LoginError && error.status === 429) {
        throw new SsoLoginError("rate-limited", error);
      }
      throw error;
    }
  }

  private async exchange(
    code: string,
    state: string,
    keyVersion: number,
  ): Promise<string> {
    try {
      return await this.oidc.exchangeAuthorizationCode({
        code,
        codeVerifier: this.derive(state, keyVersion, "verifier"),
      });
    } catch (error) {
      throw new SsoLoginError("token-exchange-failed", error);
    }
  }

  private async verify(
    idToken: string,
    state: string,
    keyVersion: number,
  ): Promise<SsoIdTokenClaims> {
    let claims: SsoIdTokenClaims;
    try {
      claims = await this.oidc.verifyIdToken(idToken, {
        nonce: this.derive(state, keyVersion, "nonce"),
      });
    } catch (error) {
      throw new SsoLoginError("token-invalid", error);
    }
    if (!fitsLocalColumns(claims)) {
      throw new SsoLoginError("token-invalid");
    }
    if (claims.groups !== null) {
      try {
        normalizeCasdoorGroupPaths(claims.groups);
      } catch (error) {
        if (error instanceof InvalidCasdoorGroupPathError) {
          throw new SsoLoginError("token-invalid", error);
        }
        throw error;
      }
    }
    return claims;
  }

  private async resolveOrganizationGroups(
    groups: readonly string[] | null,
  ): Promise<readonly string[] | null> {
    if (groups === null) {
      return null;
    }
    if (groups.length === 0) {
      return [];
    }
    try {
      return await this.groupDirectory.resolvePhysicalGroups(groups);
    } catch (error) {
      throw new SsoLoginError("group-metadata-failed", error);
    }
  }

  private async issueSession(
    claims: SsoIdTokenClaims,
    organizationGroups: readonly string[] | null,
    input: SsoCompleteInput,
  ): Promise<IssuedAuthenticatedSession> {
    return this.unitOfWork.run(async (tx) => {
      const mapping = await this.users.mapIdentity(tx, claims);
      if (mapping.kind === "conflict") {
        throw new SsoLoginError("account-conflict", mapping.reason);
      }
      const user = mapping.user;
      if (user.status !== "ACTIVE" || user.disabledAt !== null) {
        throw new SsoLoginError("account-disabled");
      }
      const organizationSync = await this.organizationSync.syncSsoMemberships({
        tx,
        userId: user.id,
        groups: organizationGroups,
      });
      await this.appendAccountAudit(tx, user, mapping.outcome, input);
      await this.appendOrganizationSyncAudit(tx, user, organizationSync, input);
      const snapshot = await this.credentials.lockForSessionIssue(
        tx,
        user.id,
        user.authVersion,
      );
      if (snapshot === undefined) {
        throw new SsoLoginError("account-unavailable");
      }
      const issued = await issueAuthenticatedSession(
        tx,
        {
          sessions: this.sessions,
          csrfTokens: this.csrfTokens,
          tokens: this.tokens,
        },
        {
          userId: snapshot.id,
          authVersion: snapshot.authVersion,
          idleMaxAgeSeconds: this.ttl.idleMaxAgeSeconds,
          absoluteMaxAgeSeconds: this.ttl.absoluteMaxAgeSeconds,
        },
      );
      await this.appendLoginAudit(
        tx,
        user,
        mapping.outcome,
        organizationSync,
        input,
      );
      return issued;
    });
  }

  private async appendOrganizationSyncAudit(
    tx: TransactionContext,
    user: SsoUserRecord,
    result: SsoOrganizationSyncResult,
    input: SsoCompleteInput,
  ): Promise<void> {
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: user.id,
      action: "auth.sso_organizations_synced",
      targetType: "USER",
      targetId: String(user.id),
      eventPayload: {
        groupsClaimPresent: result.groupsClaimPresent,
        groupCount: result.groupCount,
        createdOrganizationCount: result.createdOrganizationCount,
        membershipCount: result.membershipCount,
      },
      requestId: input.requestId,
      ipAddress: input.clientIp,
      userAgent: input.userAgent,
    });
  }

  private async appendAccountAudit(
    tx: TransactionContext,
    user: SsoUserRecord,
    outcome: string,
    input: SsoCompleteInput,
  ): Promise<void> {
    const meta = {
      projectId: null,
      actorType: "USER" as const,
      actorId: user.id,
      targetType: "USER",
      targetId: String(user.id),
      requestId: input.requestId,
      ipAddress: input.clientIp,
      userAgent: input.userAgent,
    };
    if (outcome === "provisioned") {
      await this.audit.append(tx, {
        ...meta,
        action: "auth.sso_account_provisioned",
        // ADR-075：仅表达本次开通是否授予首管理员，不写入其他信息。
        eventPayload: { grantedAdmin: user.isAdmin },
      });
    }
    if (outcome === "linked") {
      await this.audit.append(tx, {
        ...meta,
        action: "auth.sso_account_linked",
        eventPayload: {},
      });
    }
  }

  private async appendLoginAudit(
    tx: TransactionContext,
    user: SsoUserRecord,
    outcome: string,
    organizationSync: SsoOrganizationSyncResult,
    input: SsoCompleteInput,
  ): Promise<void> {
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: user.id,
      action: "auth.sso_login",
      targetType: "USER",
      targetId: String(user.id),
      eventPayload: {
        outcome,
        groupsClaimPresent: organizationSync.groupsClaimPresent,
        groupCount: organizationSync.groupCount,
      },
      requestId: input.requestId,
      ipAddress: input.clientIp,
      userAgent: input.userAgent,
    });
  }

  /**
   * 失败审计与 IP 限流计数放在独立短事务中，且不再二次记录限流拒绝，
   * 避免被拒绝的请求放大自身。审计写入失败不影响回跳行为。
   */
  private async recordFailure(
    input: SsoCompleteInput,
    reason: SsoLoginReason,
  ): Promise<void> {
    try {
      await this.unitOfWork.run(async (tx) => {
        if (reason !== "rate-limited") {
          await this.rateLimit.recordIpFailureInTransaction(tx, input.clientIp);
        }
        await this.audit.append(tx, {
          projectId: null,
          actorType: "SYSTEM",
          actorId: null,
          action: "auth.sso_login_failed",
          targetType: "USER",
          targetId: null,
          eventPayload: { reason },
          requestId: input.requestId,
          ipAddress: input.clientIp,
          userAgent: input.userAgent,
        });
      });
    } catch {
      // 失败审计是尽力而为；不得因为审计故障改变回跳结果或泄露内部错误。
    }
  }

  /** 用会话 HMAC keyring 与 state 派生一次性材料，保证明文材料不落库。 */
  private derive(state: string, keyVersion: number, label: string): string {
    return createHmac("sha256", this.keyring.keyFor(keyVersion))
      .update(`${SSO_MATERIAL_PURPOSE}\0${label}\0${state}`, "utf8")
      .digest("base64url");
  }
}

function clearStateCookie(): CsrfSetCookie {
  return { name: SSO_STATE_COOKIE_NAME, value: null, maxAgeSeconds: 0 };
}

function fitsLocalColumns(claims: SsoIdTokenClaims): boolean {
  return (
    claims.subject.length <= SUBJECT_MAX_LENGTH &&
    claims.loginName.length <= LOGIN_NAME_MAX_LENGTH &&
    claims.displayName.length <= NAME_MAX_LENGTH &&
    (claims.email === null || claims.email.length <= EMAIL_MAX_LENGTH)
  );
}

/**
 * RFC 9207：回调 URL 的 iss 必须等于配置的 issuer，仅容忍首尾空白与尾部斜杠
 * 差异；不一致说明授权响应可能来自其它签发者，按 mix-up 拒绝。
 */
function issuerMatches(reported: string, configured: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, "");
  return normalize(reported) === normalize(configured);
}

function reasonOf(error: unknown): SsoLoginReason {
  if (error instanceof SsoLoginError) {
    return error.reason;
  }
  if (error instanceof LoginError && error.status === 429) {
    return "rate-limited";
  }
  if (isUniqueViolation(error)) {
    return "account-conflict";
  }
  return "internal";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}
