import { Inject, Injectable } from "@nestjs/common";

import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import type { ProjectAccessQueryPort } from "../modules/projects/project-access.port.js";
import { PROJECT_ACCESS_QUERY_PORT } from "../modules/projects/project-access.port.js";
import { ProjectQueryPort } from "../modules/projects/project-query.port.js";
import {
  TaskDraftAssistCatalogPort,
  type TaskDraftAssistModuleItem,
} from "./task-draft-assist.catalog.port.js";
import {
  TaskDraftAssistProjectCatalogPort,
  type TaskDraftAssistProjectItem,
} from "./task-draft-assist-project-catalog.port.js";

/** 候选上限：只给模型足够判断的项目名，不把整库塞进一次提示词。 */
export const TASK_DRAFT_ASSIST_MAX_PROJECTS = 120;

@Injectable()
export class PostgresTaskDraftAssistProjectCatalog extends TaskDraftAssistProjectCatalogPort {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort)
    private readonly projects: ProjectQueryPort,
    @Inject(PostgresUnitOfWork)
    private readonly uow: PostgresUnitOfWork,
    @Inject(TaskDraftAssistCatalogPort)
    private readonly catalog: TaskDraftAssistCatalogPort,
  ) {
    super();
  }

  async load(
    actorUserId: number,
  ): Promise<readonly TaskDraftAssistProjectItem[]> {
    const scope = await this.access.getAuthorizedSearchScope(actorUserId);
    const items = await this.projects.list(scope.projectIds, actorUserId);
    return items.slice(0, TASK_DRAFT_ASSIST_MAX_PROJECTS).map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
    }));
  }

  async loadModules(
    actorUserId: number,
    projectId: number,
  ): Promise<readonly TaskDraftAssistModuleItem[]> {
    const scope = await this.access.getAuthorizedSearchScope(actorUserId);
    if (!scope.projectIds.includes(projectId)) return [];
    const catalog = await this.uow.run((tx) =>
      this.catalog.load(tx, projectId),
    );
    return catalog.modules;
  }
}
