import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module.js";
// 直接引用 audit.port.js：audit/index.js 会再导出 AuditLogReadModule，
// 而后者 import AuthModule，经 barrel 引入会形成循环依赖，Nest 扫描时拿到
// undefined 并以 process.abort() 崩溃（AppModule 启动用例实测）。
import { AuditWritePort } from "../audit/audit.port.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { OrganizationSyncModule } from "../organizations/organization-sync.module.js";
import { ORGANIZATION_SYNC_PORT } from "../organizations/organization-sync.port.js";
import type { OrganizationSyncPort } from "../organizations/organization-sync.port.js";
import { SESSION_HMAC_KEYRING } from "./auth.constants.js";
import { LoginRateLimitService } from "./auth-rate-limit.service.js";
import { PostgresAuthRateLimitRepository } from "./auth-rate-limit.repository.js";
import { CsrfController } from "./csrf.controller.js";
import { CsrfIssueService } from "./csrf-issue.service.js";
import { VersionedHmacKeyring } from "./keyring.js";
import { AuthenticatedMutationService } from "./authenticated-mutation.service.js";
import { LoginController } from "./login.controller.js";
import { LoginService } from "./login.service.js";
import { LogoutController } from "./logout.controller.js";
import { LogoutService } from "./logout.service.js";
import { MeController } from "./me.controller.js";
import { MeService } from "./me.service.js";
import { PasswordService } from "./password.service.js";
import { PostgresPreauthSessionRepository } from "./preauth-session.repository.js";
import { PostgresSessionCsrfTokenRepository } from "./session-csrf-token.repository.js";
import { PostgresSessionCleanupRepository } from "./session-cleanup.repository.js";
import { SessionCleanupService } from "./session-cleanup.service.js";
import { SessionCleanupScheduler } from "./session-cleanup.scheduler.js";
import { SessionTokenService } from "./session-token.service.js";
import { PostgresUserCredentialRepository } from "./user-credential.repository.js";
import { PostgresUserSessionRepository } from "./user-session.repository.js";
import { SessionAuthService } from "./session-auth.service.js";
import { AdminHighRiskAuthService } from "./admin-high-risk.service.js";
import { UserAuthInvalidationService } from "./user-auth-invalidation.service.js";
import { PostgresUserProfileRepository } from "./user-profile.repository.js";
import { UserDirectoryController } from "./user-directory.controller.js";
import { PostgresUserDirectoryRepository } from "./user-directory.repository.js";
import { UserDirectoryService } from "./user-directory.service.js";
import { PostgresUserReadPort, UserReadPort } from "./user-read.port.js";
import {
  SESSION_TTL_POLICY,
  sessionTtlPolicyFromEnv,
  type SessionTtlPolicy,
} from "./session-ttl.policy.js";
import { PostgresSsoLoginAttemptRepository } from "./sso/sso-login-attempt.repository.js";
import { PostgresSsoUserRepository } from "./sso/sso-user.repository.js";
import { SsoCasdoorGroupClient } from "./sso/sso-casdoor-group.client.js";
import { SsoCasdoorDirectoryClient } from "./sso/sso-casdoor-directory.client.js";
import { SsoCasdoorPermissionClient } from "./sso/sso-casdoor-permission.client.js";
import {
  CASDOOR_IMPORT_PORT,
  type CasdoorImportPort,
} from "./sso/casdoor-import.port.js";
import {
  DisabledCasdoorImportService,
  PostgresCasdoorImportService,
} from "./sso/casdoor-import.service.js";
import { SsoOidcClient } from "./sso/sso-oidc.client.js";
import { SsoController } from "./sso/sso.controller.js";
import { SsoLoginService } from "./sso/sso-login.service.js";
import { DisabledSsoGateway, SsoGateway } from "./sso/sso-gateway.js";
import {
  SSO_CONFIG,
  loadSsoConfig,
  type SsoConfigLoadResult,
} from "./sso/sso.config.js";

/**
 * 认证/会话支柱的 Nest 模块。ADR-031 之后不再包含 TOTP、恢复码与
 * 管理员重认证：登录只保留口令因素，高风险操作只要求完整管理员 Session。
 *
 * 按保密基线，keyring 只从 `/run/secrets/*` 的
 * `SESSION_HASH_KEYRING_FILE` 加载并 fail closed；因此在生产 Secret 与
 * `SESSION_HASH_KEY_VERSION` 就绪前，本模块不挂入 `AppModule`，
 * 避免匿名健康探针启动时被未配置的 Secret 阻断。
 */
@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    IdempotencyModule,
    OrganizationSyncModule,
  ],
  providers: [
    {
      provide: SESSION_HMAC_KEYRING,
      useFactory: () => VersionedHmacKeyring.fromEnv(process.env),
    },
    SessionTokenService,
    PostgresAuthRateLimitRepository,
    LoginRateLimitService,
    PostgresPreauthSessionRepository,
    PostgresUserCredentialRepository,
    PostgresUserSessionRepository,
    PostgresSessionCsrfTokenRepository,
    PostgresSessionCleanupRepository,
    SessionCleanupService,
    SessionCleanupScheduler,
    PasswordService,
    CsrfIssueService,
    LoginService,
    LogoutService,
    MeService,
    SessionAuthService,
    AuthenticatedMutationService,
    UserAuthInvalidationService,
    PostgresUserProfileRepository,
    PostgresUserDirectoryRepository,
    UserDirectoryService,
    { provide: UserReadPort, useClass: PostgresUserReadPort },
    {
      provide: SESSION_TTL_POLICY,
      useFactory: () => sessionTtlPolicyFromEnv(process.env),
    },
    {
      provide: SSO_CONFIG,
      useFactory: () => loadSsoConfig(process.env),
    },
    PostgresSsoLoginAttemptRepository,
    PostgresSsoUserRepository,
    {
      provide: CASDOOR_IMPORT_PORT,
      inject: [SSO_CONFIG, PostgresSsoUserRepository, ORGANIZATION_SYNC_PORT],
      useFactory: (
        config: SsoConfigLoadResult,
        users: PostgresSsoUserRepository,
        organizationSync: OrganizationSyncPort,
      ): CasdoorImportPort => {
        if (config.config === undefined) {
          return new DisabledCasdoorImportService();
        }
        return new PostgresCasdoorImportService(
          users,
          organizationSync,
          new SsoCasdoorGroupClient(config.config),
          new SsoCasdoorDirectoryClient(
            config.config,
            config.config.importOrganization,
          ),
          config.config.importPermission === undefined
            ? undefined
            : new SsoCasdoorPermissionClient(
                config.config,
                config.config.importPermission,
              ),
        );
      },
    },
    {
      provide: SsoGateway,
      inject: [
        SSO_CONFIG,
        PostgresUnitOfWork,
        PostgresSsoLoginAttemptRepository,
        PostgresSsoUserRepository,
        ORGANIZATION_SYNC_PORT,
        PostgresUserCredentialRepository,
        PostgresUserSessionRepository,
        PostgresSessionCsrfTokenRepository,
        SessionTokenService,
        LoginRateLimitService,
        AuditWritePort,
        SESSION_TTL_POLICY,
        SESSION_HMAC_KEYRING,
      ],
      useFactory: (
        config: SsoConfigLoadResult,
        unitOfWork: PostgresUnitOfWork,
        attempts: PostgresSsoLoginAttemptRepository,
        ssoUsers: PostgresSsoUserRepository,
        organizationSync: OrganizationSyncPort,
        credentials: PostgresUserCredentialRepository,
        sessions: PostgresUserSessionRepository,
        csrfTokens: PostgresSessionCsrfTokenRepository,
        tokens: SessionTokenService,
        rateLimit: LoginRateLimitService,
        audit: AuditWritePort,
        ttl: SessionTtlPolicy,
        keyring: VersionedHmacKeyring,
      ): SsoGateway => {
        if (config.config === undefined) {
          if (config.invalidReason !== undefined) {
            process.stderr.write(
              `[auth] SSO 已启用但配置非法，已回落本地隐藏入口：${config.invalidReason}\n`,
            );
          }
          return new DisabledSsoGateway();
        }
        return new SsoLoginService(
          unitOfWork,
          attempts,
          ssoUsers,
          organizationSync,
          credentials,
          sessions,
          csrfTokens,
          tokens,
          rateLimit,
          audit,
          config.config,
          new SsoOidcClient(config.config),
          new SsoCasdoorGroupClient(config.config),
          ttl,
          keyring,
        );
      },
    },
    AdminHighRiskAuthService,
  ],
  controllers: [
    CsrfController,
    LoginController,
    LogoutController,
    MeController,
    UserDirectoryController,
    SsoController,
  ],
  exports: [
    UserReadPort,
    SESSION_HMAC_KEYRING,
    SessionTokenService,
    PostgresAuthRateLimitRepository,
    LoginRateLimitService,
    PostgresPreauthSessionRepository,
    PostgresUserCredentialRepository,
    PostgresUserSessionRepository,
    PostgresSessionCsrfTokenRepository,
    PostgresSessionCleanupRepository,
    PasswordService,
    CsrfIssueService,
    LoginService,
    LogoutService,
    MeService,
    SessionAuthService,
    AuthenticatedMutationService,
    UserAuthInvalidationService,
    AdminHighRiskAuthService,
    CASDOOR_IMPORT_PORT,
  ],
})
export class AuthModule {}
