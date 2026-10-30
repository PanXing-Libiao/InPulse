import type { TransactionContext } from "../../database/transaction-context.js";
import type { ProjectLifecycleStatus } from "./projects-write.port.js";

export const PROJECT_ACCESS_QUERY_PORT = Symbol("PROJECT_ACCESS_QUERY_PORT");

/**
 * Server-generated authorization result. Consumers must never construct this
 * value from client input. The production provider belongs to ProjectsModule
 * and is expected to read member history and the global admin flag on every
 * request.
 */
export interface AuthorizedProjectScope {
  readonly actorUserId: number;
  readonly projectIds: readonly number[];
  readonly isSystemAdmin: boolean;
}

export interface ProjectForWriteResource {
  readonly projectId: number;
  readonly status: ProjectLifecycleStatus;
  readonly rowVersion: number;
  readonly isSystemAdmin: boolean;
}

/**
 * 与模块写前检查的 `WriteCheckResult` 同语义：
 * - `not-found`：项目不存在、当前用户停用，或普通用户没有 ACTIVE 成员关系。
 * - `allowed`：已通过归属与成员校验，项目可写。
 *
 * ADR-043：项目生命周期收敛为三态（未开始 / 进行中 / 维护中），项目层不再有
 * 归档入口与只读态，因此本 Port 不再返回 `parent-not-active`。未开始 / 进行中 /
 * 维护中都是活跃态，仍可新建模块、任务与记录。
 * Port 只返回类型化结果，不抛出 HTTP 异常；HTTP 映射由 Use Case/Workflow 负责。
 */
export type ProjectWriteCheckResult =
  | { kind: "allowed"; resource: ProjectForWriteResource }
  | { kind: "not-found" };

export interface ProjectAccessQueryPort {
  getAuthorizedSearchScope(
    actorUserId: number,
  ): Promise<AuthorizedProjectScope>;

  checkProjectForWrite(
    tx: TransactionContext,
    input: { readonly actorUserId: number; readonly projectId: number },
  ): Promise<ProjectWriteCheckResult>;
}
