import { Inject, Injectable } from "@nestjs/common";

import {
  PROJECT_OVERVIEW_LEFTOVER_LIMIT_DEFAULT,
  PROJECT_OVERVIEW_RECENT_LIMIT_DEFAULT,
  type ProjectOverviewResponse,
} from "@inpulse/api-contract";

import {
  PostgresUnitOfWork,
  type UnitOfWork,
} from "../../database/unit-of-work.js";
import { ChangeRecordReadPort } from "../change-records/index.js";
import { ModuleReadPort } from "../modules/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectQueryPort,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { TaskGroupMembershipReadPort } from "../task-groups/index.js";
import { TaskQueryPort } from "../tasks/index.js";
import { AggregateReadError } from "./aggregate-read.errors.js";

/**
 * R-2 项目概览聚合读（F-29）。
 *
 * 统计口径按功能设计 §29 与 A 裁决 Q-04 / Q-05：
 * 活跃模块按行自身 status = ACTIVE 计数；未完成任务 = 有效任务中
 * work_status = TODO（有效 = 非 INVALID、非 CANCELED，且排除历史来源分支）；
 * 迭代记录数只计 PUBLISHED，不按版本重复计数。
 * 非成员或项目不存在统一 404；列表条数由契约收口（默认 3 / 2，上限 10），
 * activeLeftoverTotal 与列表同一过滤、不受 limit 影响（R-2 裁决 §10.2）。
 */
export interface ProjectOverviewQueryCommand {
  readonly actorUserId: number;
  readonly projectId: number;
  readonly recentRecordLimit?: number;
  readonly activeLeftoverLimit?: number;
}

function projectNotFoundError(): AggregateReadError {
  return new AggregateReadError(
    404,
    "PROJECT_NOT_FOUND",
    "项目不存在或当前用户无权访问",
  );
}

@Injectable()
export class ProjectOverviewQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(ChangeRecordReadPort)
    private readonly records: ChangeRecordReadPort,
    @Inject(TaskGroupMembershipReadPort)
    private readonly membership: TaskGroupMembershipReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
  ) {}

  async getOverview(
    command: ProjectOverviewQueryCommand,
  ): Promise<ProjectOverviewResponse> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    if (!scope.projectIds.includes(command.projectId)) {
      throw projectNotFoundError();
    }
    const project = await this.projects.find(command.projectId);
    if (project === undefined) {
      throw projectNotFoundError();
    }
    const recentRecordLimit =
      command.recentRecordLimit ?? PROJECT_OVERVIEW_RECENT_LIMIT_DEFAULT;
    const activeLeftoverLimit =
      command.activeLeftoverLimit ?? PROJECT_OVERVIEW_LEFTOVER_LIMIT_DEFAULT;
    const projectId = project.id;

    return this.unitOfWork.run(async (tx) => {
      const excludedTaskIds = await this.membership.listHistoricalSourceTaskIds(
        tx,
        [projectId],
      );
      // ADR-044：模块层面已下线归档，模块计数不再需要状态过滤（模块只有 ACTIVE）。
      const activeModuleCount = await this.modules.count(tx, { projectId });
      const openTaskCount = await this.tasks.count(tx, {
        projectIds: [projectId],
        workStatuses: ["TODO"],
        effectiveOnly: true,
        excludedTaskIds,
      });
      const publishedRecordCount = await this.records.countPublished(tx, {
        projectId,
      });
      const recentRecords = await this.records.listRecentPublished(tx, {
        projectId,
        limit: recentRecordLimit,
      });
      const activeLeftovers = await this.records.listActiveLeftovers(tx, {
        projectId,
        limit: activeLeftoverLimit,
      });
      const activeLeftoverTotal = await this.records.countActiveLeftovers(tx, {
        projectId,
      });

      return {
        project: {
          projectId: project.id,
          name: project.name,
          status: project.status,
        },
        memberCount: project.memberCount,
        stats: {
          activeModuleCount,
          openTaskCount,
          publishedRecordCount,
        },
        recentRecords: recentRecords.map((item) => ({
          recordId: item.recordId,
          code: item.code,
          title: item.title,
          moduleId: item.moduleId,
          publishedAt: item.publishedAt.toISOString(),
        })),
        activeLeftoverTotal,
        activeLeftovers: activeLeftovers.map((item) => ({
          leftoverItemId: item.leftoverItemId,
          recordId: item.recordId,
          recordCode: item.recordCode,
          recordTitle: item.recordTitle,
          content: item.content,
          createdAt: item.createdAt.toISOString(),
        })),
      };
    });
  }
}
