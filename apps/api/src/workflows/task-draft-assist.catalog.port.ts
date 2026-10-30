import type { TransactionContext } from "../database/transaction-context.js";

export interface TaskDraftAssistModuleItem {
  readonly id: number;
  readonly name: string;
}

export interface TaskDraftAssistFeatureItem {
  readonly id: number;
  readonly moduleId: number;
  readonly moduleName: string;
  readonly name: string;
}

export interface TaskDraftAssistCatalog {
  readonly modules: readonly TaskDraftAssistModuleItem[];
  readonly features: readonly TaskDraftAssistFeatureItem[];
}

/**
 * 新建任务 AI 识别的候选清单：模块与功能名称。
 * 调用方必须先通过 ProjectMembersQueryPort 完成项目读权限校验，
 * 本端口只负责读取，不判断授权，也不取锁。
 */
export abstract class TaskDraftAssistCatalogPort {
  abstract load(
    tx: TransactionContext,
    projectId: number,
  ): Promise<TaskDraftAssistCatalog>;
}
