import { Inject, Injectable } from "@nestjs/common";

import {
  AGGREGATE_READ_PAGE_LIMIT_DEFAULT,
  type MyTaskItem,
  type MyTaskPage,
} from "@inpulse/api-contract";

import { UserReadPort, type UserRefItem } from "../../auth/user-read.port.js";
import {
  PostgresUnitOfWork,
  type UnitOfWork,
} from "../../database/unit-of-work.js";
import {
  ChangeRecordReadPort,
  MyTaskQueryPort,
  type MyTaskPriority,
} from "../change-records/index.js";
import { ExternalLinksQueryPort } from "../external-links/index.js";
import { ModuleReadPort } from "../modules/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectQueryPort,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { TaskGroupMembershipReadPort } from "../task-groups/index.js";
import {
  encodeTaskListSortKey,
  parseTaskListSortKey,
  type TaskListSortKey,
} from "../tasks/index.js";
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
 * R-3 我的任务聚合读（F-32）。
 *
 * 归属主体固定为当前用户（A 裁决 Q-08），不接受任何他人身份或授权范围参数；
 * ownership 只区分 ASSIGNEE（负责，缺省）与 CREATOR（创建）两个当前用户自指维度，
 * 用于任务中心「我负责的 / 我创建的」分段。projectId 只用于缩小范围，最终仍按服务端
 * AuthorizedProjectScope 过滤，越权项目直接收敛为空页而不是 404（不泄露其他项目是否存在）。
 * 维护中（MAINTENANCE）项目不产出任务卡片（2026-09-30 产品口径）：项目范围先剔除
 * 维护中项目，未完成与已完成两档、统计与遗留问题入口共用同一基准集合。
 * 排序固定，由 task-list-order.ts 给出（状态分组 → 紧急桶 → 优先级 → 遗留问题
 * → 截止时间 → id，ADR-037 替代 Q-10 的单列 id DESC），游标签名绑定 actor 与七项
 * 筛选并携带完整排序键位置；旧格式游标按无效游标拒绝。
 * 记录维度：hasPublishedRecord 由任务 → PUBLISHED 记录数映射派生（count > 0，裁决
 * 修订 D-1），筛选仍由 MyTaskQueryPort.list 在同一分页 SQL 内先过滤后分页。
 * 统计卡片与遗留问题入口按 A 裁决 §10.3（2026-09-20 按任务中心新卡片重定口径）：
 * 基准集合只受 projectId 影响，与 ownership 无关；todayTodo / myOpen / completed 取负责人
 * 维度，created 取创建人维度，两者都是当前用户自指，分页与游标不影响计数，
 * 日界由 SQL 按 Asia/Shanghai 计算。
 *
 * effectiveOnly 不在此处使用：R-3 需要返回 CANCELED / INVALID 任务才能让
 * workStatus 筛选有意义；§29.1 的「有效任务」口径只服务 R-2 的未完成任务计数。
 * 历史来源分支（task_group_members 的 HISTORICAL 来源）仍按 Q-04 排除。
 */
export interface MyTasksQueryCommand {
  readonly actorUserId: number;
  readonly scope?: "mine" | "created" | "project" | "all";
  readonly overdue?: boolean;
  /** 「今日待办」集合（契约 todayTodo）：逾期 ∪ 遗留来源 ∪ 紧急 ∪ 7 个日历日内到期。 */
  readonly todayTodo?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectId?: number;
  /**
   * 归属维度（缺省 ASSIGNEE）：ASSIGNEE 按 assignee_id 过滤，CREATOR 按 creator_id
   * 过滤，两者都是当前 actorUserId，只是列不同。
   */
  readonly ownership?: "ASSIGNEE" | "CREATOR";
  readonly workStatus?: "TODO" | "DONE" | "CANCELED";
  readonly hasPublishedRecord?: boolean;
  readonly priority?: MyTaskPriority;
  /**
   * 与 workStatus 组合表达「未完成并含已取消」（TODO ∪ CANCELED）：
   * workStatus 缺省时全集本就包含 CANCELED，该参数不产生额外过滤（A 裁决 §10.3）。
   */
  readonly includeCanceled?: boolean;
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

/**
 * R-3 的 workStatus 与 includeCanceled 组合（A 裁决 §10.3）：
 * workStatus 缺省表示全集（本已包含 CANCELED）；includeCanceled = true 时
 * 在显式 workStatus 上并入 CANCELED（TODO ∪ CANCELED），否则保持单值。
 */
function effectiveWorkStatuses(
  command: MyTasksQueryCommand,
): readonly ("TODO" | "DONE" | "CANCELED")[] | undefined {
  if (command.workStatus === undefined) {
    return undefined;
  }
  if (command.includeCanceled === true && command.workStatus !== "CANCELED") {
    return [command.workStatus, "CANCELED"];
  }
  return [command.workStatus];
}

@Injectable()
export class MyTasksQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(MyTaskQueryPort) private readonly myTasks: MyTaskQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(ChangeRecordReadPort)
    private readonly records: ChangeRecordReadPort,
    @Inject(ExternalLinksQueryPort)
    private readonly links: ExternalLinksQueryPort,
    @Inject(TaskGroupMembershipReadPort)
    private readonly membership: TaskGroupMembershipReadPort,
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
    private readonly cursor: AggregateReadCursorService,
  ) {}

  async list(command: MyTasksQueryCommand): Promise<MyTaskPage> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    if (command.scope === "all" && !scope.isSystemAdmin)
      throw new AggregateReadError(
        403,
        "TASK_CENTER_ADMIN_REQUIRED",
        "只有管理员可以查看全部项目任务",
      );
    if (command.scope === "project" && command.projectId === undefined)
      throw new AggregateReadError(
        422,
        "TASK_CENTER_PROJECT_REQUIRED",
        "请先选择项目",
      );
    const limit = command.limit ?? AGGREGATE_READ_PAGE_LIMIT_DEFAULT;
    // 维护中项目不再产出任务卡片（2026-09-30 产品口径）；统计与列表共用收窄后的
    // 集合，避免出现「卡片消失但统计与角标仍计入」的不一致。
    const projectIds = await excludeMaintenanceProjects(
      this.projects,
      command.projectId === undefined
        ? scope.projectIds
        : scope.projectIds.filter(
            (projectId) => projectId === command.projectId,
          ),
    );
    const filterKey = JSON.stringify([
      ...(command.scope === undefined &&
      command.overdue === undefined &&
      command.todayTodo === undefined
        ? []
        : [
            command.scope ?? "mine",
            command.overdue ?? false,
            command.todayTodo ?? false,
          ]),
      command.ownership ?? "ASSIGNEE",
      command.projectId ?? null,
      command.workStatus ?? null,
      command.hasPublishedRecord ?? null,
      command.priority ?? null,
      command.includeCanceled ?? null,
    ]);
    const after = this.decodeCursor(
      command.cursor,
      command.actorUserId,
      filterKey,
    );
    const workStatuses = effectiveWorkStatuses(command);
    const ownership =
      command.scope === undefined
        ? (command.ownership ?? "ASSIGNEE")
        : command.scope === "created"
          ? "CREATOR"
          : "ASSIGNEE";

    const data = await this.unitOfWork.run(async (tx) => {
      const excludedTaskIds = await this.membership.listHistoricalSourceTaskIds(
        tx,
        projectIds,
      );
      const page = await this.myTasks.list(tx, {
        projectIds,
        ...(command.scope === "project" || command.scope === "all"
          ? {}
          : ownership === "CREATOR" || command.scope === "created"
            ? { creatorId: command.actorUserId }
            : { assigneeId: command.actorUserId }),
        ...(command.overdue === undefined ? {} : { overdue: command.overdue }),
        ...(command.todayTodo === undefined
          ? {}
          : { todayTodo: command.todayTodo }),
        limit,
        excludedTaskIds,
        ...(workStatuses === undefined ? {} : { workStatuses }),
        ...(command.hasPublishedRecord === undefined
          ? {}
          : { hasPublishedRecord: command.hasPublishedRecord }),
        ...(command.priority === undefined
          ? {}
          : { priority: command.priority }),
        ...(after === null ? {} : { after }),
      });
      const taskIds = page.items.map((item) => item.taskId);
      const pageProjectIds = [
        ...new Set(page.items.map((item) => item.projectId)),
      ];
      const moduleIds = [...new Set(page.items.map((item) => item.moduleId))];
      const modules = await this.modules.listNames(tx, {
        projectIds: pageProjectIds,
        moduleIds,
      });
      const assignees = await this.users.listByIds(tx, [
        ...new Set(page.items.flatMap((item) => item.assigneeIds)),
      ]);
      const publishedRecordCounts = await this.records.countPublishedByTask(
        tx,
        pageProjectIds,
        taskIds,
      );
      const groupRoles = await this.membership.listGroupRoles(
        tx,
        pageProjectIds,
        taskIds,
      );
      // 裁决修订 D-2：遗留问题来源标记与 R-5 批量读同源（leftover_task_links 存在性）。
      const leftoverSourceTaskIds =
        await this.records.listLeftoverSourceTaskIds(
          tx,
          pageProjectIds,
          taskIds,
        );
      const linkCounts = await this.links.countTaskLinks(
        tx,
        pageProjectIds,
        taskIds,
      );
      const stats = await this.myTasks.stats(tx, {
        projectIds,
        assigneeId: command.actorUserId,
        excludedTaskIds,
      });
      const leftover = await this.myTasks.leftoverEntry(tx, {
        projectIds,
        assigneeId: command.actorUserId,
        excludedTaskIds,
      });
      return {
        page,
        pageProjectIds,
        modules,
        assignees,
        publishedRecordCounts,
        groupRoles,
        leftoverSourceTaskIds,
        linkCounts,
        stats,
        leftover,
      };
    });

    const projects = await this.projects.list(data.pageProjectIds);
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const moduleNameById = new Map(
      data.modules.map((item) => [item.moduleId, item.name]),
    );
    const userById = new Map(data.assignees.map((item) => [item.userId, item]));
    const publishedRecordCountByTask = new Map(
      data.publishedRecordCounts.map((item) => [item.taskId, item.count]),
    );
    const roleByTask = new Map<number, "MAIN" | "SOURCE">();
    const groupIdByTask = new Map<number, number>();
    for (const item of data.groupRoles) {
      if (!roleByTask.has(item.taskId)) {
        roleByTask.set(item.taskId, item.role);
        groupIdByTask.set(item.taskId, item.groupId);
      }
    }
    const linkCountByTask = new Map(
      data.linkCounts.map((item) => [item.taskId, item.count]),
    );
    const leftoverSourceTasks = new Set(data.leftoverSourceTaskIds);

    const items: MyTaskItem[] = data.page.items.map((row) => {
      const projectName = projectNameById.get(row.projectId);
      if (projectName === undefined) {
        throw inconsistentError("任务缺少项目 " + String(row.projectId));
      }
      const moduleName = moduleNameById.get(row.moduleId);
      if (moduleName === undefined) {
        throw inconsistentError("任务缺少模块 " + String(row.moduleId));
      }
      // ADR-040：负责人是集合，卡片与列表要展示全部负责人；assignee 保留为派生标量
      // （等于 assignees[0]），供未改造的调用方继续按单值消费。
      const assigneeRefs = row.assigneeIds.map((assigneeId) => {
        const user = userById.get(assigneeId);
        if (user === undefined) {
          throw inconsistentError("任务负责人不存在 " + String(assigneeId));
        }
        return toUserRef(user);
      });
      const assignee = assigneeRefs[0];
      if (assignee === undefined) {
        throw inconsistentError("任务没有负责人 " + String(row.taskId));
      }
      // 计数为 0 的任务不出现于端口结果，按缺席补 0（裁决修订 D-1）。
      const publishedRecordCount =
        publishedRecordCountByTask.get(row.taskId) ?? 0;
      return {
        taskId: row.taskId,
        code: row.code,
        title: row.title,
        projectId: row.projectId,
        projectName,
        moduleId: row.moduleId,
        moduleName,
        workStatus: row.workStatus,
        lifecycleStatus: row.lifecycleStatus,
        assignee,
        assignees: assigneeRefs,
        updatedAt: row.updatedAt.toISOString(),
        priority: row.priority,
        dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
        completedAt:
          row.completedAt === null ? null : row.completedAt.toISOString(),
        creatorId: row.creatorId,
        githubLinkCount: linkCountByTask.get(row.taskId) ?? 0,
        hasPublishedRecord: publishedRecordCount > 0,
        publishedRecordCount,
        groupRole: roleByTask.get(row.taskId) ?? null,
        groupId: groupIdByTask.get(row.taskId) ?? null,
        hasLeftoverSource: leftoverSourceTasks.has(row.taskId),
      };
    });

    return {
      items,
      nextCursor:
        data.page.next === null
          ? null
          : this.cursor.encode({
              actorUserId: command.actorUserId,
              namespace: "MY_TASKS",
              filterKey,
              afterId: data.page.next.taskId,
              sortKey: encodeTaskListSortKey(data.page.next),
            }),
      hasMore: data.page.hasMore,
      stats: data.stats,
      leftoverCount: data.leftover.count,
      leftoverSample:
        data.leftover.sample === null
          ? null
          : {
              recordCode: data.leftover.sample.recordCode,
              summary:
                data.leftover.sample.contentPrefix +
                (data.leftover.sample.truncated ? "…" : ""),
            },
    };
  }

  /**
   * 解码任务中心游标：必须是带排序键的新格式（requireSortKey），并把载荷文本解析
   * 回排序键元组。旧格式、版本不符或字段非法统一按无效游标 422。
   */
  private decodeCursor(
    cursor: string | undefined,
    actorUserId: number,
    filterKey: string,
  ): TaskListSortKey | null {
    let position: { afterId: number; sortKey: string | null } | null;
    try {
      position = this.cursor.decodeKey(cursor, {
        actorUserId,
        namespace: "MY_TASKS",
        filterKey,
        requireSortKey: true,
      });
    } catch (error) {
      if (error instanceof AggregateReadCursorError) {
        throw invalidCursorError();
      }
      throw error;
    }
    if (position === null) {
      return null;
    }
    const sortKey = parseTaskListSortKey(position.sortKey!);
    if (sortKey === null) {
      throw invalidCursorError();
    }
    return sortKey;
  }
}
