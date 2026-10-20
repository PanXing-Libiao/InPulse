import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { appSchema, bytea } from "./shared.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const users = appSchema.table(
  "users",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    loginName: text("login_name").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    passwordHash: text("password_hash"),
    ssoSubject: text("sso_subject"),
    isAdmin: boolean("is_admin").notNull().default(false),
    status: text("status").notNull().default("ACTIVE"),
    authVersion: integer("auth_version").notNull().default(1),
    rowVersion: integer("row_version").notNull().default(1),
    passwordChangedAt: timestamptz("password_changed_at")
      .notNull()
      .defaultNow(),
    disabledAt: timestamptz("disabled_at"),
    /** ADR-082 的墓碑列；ADR-088 起删除改为物理删除，正常账号恒为空。 */
    deletedAt: timestamptz("deleted_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("users_id_unique").on(table.id),
    uniqueIndex("users_login_name_normalized_unique").on(
      sql.raw("lower(btrim(login_name))"),
    ),
    uniqueIndex("users_email_normalized_unique")
      .on(sql.raw("lower(btrim(email))"))
      .where(sql.raw("email IS NOT NULL")),
    uniqueIndex("users_sso_subject_unique")
      .on(table.ssoSubject)
      .where(sql.raw("sso_subject IS NOT NULL")),
    check(
      "users_login_name_length_check",
      sql.raw("length(btrim(login_name)) BETWEEN 1 AND 100"),
    ),
    check(
      "users_name_length_check",
      sql.raw("length(btrim(name)) BETWEEN 1 AND 200"),
    ),
    check(
      "users_email_check",
      sql.raw("email IS NULL OR length(btrim(email)) BETWEEN 3 AND 320"),
    ),
    check(
      "users_avatar_url_check",
      sql.raw("avatar_url IS NULL OR length(avatar_url) BETWEEN 1 AND 2048"),
    ),
    check(
      "users_password_hash_check",
      sql.raw(
        "password_hash IS NULL OR length(password_hash) BETWEEN 20 AND 1024",
      ),
    ),
    check(
      "users_password_algorithm_check",
      sql.raw("password_hash IS NULL OR password_hash LIKE '$argon2id$%'"),
    ),
    check(
      "users_sso_subject_check",
      sql.raw(
        "sso_subject IS NULL OR length(btrim(sso_subject)) BETWEEN 1 AND 200",
      ),
    ),
    check("users_status_check", sql.raw("status IN ('ACTIVE', 'DISABLED')")),
    check("users_auth_version_check", sql.raw("auth_version > 0")),
    check("users_row_version_check", sql.raw("row_version > 0")),
    check(
      "users_disabled_state_check",
      sql.raw(
        "(status = 'ACTIVE' AND disabled_at IS NULL) OR (status = 'DISABLED' AND disabled_at IS NOT NULL)",
      ),
    ),
    check(
      "users_deleted_state_check",
      sql.raw(
        "deleted_at IS NULL OR (status = 'DISABLED' AND disabled_at IS NOT NULL AND login_name = 'deleted-user-' || id::text AND name = '删除用户' AND email IS NULL AND avatar_url IS NULL AND password_hash IS NULL AND organization_id IS NULL AND is_admin = false)",
      ),
    ),
  ],
);

export const deletedUserIdentities = appSchema.table(
  "deleted_user_identities",
  {
    userId: integer("user_id").primaryKey(),
    name: text("name").notNull(),
    loginName: text("login_name").notNull(),
    deletedAt: timestamptz("deleted_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "deleted_user_identities_name_check",
      sql.raw("length(btrim(name)) BETWEEN 1 AND 200"),
    ),
    check(
      "deleted_user_identities_login_check",
      sql.raw("length(btrim(login_name)) BETWEEN 1 AND 100"),
    ),
  ],
);

export const userSessions = appSchema.table(
  "user_sessions",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    tokenHashKeyVersion: smallint("token_hash_key_version").notNull(),
    authVersionAtIssue: integer("auth_version_at_issue").notNull(),
    authState: text("auth_state").notNull(),
    recoveryRotationGeneration: integer("recovery_rotation_generation")
      .notNull()
      .default(0),
    recoveryRotationConsumedGeneration: integer(
      "recovery_rotation_consumed_generation",
    )
      .notNull()
      .default(0),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    idleExpiresAt: timestamptz("idle_expires_at").notNull(),
    absoluteExpiresAt: timestamptz("absolute_expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    reauthenticatedAt: timestamptz("reauthenticated_at"),
    mfaVerifiedAt: timestamptz("mfa_verified_at"),
  },
  (table) => [
    unique("user_sessions_token_hash_unique").on(table.tokenHash),
    index("user_sessions_user_active_idx")
      .on(table.userId, table.absoluteExpiresAt)
      .where(sql.raw("revoked_at IS NULL")),
    index("user_sessions_expiry_idx").on(
      table.absoluteExpiresAt,
      table.idleExpiresAt,
    ),
    check(
      "user_sessions_token_hash_check",
      sql.raw("octet_length(token_hash) = 32"),
    ),
    check(
      "user_sessions_token_key_version_check",
      sql.raw("token_hash_key_version > 0"),
    ),
    check(
      "user_sessions_auth_version_check",
      sql.raw("auth_version_at_issue > 0"),
    ),
    check(
      "user_sessions_auth_state_check",
      sql.raw(
        "auth_state IN ('AUTHENTICATED', 'MFA_ENROLLMENT', 'MFA_CHALLENGE', 'RECOVERY_CHALLENGE')",
      ),
    ),
    check(
      "user_sessions_rotation_check",
      sql.raw(
        "recovery_rotation_generation >= 0 AND recovery_rotation_consumed_generation >= 0 AND recovery_rotation_consumed_generation <= recovery_rotation_generation",
      ),
    ),
    check(
      "user_sessions_expiry_order_check",
      sql.raw("idle_expires_at <= absolute_expires_at"),
    ),
    check(
      "user_sessions_revoked_at_check",
      sql.raw("revoked_at IS NULL OR revoked_at >= created_at"),
    ),
  ],
);

export const sessionCsrfTokens = appSchema.table(
  "session_csrf_tokens",
  {
    sessionId: bigint("session_id", { mode: "number" })
      .notNull()
      .references(() => userSessions.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    issuedAt: timestamptz("issued_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "session_csrf_tokens_pk",
      columns: [table.sessionId, table.tokenHash],
    }),
    unique("session_csrf_tokens_hash_unique").on(table.tokenHash),
    index("session_csrf_tokens_expiry_idx").on(table.expiresAt),
    check(
      "session_csrf_tokens_hash_check",
      sql.raw("octet_length(token_hash) = 32"),
    ),
    check(
      "session_csrf_tokens_expiry_check",
      sql.raw("expires_at > issued_at"),
    ),
  ],
);

export const preauthSessions = appSchema.table(
  "preauth_sessions",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    tokenHash: bytea("token_hash").notNull(),
    tokenHashKeyVersion: smallint("token_hash_key_version").notNull(),
    csrfTokenHash: bytea("csrf_token_hash").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
  },
  (table) => [
    unique("preauth_sessions_token_hash_unique").on(table.tokenHash),
    unique("preauth_sessions_csrf_hash_unique").on(table.csrfTokenHash),
    index("preauth_sessions_expiry_idx").on(table.expiresAt),
    check(
      "preauth_sessions_hashes_check",
      sql.raw(
        "octet_length(token_hash) = 32 AND octet_length(csrf_token_hash) = 32",
      ),
    ),
    check(
      "preauth_sessions_key_version_check",
      sql.raw("token_hash_key_version > 0"),
    ),
    check(
      "preauth_sessions_expiry_check",
      sql.raw(
        "expires_at > created_at AND expires_at <= created_at + INTERVAL '10 minutes'",
      ),
    ),
    check(
      "preauth_sessions_consumed_at_check",
      sql.raw("consumed_at IS NULL OR consumed_at >= created_at"),
    ),
  ],
);

export const userTotpFactors = appSchema.table(
  "user_totp_factors",
  {
    userId: integer("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    enrollmentGeneration: integer("enrollment_generation").notNull(),
    keyVersion: smallint("key_version").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    lastAcceptedStep: bigint("last_accepted_step", { mode: "number" }),
    enrolledAt: timestamptz("enrolled_at"),
    disabledAt: timestamptz("disabled_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  () => [
    check(
      "user_totp_factors_status_check",
      sql.raw("status IN ('ENROLLING', 'ACTIVE', 'DISABLED')"),
    ),
    check(
      "user_totp_factors_generation_check",
      sql.raw("enrollment_generation > 0"),
    ),
    check("user_totp_factors_key_version_check", sql.raw("key_version > 0")),
    check(
      "user_totp_factors_crypto_check",
      sql.raw(
        "octet_length(nonce) BETWEEN 12 AND 32 AND octet_length(ciphertext) > 0 AND octet_length(auth_tag) BETWEEN 12 AND 32",
      ),
    ),
    check(
      "user_totp_factors_state_check",
      sql.raw(
        "(status = 'ENROLLING' AND enrolled_at IS NULL AND disabled_at IS NULL) OR (status = 'ACTIVE' AND enrolled_at IS NOT NULL AND disabled_at IS NULL) OR (status = 'DISABLED' AND disabled_at IS NOT NULL)",
      ),
    ),
  ],
);

export const mfaRecoveryCodes = appSchema.table(
  "mfa_recovery_codes",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchVersion: integer("batch_version").notNull(),
    codeHash: text("code_hash").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    usedAt: timestamptz("used_at"),
  },
  (table) => [
    unique("mfa_recovery_codes_user_hash_unique").on(
      table.userId,
      table.codeHash,
    ),
    index("mfa_recovery_codes_user_active_idx")
      .on(table.userId, table.batchVersion)
      .where(sql.raw("used_at IS NULL")),
    check("mfa_recovery_codes_batch_check", sql.raw("batch_version > 0")),
    check(
      "mfa_recovery_codes_argon2id_check",
      sql.raw("code_hash LIKE '$argon2id$%' AND length(code_hash) <= 1024"),
    ),
    check(
      "mfa_recovery_codes_used_at_check",
      sql.raw("used_at IS NULL OR used_at >= created_at"),
    ),
  ],
);

/**
 * SSO 登录尝试（ADR-032）。只保存 state 的 HMAC-SHA-256 哈希与 return_to；
 * nonce 与 PKCE code_verifier 由服务端从 state 派生，不落库可重放材料。
 */
export const ssoLoginAttempts = appSchema.table(
  "sso_login_attempts",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    stateHash: bytea("state_hash").notNull(),
    stateHashKeyVersion: smallint("state_hash_key_version").notNull(),
    returnTo: text("return_to"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
  },
  (table) => [
    unique("sso_login_attempts_state_hash_unique").on(table.stateHash),
    index("sso_login_attempts_cleanup_idx").on(table.expiresAt, table.id),
    check(
      "sso_login_attempts_state_hash_check",
      sql.raw("octet_length(state_hash) = 32"),
    ),
    check(
      "sso_login_attempts_key_version_check",
      sql.raw("state_hash_key_version > 0"),
    ),
    check(
      "sso_login_attempts_return_to_check",
      sql.raw("return_to IS NULL OR length(return_to) BETWEEN 1 AND 2000"),
    ),
    check(
      "sso_login_attempts_expiry_check",
      sql.raw(
        "expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes'",
      ),
    ),
    check(
      "sso_login_attempts_consumed_check",
      sql.raw("consumed_at IS NULL OR consumed_at >= created_at"),
    ),
  ],
);

export const authRateLimitBuckets = appSchema.table(
  "auth_rate_limit_buckets",
  {
    bucketType: text("bucket_type").notNull(),
    dimensionHash: bytea("dimension_hash").notNull(),
    windowStartedAt: timestamptz("window_started_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    blockedUntil: timestamptz("blocked_until"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "auth_rate_limit_buckets_pk",
      columns: [table.bucketType, table.dimensionHash, table.windowStartedAt],
    }),
    index("auth_rate_limit_buckets_cleanup_idx").on(
      table.windowStartedAt,
      table.blockedUntil,
    ),
    check(
      "auth_rate_limit_buckets_type_check",
      sql.raw("bucket_type IN ('ACCOUNT', 'IP', 'GLOBAL', 'MFA')"),
    ),
    check(
      "auth_rate_limit_buckets_hash_check",
      sql.raw("octet_length(dimension_hash) = 32"),
    ),
    check(
      "auth_rate_limit_buckets_attempts_check",
      sql.raw("attempt_count >= 0"),
    ),
    check(
      "auth_rate_limit_buckets_blocked_until_check",
      sql.raw("blocked_until IS NULL OR blocked_until >= window_started_at"),
    ),
  ],
);

export const idempotencyRecords = appSchema.table(
  "idempotency_records",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    actorId: integer("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    idempotencyContractVersion: text("idempotency_contract_version").notNull(),
    requestHash: bytea("request_hash").notNull(),
    requestHashKeyVersion: smallint("request_hash_key_version").notNull(),
    state: text("state").notNull().default("PENDING"),
    responseStatus: integer("response_status"),
    responseSchemaRef: text("response_schema_ref"),
    replayPolicyVersion: text("replay_policy_version"),
    replayAuthPolicyVersion: text("replay_auth_policy_version"),
    replayAuthContext: jsonb("replay_auth_context"),
    responseHasBody: boolean("response_has_body"),
    responseBody: jsonb("response_body"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    unique("idempotency_records_request_unique").on(
      table.actorId,
      table.operationId,
      table.idempotencyKey,
    ),
    index("idempotency_records_expiry_idx").on(table.expiresAt, table.id),
    check(
      "idempotency_records_operation_check",
      sql.raw("length(operation_id) BETWEEN 1 AND 200"),
    ),
    check(
      "idempotency_records_key_check",
      sql.raw("length(idempotency_key) BETWEEN 16 AND 128"),
    ),
    check(
      "idempotency_records_contract_check",
      sql.raw("length(idempotency_contract_version) BETWEEN 1 AND 100"),
    ),
    check(
      "idempotency_records_hash_check",
      sql.raw("octet_length(request_hash) = 32"),
    ),
    check(
      "idempotency_records_key_version_check",
      sql.raw("request_hash_key_version > 0"),
    ),
    check(
      "idempotency_records_state_check",
      sql.raw("state IN ('PENDING', 'SUCCEEDED')"),
    ),
    check(
      "idempotency_records_expiry_check",
      sql.raw(
        "expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'",
      ),
    ),
    check(
      "idempotency_records_payload_size_check",
      sql.raw(
        "(replay_auth_context IS NULL OR pg_column_size(replay_auth_context) <= 65536) AND (response_body IS NULL OR pg_column_size(response_body) <= 1048576)",
      ),
    ),
    check(
      "idempotency_records_response_check",
      sql.raw(
        "(state = 'PENDING' AND response_status IS NULL AND response_schema_ref IS NULL AND replay_policy_version IS NULL AND replay_auth_policy_version IS NULL AND replay_auth_context IS NULL AND response_has_body IS NULL AND response_body IS NULL) OR (state = 'SUCCEEDED' AND response_status BETWEEN 200 AND 299 AND replay_policy_version IS NOT NULL AND replay_auth_policy_version IS NOT NULL AND replay_auth_context IS NOT NULL AND jsonb_typeof(replay_auth_context) = 'object' AND response_has_body IS NOT NULL AND ((response_has_body AND response_schema_ref IS NOT NULL AND response_body IS NOT NULL) OR (NOT response_has_body AND response_schema_ref IS NULL AND response_body IS NULL)))",
      ),
    ),
  ],
);
