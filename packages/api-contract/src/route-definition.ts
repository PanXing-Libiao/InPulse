import type { SchemaName } from "./schema-registry.js";

/** 技术设计 4.1：HTTP API 统一前缀。 */
export const apiBasePath = "/api/v1";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** ADR-019：非安全方法默认 idempotencyRequired。 */
export const unsafeHttpMethods: readonly HttpMethod[] = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

/** AGENTS.md 第 6 节固定锁序：父级共享锁在前，业务聚合锁序在后。 */
export const canonicalLockOrder = [
  "project",
  "module",
  "task",
  "taskGroup",
  "changeRecord",
  "leftoverItem",
] as const;

export type LockTarget = (typeof canonicalLockOrder)[number];

export type AuthPolicy = "none" | "session" | "adminSession";

export type CsrfPolicy = "none" | "required";

export type IdempotencyPolicy = "none" | "idempotencyRequired" | "securityFlow";

export interface ContentTypeBinding {
  readonly contentType: string;
  readonly schemaRef: SchemaName;
}

export type BodyBinding =
  | { readonly body: { readonly contentTypes: readonly ContentTypeBinding[] } }
  | { readonly noBody: true };

export interface RouteRequest {
  readonly path: SchemaName | "none";
  readonly query: SchemaName | "none";
  readonly headers: SchemaName | "none";
  readonly body:
    | { readonly contentTypes: readonly ContentTypeBinding[] }
    | { readonly noBody: true };
}

export type ReplaySuccessEntry =
  | {
      readonly body: {
        readonly responseSchemaRef: SchemaName;
        readonly safeBodyFieldPaths: readonly string[];
      };
    }
  | { readonly noBody: true };

export interface IdempotencyReplayPolicy {
  readonly version: string;
  readonly success: Readonly<Record<string, ReplaySuccessEntry>>;
}

export type ReplayAuthorizationPolicy =
  | { readonly version: string; readonly actorOnly: true }
  | {
      readonly version: string;
      readonly resources: {
        readonly contextSchemaRef: SchemaName;
        readonly resultRefExtractor: string;
        readonly currentReadAuthorizer: string;
      };
    };

export interface SecurityFlowPolicy {
  readonly singleConsumptionOrNaturalIdempotency: string;
  readonly clientRecoveryPath: string;
}

export interface VersionPolicy {
  readonly apiVersion: string;
  readonly schemaVersion: string;
  readonly ifMatch: "required" | "none";
}

export interface ConcurrencyPolicy {
  readonly rowVersion: "required" | "none";
  readonly lockOrder: readonly LockTarget[] | "none";
  readonly retry: string;
}

/**
 * 技术设计 4.1.1：每条路由必须完整登记全部策略，不适用的策略显式写 `none`，
 * 禁止依赖隐式默认值。字段缺失由 TypeScript 与 validateRouteRegistry 双重拦截。
 */
export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly request: RouteRequest;
  readonly responses: Readonly<Record<string, BodyBinding>>;
  readonly authPolicy: AuthPolicy;
  readonly csrfPolicy: CsrfPolicy;
  readonly idempotencyPolicy: IdempotencyPolicy;
  readonly idempotencyExceptionAdr: string | "none";
  readonly idempotencyContractVersion: string | "none";
  readonly idempotencyFingerprintVersion: string | "none";
  readonly behaviorHeaders: readonly string[] | "none";
  readonly idempotencyReplayPolicy: IdempotencyReplayPolicy | "none";
  readonly replayAuthorizationPolicy: ReplayAuthorizationPolicy | "none";
  readonly securityFlowPolicy: SecurityFlowPolicy | "none";
  readonly versionPolicy: VersionPolicy | "none";
  readonly concurrencyPolicy: ConcurrencyPolicy | "none";
  readonly auditAction: string | "none";
}
