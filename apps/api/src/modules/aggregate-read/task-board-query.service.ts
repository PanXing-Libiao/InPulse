import { Inject, Injectable } from "@nestjs/common";

import {
  TASK_BOARD_LANE_AVATARS_MAX,
  type TaskBoardCard,
  type TaskBoardModule,
  type TaskBoardResponse,
  type TaskBoardStats,
  type UserRef,
} from "@inpulse/api-contract";

import { UserReadPort, type UserRefItem } from "../../auth/user-read.port.js";
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
import {
  TaskQueryPort,
  type TaskBoardStatsTotals,
  type TaskBoardTaskRow,
} from "../tasks/index.js";
import { AggregateReadError } from "./aggregate-read.errors.js";

/**
 * R-8 任务看板聚合读（项目任务看板）。
 *
 * 口径（2026-09-18 定稿，与功能设计 29 节对齐）：
 * 1. 看板集合 = 项目内 lifecycle_status = ACTIVE 的任务（不含无效任务），
 *    再排除任务组历史来源分支；已取消任务保留为历史标记。
 * 2. 完成率 = 已完成 /（已完成 + 未完成），已取消与历史来源分支不计入分母（29.2 节）。
 * 3. 逾期 / 今日到期 / 本周完成 / 卡片截止状态全部由 SQL 按 Asia/Shanghai 计算，
 *    前端只做展示映射，不按客户端时钟重算。
 * 4. 顶部与泳道统计均不受列表截断影响；任务超过 1000 条时置 truncated。
 * 5. 非成员或项目不存在统一 404，与 R-2 同一约定。
 *
 * 数据来源全部是公开 QueryPort：任务行与统计走 B 域 TaskQueryPort 的看板读扩展，
 * 模块 / 负责人 / 记录数 / 历史来源分支分别走 A、B、C 域既有端口。
 * 泳道统计按模块批量读取（V1 项目模块数有限），
 * 不新增批量端口。
 */
export interface TaskBoardQueryCommand {
  readonly actorUserId: number;
  readonly projectId: number;
}

function projectNotFoundError(): AggregateReadError {
  return new AggregateReadError(
    404,
    "PROJECT_NOT_FOUND",
    "项目不存在或当前用户无权访问",
  );
}

function inconsistentError(detail: string): AggregateReadError {
  return new AggregateReadError(
    500,
    "AGGREGATE_READ_INCONSISTENT",
    "聚合读数据不完整，无法完成查询：" + detail,
  );
}

/** 完成率 = 已完成 /（已完成 + 未完成），已取消不计入分母（功能设计 29.2 节）；分母为 0 时取 0。 */
function completionRate(done: number, open: number): number {
  const denominator = done + open;
  return denominator === 0 ? 0 : Math.round((done / denominator) * 100);
}

function toUserRef(user: UserRefItem): UserRef {
  return { userId: user.userId, name: user.name, avatarUrl: user.avatarUrl };
}

function emptyTotals(): TaskBoardStatsTotals {
  return {
    total: 0,
    done: 0,
    open: 0,
    canceled: 0,
    overdue: 0,
    dueToday: 0,
    completedThisWeek: 0,
  };
}

@Injectable()
export class TaskBoardQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(ChangeRecordReadPort)
    private readonly records: ChangeRecordReadPort,
    @Inject(TaskGroupMembershipReadPort)
    private readonly membership: TaskGroupMembershipReadPort,
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
  ) {}

  async getBoard(command: TaskBoardQueryCommand): Promise<TaskBoardResponse> {
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
    const projectId = project.id;

    const data = await this.unitOfWork.run(async (tx) => {
      const excludedTaskIds = await this.membership.listHistoricalSourceTaskIds(
        tx,
        [projectId],
      );
      const board = await this.tasks.listForBoard(tx, {
        projectId,
        excludedTaskIds,
      });
      const stats = await this.tasks.boardStats(tx, {
        projectId,
        excludedTaskIds,
      });
      const moduleIds = [...new Set(board.items.map((row) => row.moduleId))];
      const assigneeIds = [
        ...new Set(board.items.flatMap((row) => row.assigneeIds)),
      ];
      const taskIds = board.items.map((row) => row.taskId);

      const moduleNames = await this.modules.listNames(tx, {
        projectIds: [projectId],
        moduleIds,
      });
      const assignees = await this.users.listByIds(tx, assigneeIds);
      const publishedRecordCounts = await this.records.countPublishedByTask(
        tx,
        [projectId],
        taskIds,
      );
      return {
        board,
        stats,
        moduleNames,
        assignees,
        publishedRecordCounts,
      };
    });

    const moduleNameById = new Map(
      data.moduleNames.map((item) => [item.moduleId, item.name]),
    );
    const userById = new Map(data.assignees.map((item) => [item.userId, item]));
    const publishedRecordCountByTask = new Map(
      data.publishedRecordCounts.map((item) => [item.taskId, item.count]),
    );
    const moduleStatsById = new Map(
      data.stats.modules.map((item) => [item.moduleId, item]),
    );

    const tasksByModule = new Map<number, TaskBoardTaskRow[]>();
    for (const row of data.board.items) {
      const bucket = tasksByModule.get(row.moduleId);
      if (bucket === undefined) {
        tasksByModule.set(row.moduleId, [row]);
      } else {
        bucket.push(row);
      }
    }

    const modules: TaskBoardModule[] = [...tasksByModule.keys()]
      .sort((left, right) => left - right)
      .map((moduleId) => {
        const name = moduleNameById.get(moduleId);
        if (name === undefined) {
          throw inconsistentError("任务缺少模块 " + String(moduleId));
        }
        const rows = tasksByModule.get(moduleId) ?? [];
        const statRow = moduleStatsById.get(moduleId) ?? {
          moduleId,
          ...emptyTotals(),
        };
        const laneAssigneeIds: number[] = [];
        const cards: TaskBoardCard[] = rows.map((row) => {
          // ADR-040：负责人是平权集合，卡片与泳道头像都要列全，不再只取第一位。
          const cardAssignees: UserRef[] = [];
          for (const userId of row.assigneeIds) {
            const user = userById.get(userId);
            if (user === undefined) {
              throw inconsistentError("任务负责人不存在 " + String(userId));
            }
            cardAssignees.push(toUserRef(user));
            if (!laneAssigneeIds.includes(userId)) {
              laneAssigneeIds.push(userId);
            }
          }
          if (cardAssignees.length === 0) {
            throw inconsistentError("任务缺少负责人 " + String(row.taskId));
          }
          return {
            taskId: row.taskId,
            code: row.code,
            title: row.title,
            moduleId: row.moduleId,
            priority: row.priority,
            workStatus: row.workStatus,
            dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
            completedAt:
              row.completedAt === null ? null : row.completedAt.toISOString(),
            dueState: row.dueState,
            assignees: cardAssignees,
            publishedRecordCount:
              publishedRecordCountByTask.get(row.taskId) ?? 0,
          };
        });
        const laneAssignees: UserRef[] = [];
        for (const userId of laneAssigneeIds.slice(
          0,
          TASK_BOARD_LANE_AVATARS_MAX,
        )) {
          const user = userById.get(userId);
          if (user === undefined) {
            throw inconsistentError("任务负责人不存在 " + String(userId));
          }
          laneAssignees.push(toUserRef(user));
        }
        return {
          moduleId,
          name,
          stats: {
            total: statRow.total,
            done: statRow.done,
            open: statRow.open,
            canceled: statRow.canceled,
            overdue: statRow.overdue,
            completionRate: completionRate(statRow.done, statRow.open),
          },
          assignees: laneAssignees,
          tasks: cards,
        };
      });

    const totals = data.stats.totals;
    const stats: TaskBoardStats = {
      total: totals.total,
      done: totals.done,
      open: totals.open,
      canceled: totals.canceled,
      overdue: totals.overdue,
      dueToday: totals.dueToday,
      completedThisWeek: totals.completedThisWeek,
      completionRate: completionRate(totals.done, totals.open),
      memberCount: project.memberCount,
    };

    return {
      project: {
        projectId: project.id,
        name: project.name,
        status: project.status,
      },
      generatedAt: new Date().toISOString(),
      stats,
      modules,
      truncated: data.board.truncated,
    };
  }
}
