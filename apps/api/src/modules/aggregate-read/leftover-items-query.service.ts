import { Inject, Injectable } from "@nestjs/common";

import {
  AGGREGATE_READ_PAGE_LIMIT_DEFAULT,
  type AggregateTaskRef,
  type LeftoverItemPage,
  type LeftoverListItem,
} from "@inpulse/api-contract";

import { UserReadPort } from "../../auth/user-read.port.js";
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
import { TaskQueryPort, type TaskReadModel } from "../tasks/index.js";
import {
  AggregateReadCursorError,
  AggregateReadCursorService,
} from "./aggregate-read-cursor.js";
import {
  AggregateReadError,
  invalidCursorError,
} from "./aggregate-read.errors.js";

/**
 * R-6 遗留问题列表（F-20）聚合读。
 *
 * 授权：只调用 A 的 ProjectAccessQueryPort 取得服务端 AuthorizedProjectScope；
 * projectId 只用于缩小范围，非成员或越权项目收敛为空页而不是 404（不泄露存在性）。
 * 事务：一次请求一个只读事务，不创建命令 UnitOfWork、不取行锁、不写投影。
 * 排序：固定 leftoverItemId DESC；游标签名绑定 actor 与 [projectId, bucket]。
 * OPEN 分桶只含父记录 PUBLISHED 且遗留项 ACTIVE 的未处理项；CLOSED 分桶含
 * CONVERTED / RESOLVED（已处理）以及父记录 VOID 的 VOIDED（已作废）项。
 */
export interface LeftoverItemsQueryCommand {
  readonly actorUserId: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectId?: number;
  readonly bucket?: "OPEN" | "CLOSED";
}

function inconsistentError(detail: string): AggregateReadError {
  return new AggregateReadError(
    500,
    "AGGREGATE_READ_INCONSISTENT",
    "聚合读数据不完整，无法完成查询：" + detail,
  );
}

@Injectable()
export class LeftoverItemsQueryService {
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
    private readonly cursor: AggregateReadCursorService,
  ) {}

  async list(command: LeftoverItemsQueryCommand): Promise<LeftoverItemPage> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    const limit = command.limit ?? AGGREGATE_READ_PAGE_LIMIT_DEFAULT;
    const projectIds =
      command.projectId === undefined
        ? scope.projectIds
        : scope.projectIds.filter(
            (projectId) => projectId === command.projectId,
          );
    const filterKey = JSON.stringify([
      command.projectId ?? null,
      command.bucket ?? null,
    ]);
    const afterLeftoverItemId = this.decodeCursor(
      command.cursor,
      command.actorUserId,
      filterKey,
    );

    const data = await this.unitOfWork.run(async (tx) => {
      const page = await this.records.listLeftovers(tx, {
        projectIds,
        limit,
        ...(command.bucket === undefined ? {} : { bucket: command.bucket }),
        ...(afterLeftoverItemId === null ? {} : { afterLeftoverItemId }),
      });
      const pageProjectIds = [
        ...new Set(page.items.map((item) => item.projectId)),
      ];
      const moduleIds = [...new Set(page.items.map((item) => item.moduleId))];
      const taskIds = [
        ...new Set(
          page.items
            .flatMap((item) => [item.sourceTaskId, item.followupTaskId])
            .filter((taskId): taskId is number => taskId !== null),
        ),
      ];
      const modules = await this.modules.listNames(tx, {
        projectIds: pageProjectIds,
        moduleIds,
      });
      const tasks = await this.tasks.listByIds(tx, pageProjectIds, taskIds);
      const authors = await this.users.listByIds(tx, [
        ...new Set(page.items.map((item) => item.authorId)),
      ]);
      return { page, pageProjectIds, modules, tasks, authors };
    });

    const projects = await this.projects.list(data.pageProjectIds);
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const moduleNameById = new Map(
      data.modules.map((item) => [item.moduleId, item.name]),
    );
    const taskById = new Map(data.tasks.map((task) => [task.taskId, task]));
    const userById = new Map(data.authors.map((item) => [item.userId, item]));

    const items: LeftoverListItem[] = data.page.items.map((row) => {
      const projectName = projectNameById.get(row.projectId);
      if (projectName === undefined) {
        throw inconsistentError("遗留项缺少项目 " + String(row.projectId));
      }
      const moduleName = moduleNameById.get(row.moduleId);
      if (moduleName === undefined) {
        throw inconsistentError("遗留项缺少模块 " + String(row.moduleId));
      }
      const author = userById.get(row.authorId);
      return {
        leftoverItemId: row.leftoverItemId,
        recordId: row.recordId,
        recordCode: row.recordCode,
        recordTitle: row.recordTitle,
        projectId: row.projectId,
        projectName,
        moduleId: row.moduleId,
        moduleName,
        author: {
          userId: row.authorId,
          name: row.authorName ?? author?.name ?? "删除用户",
          avatarUrl: author?.avatarUrl ?? null,
        },
        publishedAt: row.publishedAt.toISOString(),
        content: row.content,
        status: row.status,
        sourceTask: this.toTaskRef(row.sourceTaskId, taskById),
        followupTask: this.toTaskRef(row.followupTaskId, taskById),
      };
    });

    return {
      items,
      nextCursor:
        data.page.nextLeftoverItemId === null
          ? null
          : this.cursor.encode({
              actorUserId: command.actorUserId,
              namespace: "LEFTOVER_ITEMS",
              filterKey,
              afterId: data.page.nextLeftoverItemId,
            }),
      hasMore: data.page.hasMore,
    };
  }

  private toTaskRef(
    taskId: number | null,
    taskById: ReadonlyMap<number, TaskReadModel>,
  ): AggregateTaskRef | null {
    if (taskId === null) {
      return null;
    }
    const task = taskById.get(taskId);
    if (task === undefined) {
      throw inconsistentError("遗留项缺少对应任务 " + String(taskId));
    }
    return {
      taskId: task.taskId,
      code: task.code,
      projectId: task.projectId,
      moduleId: task.moduleId,
    };
  }

  private decodeCursor(
    cursor: string | undefined,
    actorUserId: number,
    filterKey: string,
  ): number | null {
    try {
      return this.cursor.decode(cursor, {
        actorUserId,
        namespace: "LEFTOVER_ITEMS",
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
