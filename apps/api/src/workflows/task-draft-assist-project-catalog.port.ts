import type { TaskDraftAssistModuleItem } from "./task-draft-assist.catalog.port.js";

export interface TaskDraftAssistProjectItem {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

/**
 * 未选项目时的候选来源。授权范围必须由服务端根据当前登录用户实时生成，
 * 不接受客户端提交的 projectId；本端口只读，不写库、不取锁。
 */
export abstract class TaskDraftAssistProjectCatalogPort {
  abstract load(
    actorUserId: number,
  ): Promise<readonly TaskDraftAssistProjectItem[]>;

  abstract loadModules(
    actorUserId: number,
    projectId: number,
  ): Promise<readonly TaskDraftAssistModuleItem[]>;
}
