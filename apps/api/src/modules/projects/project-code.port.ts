import type { TransactionContext } from "../../database/transaction-context.js";

/** Caller authorizes and locks the ACTIVE project first. Allocation rolls back with the command. */
export abstract class ProjectCodePort {
  abstract allocateChangeRecordCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string>;
  abstract allocateTaskCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string>;
  abstract allocateTaskGroupCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string>;

  /** ADR-064：项目编码在全局是否未被占用（预览提示；执行仍由唯一约束兜底）。 */
  abstract isCodeAvailable(
    tx: TransactionContext,
    code: string,
  ): Promise<boolean>;

  /** ADR-064：读取项目当前编码；项目不存在返回 undefined。 */
  abstract findProjectCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string | undefined>;
}
