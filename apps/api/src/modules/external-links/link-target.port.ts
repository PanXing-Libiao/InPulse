import type { TransactionContext } from "../../database/transaction-context.js";
export interface LinkTarget {
  id: number;
  projectId: number;
  moduleId: number | null;
  status: string;
  rowVersion: number;
  /**
   * 正式编号（草稿记录为 null）。与 title 一起只用于同事务写动态摘要快照，
   * 不参与授权、锁序或业务判定。
   */
  code: string | null;
  /** 目标的人类可读标题（项目 / 模块取名称）；同样只用于动态摘要。 */
  title: string;
}
export type LinkTargetLock = "share" | "update";
/** Shared/read and update locks remain held until the caller transaction ends. */
export interface LinkTargetQueryPort {
  find(
    tx: TransactionContext,
    id: number,
    lock?: LinkTargetLock,
  ): Promise<LinkTarget | undefined>;
}
export interface LinkTargetCommandPort {
  advance(tx: TransactionContext, target: LinkTarget): Promise<boolean>;
}
