import { Inject, Injectable } from "@nestjs/common";

import {
  RECORD_SUMMARY_ITEM_MAX,
  RECORD_SUMMARY_POINT_MAX,
  type RecordSummaryGap,
  type RecordSummaryIssue,
  type RecordSummaryPoint,
  type RecordSummaryResponse,
  type RecordSummarySection,
} from "@inpulse/api-contract";

import { UserReadPort, type UserRefItem } from "../../auth/user-read.port.js";
import {
  PostgresUnitOfWork,
  type UnitOfWork,
} from "../../database/unit-of-work.js";
import {
  ChangeRecordReadPort,
  type RecordSummaryLeftoverRow,
  type RecordSummaryRecordRow,
} from "../change-records/index.js";
import { ModuleReadPort } from "../modules/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectQueryPort,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { TaskQueryPort, type SummaryTaskRow } from "../tasks/index.js";
import { AggregateReadError } from "./aggregate-read.errors.js";

/** 单条要点 detail 的截断长度；超出追加省略号，不失败。 */
const DETAIL_MAX = 1000;

/**
 * F-33 迭代总结（GET /change-records/summary）。
 *
 * 授权：只调用 A 的 ProjectAccessQueryPort 取得服务端 AuthorizedProjectScope；
 * projectId / memberId 只用于收窄，越权项目收敛为空集而不是 404（不泄露存在性）。
 * 事务：一次请求一个只读事务，不创建命令 UnitOfWork、不取行锁、不写投影。
 * 日界：from / to 是 Asia/Shanghai 自然日，换算在 SQL 内完成，不使用进程时区。
 *
 * 口径：
 * 1. 记录只取 status = PUBLISHED，作废与草稿都不进总结。
 * 2. 已完成任务取 work_status = DONE、completed_at 落在范围内且未失效的任务。
 * 3. 缺口 = 范围内已完成、但所在模块在范围内没有任何 PUBLISHED 记录的任务；
 *    记录对模块的覆盖判定在应用层完成。记录集被截断时
 *    不做缺口判定（宁可少报，不用不完整的覆盖集得出错误结论）。
 * 4. 正文措辞、分节标题与顺序由客户端按本响应的事实渲染，服务端不改写原文。
 */
export interface RecordSummaryQueryCommand {
  readonly actorUserId: number;
  readonly fromDate: string;
  readonly toDate: string;
  readonly projectId?: number;
  readonly memberId?: number;
  readonly groupBy: "PROJECT" | "MEMBER";
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

/** 效果句优先取结果验证，为空退改动说明，仍为空退标题本身；恒非空。 */
function resolveDetail(
  title: string,
  changeSolution: string,
  resultVerification: string,
): string {
  const candidate =
    resultVerification.trim() || changeSolution.trim() || title.trim();
  const collapsed = candidate.replace(/\s+/g, " ").trim();
  return collapsed.length <= DETAIL_MAX
    ? collapsed
    : collapsed.slice(0, DETAIL_MAX - 1) + "…";
}

function addCount(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

@Injectable()
export class RecordSummaryQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(ChangeRecordReadPort)
    private readonly records: ChangeRecordReadPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
  ) {}

  async get(
    command: RecordSummaryQueryCommand,
  ): Promise<RecordSummaryResponse> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    const projectIds =
      command.projectId === undefined
        ? scope.projectIds
        : scope.projectIds.filter(
            (candidate) => candidate === command.projectId,
          );
    if (projectIds.length === 0) {
      return this.emptyResponse(command, []);
    }

    const memberId = command.memberId ?? null;
    const range = { fromDate: command.fromDate, toDate: command.toDate };
    const data = await this.unitOfWork.run(async (tx) => {
      const recordPage = await this.records.summaryRecords(tx, {
        projectIds,
        ...range,
        ...(command.projectId === undefined
          ? {}
          : { projectId: command.projectId }),
        ...(memberId === null ? {} : { authorId: memberId }),
        limit: RECORD_SUMMARY_ITEM_MAX,
      });
      const taskPage = await this.tasks.summaryCompletedTasks(tx, {
        projectIds,
        ...range,
        ...(command.projectId === undefined
          ? {}
          : { projectId: command.projectId }),
        ...(memberId === null ? {} : { assigneeId: memberId }),
        limit: RECORD_SUMMARY_ITEM_MAX,
      });
      const leftoverPage = await this.records.summaryLeftovers(tx, {
        projectIds,
        ...range,
        ...(command.projectId === undefined
          ? {}
          : { projectId: command.projectId }),
        ...(memberId === null ? {} : { authorId: memberId }),
        limit: RECORD_SUMMARY_POINT_MAX,
      });

      const pageProjectIds = [
        ...new Set([
          ...recordPage.items.map((row) => row.projectId),
          ...taskPage.items.map((row) => row.projectId),
          ...leftoverPage.items.map((row) => row.projectId),
        ]),
      ];
      const moduleIds = [
        ...new Set([
          ...recordPage.items.map((row) => row.moduleId),
          ...taskPage.items.map((row) => row.moduleId),
        ]),
      ];
      const userIds = [
        ...new Set([
          ...recordPage.items.map((row) => row.authorId),
          ...taskPage.items
            .map((row) => row.assigneeId)
            .filter((value): value is number => value !== null),
          ...leftoverPage.items.map((row) => row.authorId),
          ...(memberId === null ? [] : [memberId]),
        ]),
      ];
      const taskIds = [
        ...new Set([
          ...recordPage.items
            .map((row) => row.taskId)
            .filter((value): value is number => value !== null),
          ...leftoverPage.items
            .map((row) => row.followupTaskId)
            .filter((value): value is number => value !== null),
        ]),
      ];
      const modules = await this.modules.listNames(tx, {
        projectIds: pageProjectIds,
        moduleIds,
      });
      const users = await this.users.listByIds(tx, userIds);
      const linkedTasks = await this.tasks.listByIds(tx, projectIds, taskIds);
      return {
        recordPage,
        taskPage,
        leftoverPage,
        pageProjectIds,
        moduleIds,
        modules,
        users,
        linkedTasks,
      };
    });

    // 名字必须解析整个授权范围：本期没有任何记录 / 任务的项目（例如刚创建、
    // 还没写记录的项目）不会出现在 pageProjectIds 里，但 scope.projectNames
    // 与分组仍要给出名字，否则合法请求会被判成「聚合读数据不完整」。
    const projects = await this.projects.list(projectIds);
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const moduleNameById = new Map(
      data.modules.map((item) => [item.moduleId, item.name]),
    );
    const userById = new Map(data.users.map((item) => [item.userId, item]));
    const taskCodeById = new Map(
      data.linkedTasks.map((task) => [task.taskId, task.code]),
    );

    const projectNameOf = (projectId: number): string => {
      const name = projectNameById.get(projectId);
      if (name === undefined) {
        throw inconsistentError("总结缺少项目 " + String(projectId));
      }
      return name;
    };
    const moduleNameOf = (moduleId: number): string => {
      const name = moduleNameById.get(moduleId);
      if (name === undefined) {
        throw inconsistentError("总结缺少模块 " + String(moduleId));
      }
      return name;
    };
    const userOf = (userId: number): UserRefItem => {
      const user = userById.get(userId);
      if (user === undefined) {
        throw inconsistentError("总结缺少用户 " + String(userId));
      }
      return user;
    };
    const snapshotUserOf = (
      userId: number,
      snapshotName: string | undefined,
    ): UserRefItem => {
      const user = userById.get(userId);
      const name = snapshotName ?? user?.name;
      if (name === undefined) {
        throw inconsistentError("总结缺少用户 " + String(userId));
      }
      return { userId, name, avatarUrl: user?.avatarUrl ?? null };
    };

    const truncated =
      data.recordPage.hasMore ||
      data.taskPage.hasMore ||
      data.leftoverPage.hasMore;

    const points: RecordSummaryPoint[] = data.recordPage.items.map((row) => ({
      recordId: row.recordId,
      recordCode: row.recordCode,
      projectId: row.projectId,
      projectName: projectNameOf(row.projectId),
      moduleId: row.moduleId,
      moduleName: moduleNameOf(row.moduleId),
      title: row.title,
      detail: resolveDetail(
        row.title,
        row.changeSolution,
        row.resultVerification,
      ),
      author: toUserRef(snapshotUserOf(row.authorId, row.authorName)),
      publishedAt: row.publishedAt.toISOString(),
      taskId: row.taskId,
      taskCode:
        row.taskId === null ? null : (taskCodeById.get(row.taskId) ?? null),
    }));

    const leftovers: RecordSummaryIssue[] = data.leftoverPage.items.map(
      (row: RecordSummaryLeftoverRow) => ({
        leftoverItemId: row.leftoverItemId,
        recordId: row.recordId,
        recordCode: row.recordCode,
        recordTitle: row.recordTitle,
        projectId: row.projectId,
        projectName: projectNameOf(row.projectId),
        author: toUserRef(snapshotUserOf(row.authorId, row.authorName)),
        content: row.content,
        status: row.status,
        followupTaskId: row.followupTaskId,
        followupTaskCode:
          row.followupTaskId === null
            ? null
            : (taskCodeById.get(row.followupTaskId) ?? null),
        publishedAt: row.publishedAt.toISOString(),
      }),
    );

    const gaps = truncated
      ? []
      : this.collectGaps(data.taskPage.items, points, {
          projectNameOf,
          moduleNameOf,
          userOf,
        });

    const totals = {
      projectCount: new Set([
        ...data.recordPage.items.map((row) => row.projectId),
        ...data.taskPage.items.map((row) => row.projectId),
      ]).size,
      moduleCount: new Set([
        ...data.recordPage.items.map((row) => row.moduleId),
        ...data.taskPage.items.map((row) => row.moduleId),
      ]).size,
      recordCount: data.recordPage.total,
      completedTaskCount: data.taskPage.total,
      missingRecordTaskCount: gaps.length,
      leftoverCount: data.leftoverPage.total,
      closedLeftoverCount: data.leftoverPage.closedTotal,
    };

    const sections = this.buildSections({
      groupBy: command.groupBy,
      scopeProjectIds: projectIds,
      projectNameOf,
      userOf,
      records: data.recordPage.items,
      tasks: data.taskPage.items,
    });

    return {
      generatedAt: new Date().toISOString(),
      range: { from: command.fromDate, to: command.toDate },
      groupBy: command.groupBy,
      scope: {
        projectIds: [...projectIds],
        projectNames: projectIds.map((id) => projectNameOf(id)),
        member: memberId === null ? null : toUserRef(userOf(memberId)),
      },
      totals,
      sections,
      points,
      leftovers,
      gaps,
      truncated,
    };
  }

  /** 记录覆盖不到的模块上的已完成任务；保持 completedAt DESC 的输入顺序。 */
  private collectGaps(
    tasks: readonly SummaryTaskRow[],
    points: readonly RecordSummaryPoint[],
    resolve: {
      readonly projectNameOf: (projectId: number) => string;
      readonly moduleNameOf: (moduleId: number) => string;
      readonly userOf: (userId: number) => UserRefItem;
    },
  ): RecordSummaryGap[] {
    const covered = new Set(
      points.map(
        (point) => `M:${String(point.projectId)}:${String(point.moduleId)}`,
      ),
    );
    return tasks
      .filter(
        (task) =>
          !covered.has(`M:${String(task.projectId)}:${String(task.moduleId)}`),
      )
      .map((task) => ({
        taskId: task.taskId,
        taskCode: task.code,
        projectId: task.projectId,
        projectName: resolve.projectNameOf(task.projectId),
        moduleId: task.moduleId,
        moduleName: resolve.moduleNameOf(task.moduleId),
        title: task.title,
        completedAt: task.completedAt.toISOString(),
        assignee:
          task.assigneeId === null
            ? { userId: 0, name: "未指派", avatarUrl: null }
            : toUserRef(resolve.userOf(task.assigneeId)),
      }));
  }

  private buildSections(input: {
    readonly groupBy: "PROJECT" | "MEMBER";
    readonly scopeProjectIds: readonly number[];
    readonly projectNameOf: (projectId: number) => string;
    readonly userOf: (userId: number) => UserRefItem;
    readonly records: readonly RecordSummaryRecordRow[];
    readonly tasks: readonly SummaryTaskRow[];
  }): RecordSummarySection[] {
    if (input.groupBy === "PROJECT") {
      const recordCount = new Map<number, number>();
      const taskCount = new Map<number, number>();
      for (const row of input.records) {
        addCount(recordCount, row.projectId);
      }
      for (const row of input.tasks) {
        addCount(taskCount, row.projectId);
      }
      return input.scopeProjectIds
        .filter((id) => recordCount.has(id) || taskCount.has(id))
        .map((id) => ({
          key: String(id),
          projectId: id,
          member: null,
          recordCount: recordCount.get(id) ?? 0,
          completedTaskCount: taskCount.get(id) ?? 0,
        }));
    }
    const recordCount = new Map<number, number>();
    const taskCount = new Map<number, number>();
    for (const row of input.records) {
      addCount(recordCount, row.authorId);
    }
    for (const row of input.tasks) {
      if (row.assigneeId !== null) {
        addCount(taskCount, row.assigneeId);
      }
    }
    return [...new Set([...recordCount.keys(), ...taskCount.keys()])]
      .sort((left, right) => {
        const leftTotal =
          (recordCount.get(left) ?? 0) + (taskCount.get(left) ?? 0);
        const rightTotal =
          (recordCount.get(right) ?? 0) + (taskCount.get(right) ?? 0);
        return rightTotal - leftTotal || left - right;
      })
      .map((userId) => ({
        key: String(userId),
        projectId: null,
        member: toUserRef(input.userOf(userId)),
        recordCount: recordCount.get(userId) ?? 0,
        completedTaskCount: taskCount.get(userId) ?? 0,
      }));
  }

  private emptyResponse(
    command: RecordSummaryQueryCommand,
    projectNames: readonly string[],
  ): RecordSummaryResponse {
    return {
      generatedAt: new Date().toISOString(),
      range: { from: command.fromDate, to: command.toDate },
      groupBy: command.groupBy,
      scope: { projectIds: [], projectNames: [...projectNames], member: null },
      totals: {
        projectCount: 0,
        moduleCount: 0,
        recordCount: 0,
        completedTaskCount: 0,
        missingRecordTaskCount: 0,
        leftoverCount: 0,
        closedLeftoverCount: 0,
      },
      sections: [],
      points: [],
      leftovers: [],
      gaps: [],
      truncated: false,
    };
  }
}
