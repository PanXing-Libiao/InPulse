import type { TransactionContext } from "../../database/transaction-context.js";

export interface CheckModuleForWriteInput {
  readonly projectId: number;
  readonly moduleId: number;
}

export interface ModuleForWriteResource extends CheckModuleForWriteInput {
  readonly rowVersion: number;
}

/**
 * 与其他写前检查的 WriteCheckResult 同语义：
 * - `not-found`：模块不存在或项目归属不匹配。
 * - `allowed`：已通过归属校验，模块可写。
 *
 * ADR-044：模块层面下线归档，模块不再有只读态，因此本 Port 不再返回
 * `parent-not-active`；模块当前仅有 ACTIVE 状态。
 * Port 只返回类型化结果，不抛出 HTTP 异常；HTTP 映射由 Use Case/Workflow 负责。
 */
export type ModuleWriteCheckResult =
  | { readonly kind: "allowed"; readonly resource: ModuleForWriteResource }
  | { readonly kind: "not-found" };

/** Caller authorizes and locks parents first; this check holds FOR SHARE until tx ends. */
export abstract class ModuleQueryPort {
  abstract checkModuleForWrite(
    tx: TransactionContext,
    input: CheckModuleForWriteInput,
  ): Promise<ModuleWriteCheckResult>;
}
