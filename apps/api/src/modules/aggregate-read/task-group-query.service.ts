import { Inject, Injectable } from "@nestjs/common";

import {
  AGGREGATE_READ_PAGE_LIMIT_DEFAULT,
  type TaskGroupDetailResponse,
  type TaskGroupListItem,
  type TaskGroupListPage,
  type TaskGroupMemberDetail,
  type TaskGroupRecordItem,
  type TaskGroupRecordLink,
  type TaskGroupRecordPage,
  type TaskGroupSummary,
} from "@inpulse/api-contract";

import { UserReadPort, type UserRefItem } from "../../auth/user-read.port.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  PostgresUnitOfWork,
  type UnitOfWork,
} from "../../database/unit-of-work.js";
import {
  ChangeRecordReadPort,
  type TaskPublishedRecordCountItem,
} from "../change-records/index.js";
import {
  ExternalLinksQueryPort,
  type ChangeRecordLinkRow,
} from "../external-links/index.js";
import { ModuleReadPort } from "../modules/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectQueryPort,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import {
  TaskGroupReadPort,
  type TaskGroupActiveMemberRow,
  type TaskGroupMemberRow,
  type TaskGroupReadRecord,
} from "../task-groups/index.js";
import { TaskQueryPort, type TaskReadModel } from "../tasks/index.js";
import {
  AggregateReadCursorError,
  AggregateReadCursorService,
} from "./aggregate-read-cursor.js";
import {
  AggregateReadError,
  invalidCursorError,
} from "./aggregate-read.errors.js";
import { excludeMaintenanceProjects } from "./maintenance-project-filter.js";

/**
 * R-1 任务聚合组视图与 R-4 聚合组记录列表的聚合读服务。
 *
 * 授权：只调用 A 的 ProjectAccessQueryPort 取得服务端 AuthorizedProjectScope；
 * 组不存在、项目不在授权范围（含非成员）统一 404，不返回 403（A 裁决 Q-01）。
 * 展示：聚合组列表先剔除维护中项目（2026-09-30 产品口径，与 R-3 任务卡片一致）；
 * 单组详情与记录列表不按项目状态过滤，只受授权范围约束。
 * 事务：一次请求一个只读事务，不创建命令 UnitOfWork、不取任何行锁、不写投影。
 * 归属：记录列表按 Q-02 形态 B 拆到 R-4 子资源分页，R-1 只返回组与成员。
 */
export interface TaskGroupQueryCommand {
  readonly actorUserId: number;
  readonly groupId: number;
}

export interface TaskGroupRecordQueryCommand {
  readonly actorUserId: number;
  readonly groupId: number;
  readonly memberTaskId?: number;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * R-7 聚合组列表命令；projectId 只用于缩小服务端授权范围。
 * 列表只返回当前用户作为活跃分支任务负责人的组（2026-09-22 产品定案），
 * 因此 actorUserId 同时是可见性条件，不只是游标绑定。
 */
export interface TaskGroupListQueryCommand {
  readonly actorUserId: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectId?: number;
}

function notFoundError(): AggregateReadError {
  return new AggregateReadError(
    404,
    "TASK_GROUP_NOT_FOUND",
    "任务聚合组不存在或当前用户无权访问",
  );
}

function inconsistentError(detail: string): AggregateReadError {
  return new AggregateReadError(
    500,
    "AGGREGATE_READ_INCONSISTENT",
    "聚合读数据不完整，无法完成查询：" + detail,
  );
}

function toUserRef(user: UserRefItem): {
  readonly userId: number;
  readonly name: string;
  readonly avatarUrl: string | null;
} {
  return { userId: user.userId, name: user.name, avatarUrl: user.avatarUrl };
}

function toGroupSummary(group: TaskGroupReadRecord): TaskGroupSummary {
  return {
    groupId: group.groupId,
    projectId: group.projectId,
    code: group.code,
    name: group.name,
    status: group.status,
    createdAt: group.createdAt.toISOString(),
    closedAt: group.closedAt === null ? null : group.closedAt.toISOString(),
    rowVersion: group.rowVersion,
  };
}

/**
 * 成员排序由服务端固定：主任务在前，来源任务按 joinedAt 升序、taskId 升序。
 * 成员任务或负责人缺失属于不可达的数据不变量破损（成员表对 tasks 有外键、
 * 用户只停用不删除），此时显式失败而不是静默丢行。
 */
function toMemberDetails(
  members: readonly TaskGroupMemberRow[],
  taskById: ReadonlyMap<number, TaskReadModel>,
  countByTask: ReadonlyMap<number, number>,
  userById: ReadonlyMap<number, UserRefItem>,
): TaskGroupMemberDetail[] {
  const sorted = [...members].sort((left, right) => {
    if (left.role !== right.role) {
      return left.role === "MAIN" ? -1 : 1;
    }
    const joinedDelta = left.joinedAt.getTime() - right.joinedAt.getTime();
    if (joinedDelta !== 0) {
      return joinedDelta;
    }
    return left.taskId - right.taskId;
  });
  return sorted.map((member) => {
    const task = taskById.get(member.taskId);
    if (task === undefined) {
      throw inconsistentError(
        "聚合组成员缺少对应任务 " + String(member.taskId),
      );
    }
    const assignee = userById.get(task.assigneeId);
    if (assignee === undefined) {
      throw inconsistentError("任务负责人不存在 " + String(task.assigneeId));
    }
    return {
      taskId: task.taskId,
      taskCode: task.code,
      title: task.title,
      role: member.role,
      sourceKind: member.sourceKind,
      memberStatus: member.status,
      workStatus: task.workStatus,
      priority: task.priority,
      lifecycleStatus: task.lifecycleStatus,
      moduleId: task.moduleId,
      assignee: toUserRef(assignee),
      joinedAt: member.joinedAt.toISOString(),
      detachedAt:
        member.detachedAt === null ? null : member.detachedAt.toISOString(),
      detachReason: member.detachReason,
      publishedRecordCount: countByTask.get(task.taskId) ?? 0,
    };
  });
}

function toRecordLink(link: ChangeRecordLinkRow): TaskGroupRecordLink {
  return {
    linkId: link.linkId,
    displayUrl: link.displayUrl,
    kind: link.kind,
    repository: link.repository,
    externalNumber: link.externalNumber,
    externalSha: link.externalSha,
    titleSnapshot: link.titleSnapshot,
    stateSnapshot: link.stateSnapshot,
    createdAt: link.createdAt.toISOString(),
  };
}

@Injectable()
export class TaskGroupQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(TaskGroupReadPort) private readonly groups: TaskGroupReadPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(ChangeRecordReadPort)
    private readonly records: ChangeRecordReadPort,
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(ExternalLinksQueryPort)
    private readonly links: ExternalLinksQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
    private readonly cursor: AggregateReadCursorService,
  ) {}

  async getTaskGroup(
    command: TaskGroupQueryCommand,
  ): Promise<TaskGroupDetailResponse> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    return this.unitOfWork.run(async (tx) => {
      const group = await this.groups.findGroupById(tx, command.groupId);
      if (group === undefined || !scope.projectIds.includes(group.projectId)) {
        throw notFoundError();
      }
      const members = await this.groups.listMembers(
        tx,
        group.projectId,
        group.groupId,
      );
      const taskIds = members.map((member) => member.taskId);
      const taskRows = await this.tasks.listByIds(
        tx,
        [group.projectId],
        taskIds,
      );
      const counts = await this.countPublishedByTask(
        tx,
        group.projectId,
        taskIds,
      );
      const assignees = await this.users.listByIds(tx, [
        ...new Set(taskRows.map((row) => row.assigneeId)),
      ]);
      return {
        group: toGroupSummary(group),
        members: toMemberDetails(
          members,
          new Map(taskRows.map((row) => [row.taskId, row])),
          new Map(counts.map((item) => [item.taskId, item.count])),
          new Map(assignees.map((item) => [item.userId, item])),
        ),
      };
    });
  }

  async listTaskGroups(
    command: TaskGroupListQueryCommand,
  ): Promise<TaskGroupListPage> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    const limit = command.limit ?? AGGREGATE_READ_PAGE_LIMIT_DEFAULT;
    // 与 R-3 同一展示口径（2026-09-30）：维护中项目不再产出任务卡片，聚合组卡片
    // 同样不返回；项目范围在此收窄后，游标位置与列表来自同一集合。
    const projectIds = await excludeMaintenanceProjects(
      this.projects,
      command.projectId === undefined
        ? scope.projectIds
        : scope.projectIds.filter(
            (projectId) => projectId === command.projectId,
          ),
    );
    const filterKey = JSON.stringify([command.projectId ?? null]);
    const afterGroupId = this.decodeCursor(
      command.cursor,
      command.actorUserId,
      filterKey,
      "TASK_GROUPS",
    );
    const data = await this.unitOfWork.run(async (tx) => {
      const page = await this.groups.listGroups(tx, {
        projectIds,
        actorUserId: command.actorUserId,
        limit,
        ...(afterGroupId === null ? {} : { afterGroupId }),
      });
      const pageProjectIds = [
        ...new Set(page.items.map((group) => group.projectId)),
      ];
      const members = await this.groups.listActiveMembersForGroups(
        tx,
        pageProjectIds,
        page.items.map((group) => group.groupId),
      );
      const taskIds = [...new Set(members.map((member) => member.taskId))];
      const tasks = await this.tasks.listByIds(tx, pageProjectIds, taskIds);
      const assignees = await this.users.listByIds(tx, [
        ...new Set(tasks.map((row) => row.assigneeId)),
      ]);
      // 列表行的「归属 / 截止 / 迭代」三列由客户端派生，服务端只在同一只读事务内
      // 补齐事实字段（模块名、截止时间、PUBLISHED 记录数）。
      const modules = await this.modules.listNames(tx, {
        projectIds: pageProjectIds,
        moduleIds: [...new Set(tasks.map((row) => row.moduleId))],
      });
      const counts = await this.records.countPublishedByTask(
        tx,
        pageProjectIds,
        taskIds,
      );
      return {
        page,
        pageProjectIds,
        members,
        tasks,
        assignees,
        modules,
        counts,
      };
    });

    const projects = await this.projects.list(data.pageProjectIds);
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const taskById = new Map(data.tasks.map((row) => [row.taskId, row]));
    const userById = new Map(data.assignees.map((row) => [row.userId, row]));
    const moduleNameById = new Map(
      data.modules.map((row) => [row.moduleId, row.name]),
    );
    const countByTask = new Map(
      data.counts.map((row) => [row.taskId, row.count]),
    );
    const membersByGroup = new Map<number, TaskGroupActiveMemberRow[]>();
    for (const member of data.members) {
      const bucket = membersByGroup.get(member.groupId);
      if (bucket === undefined) {
        membersByGroup.set(member.groupId, [member]);
        continue;
      }
      bucket.push(member);
    }

    const items: TaskGroupListItem[] = data.page.items.map((group) => {
      const projectName = projectNameById.get(group.projectId);
      if (projectName === undefined) {
        throw inconsistentError("聚合组缺少项目 " + String(group.projectId));
      }
      const branches = [...(membersByGroup.get(group.groupId) ?? [])]
        .sort((left, right) => {
          if (left.role !== right.role) {
            return left.role === "MAIN" ? -1 : 1;
          }
          const joinedDelta =
            left.joinedAt.getTime() - right.joinedAt.getTime();
          if (joinedDelta !== 0) {
            return joinedDelta;
          }
          return left.taskId - right.taskId;
        })
        .map((member) => {
          const task = taskById.get(member.taskId);
          if (task === undefined) {
            throw inconsistentError(
              "聚合组成员缺少对应任务 " + String(member.taskId),
            );
          }
          const assignee = userById.get(task.assigneeId);
          if (assignee === undefined) {
            throw inconsistentError(
              "任务负责人不存在 " + String(task.assigneeId),
            );
          }
          const moduleName = moduleNameById.get(task.moduleId);
          if (moduleName === undefined) {
            throw inconsistentError("任务缺少模块 " + String(task.moduleId));
          }
          return {
            taskId: task.taskId,
            taskCode: task.code,
            title: task.title,
            role: member.role,
            sourceKind: member.sourceKind,
            workStatus: task.workStatus,
            priority: task.priority,
            moduleId: task.moduleId,
            moduleName,
            dueAt: task.dueAt === null ? null : task.dueAt.toISOString(),
            publishedRecordCount: countByTask.get(task.taskId) ?? 0,
            assignee: toUserRef(assignee),
          };
        });
      const main = branches.find((branch) => branch.role === "MAIN");
      return {
        groupId: group.groupId,
        projectId: group.projectId,
        projectName,
        code: group.code,
        name: group.name,
        status: group.status,
        mainTask:
          main === undefined
            ? null
            : {
                taskId: main.taskId,
                code: main.taskCode,
                projectId: group.projectId,
                moduleId: main.moduleId,
              },
        branches,
      };
    });

    return {
      items,
      nextCursor:
        data.page.nextGroupId === null
          ? null
          : this.cursor.encode({
              actorUserId: command.actorUserId,
              namespace: "TASK_GROUPS",
              filterKey,
              afterId: data.page.nextGroupId,
            }),
      hasMore: data.page.hasMore,
    };
  }

  async listTaskGroupRecords(
    command: TaskGroupRecordQueryCommand,
  ): Promise<TaskGroupRecordPage> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    const limit = command.limit ?? AGGREGATE_READ_PAGE_LIMIT_DEFAULT;
    const filterKey =
      "TASK_GROUP_RECORDS:" +
      String(command.groupId) +
      ":" +
      (command.memberTaskId === undefined
        ? "all"
        : String(command.memberTaskId));
    return this.unitOfWork.run(async (tx) => {
      const group = await this.groups.findGroupById(tx, command.groupId);
      if (group === undefined || !scope.projectIds.includes(group.projectId)) {
        throw notFoundError();
      }
      const members = await this.groups.listMembers(
        tx,
        group.projectId,
        group.groupId,
      );
      const memberTaskIds = members.map((member) => member.taskId);
      const taskIds =
        command.memberTaskId === undefined
          ? memberTaskIds
          : memberTaskIds.filter((taskId) => taskId === command.memberTaskId);
      const afterRecordId = this.decodeCursor(
        command.cursor,
        command.actorUserId,
        filterKey,
        "TASK_GROUP_RECORDS",
      );
      const page = await this.records.listVisibleRecordsByTaskIds(tx, {
        projectId: group.projectId,
        taskIds,
        limit,
        ...(afterRecordId === null ? {} : { afterRecordId }),
      });
      const links = await this.links.listChangeRecordLinks(
        tx,
        group.projectId,
        page.items.map((item) => item.recordId),
      );
      const pageTaskIds = [...new Set(page.items.map((item) => item.taskId))];
      const pageTasks = await this.tasks.listByIds(
        tx,
        [group.projectId],
        pageTaskIds,
      );
      const taskCodeById = new Map(
        pageTasks.map((task) => [task.taskId, task.code]),
      );
      const roleByTask = new Map(
        members.map((member) => [member.taskId, member.role]),
      );
      const linksByRecord = new Map<number, TaskGroupRecordLink[]>();
      for (const link of links) {
        const bucket = linksByRecord.get(link.recordId);
        if (bucket === undefined) {
          linksByRecord.set(link.recordId, [toRecordLink(link)]);
          continue;
        }
        bucket.push(toRecordLink(link));
      }
      const items: TaskGroupRecordItem[] = page.items.map((row) => ({
        recordId: row.recordId,
        code: row.code,
        title: row.title,
        recordStatus: row.status,
        taskId: row.taskId,
        sourceLabel: this.sourceLabel(row.taskId, roleByTask, taskCodeById),
        publishedAt: row.publishedAt.toISOString(),
        externalLinks: linksByRecord.get(row.recordId) ?? [],
      }));
      return {
        items,
        nextCursor:
          page.nextRecordId === null
            ? null
            : this.cursor.encode({
                actorUserId: command.actorUserId,
                namespace: "TASK_GROUP_RECORDS",
                filterKey,
                afterId: page.nextRecordId,
              }),
        hasMore: page.hasMore,
      };
    });
  }

  private async countPublishedByTask(
    tx: TransactionContext,
    projectId: number,
    taskIds: readonly number[],
  ): Promise<readonly TaskPublishedRecordCountItem[]> {
    return this.records.countPublishedByTask(tx, [projectId], taskIds);
  }

  private sourceLabel(
    taskId: number,
    roleByTask: ReadonlyMap<number, "MAIN" | "SOURCE">,
    taskCodeById: ReadonlyMap<number, string>,
  ): string {
    if (roleByTask.get(taskId) === "MAIN") {
      return "主任务";
    }
    const code = taskCodeById.get(taskId);
    if (code === undefined) {
      throw inconsistentError("聚合组记录缺少来源任务 " + String(taskId));
    }
    return code;
  }

  private decodeCursor(
    cursor: string | undefined,
    actorUserId: number,
    filterKey: string,
    namespace: "TASK_GROUP_RECORDS" | "TASK_GROUPS",
  ): number | null {
    try {
      return this.cursor.decode(cursor, {
        actorUserId,
        namespace,
        filterKey,
      });
    } catch (error) {
      if (error instanceof AggregateReadCursorError) {
        throw invalidCursorError();
      }
      throw error;
    }
  }
}
