import { Inject, Injectable } from "@nestjs/common";

import {
  AGGREGATE_READ_PAGE_LIMIT_DEFAULT,
  type RecordFeedItem,
  type RecordFeedPage,
} from "@inpulse/api-contract";

import { UserReadPort } from "../../auth/user-read.port.js";
import {
  TimeCursorError,
  TimeCursorService,
  type TimeCursorValue,
} from "../../cursors/time-cursor.js";
import {
  PostgresUnitOfWork,
  type UnitOfWork,
} from "../../database/unit-of-work.js";
import {
  RecordFeedReadPort,
  type RecordFeedSourceFilter,
} from "../change-records/index.js";
import { ModuleReadPort } from "../modules/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectQueryPort,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { validateSearchQuery } from "../search/index.js";
import {
  AggregateReadError,
  invalidCursorError,
} from "./aggregate-read.errors.js";

/** 记录清单游标命名空间；与 CHANGE_RECORDS（单项目列表）/ RECORD_DRAFTS 互不通用。 */
export const RECORD_FEED_CURSOR_NAMESPACE = "RECORD_FEED";

/** 记录清单查询服务的游标实例 token（工厂绑定 RECORD_FEED 命名空间）。 */
export const RECORD_FEED_CURSOR = Symbol("RECORD_FEED_CURSOR");

/**
 * B-3b 跨项目记录清单（GET /change-records）。
 *
 * 授权：只调用 A 的 ProjectAccessQueryPort 取得服务端 AuthorizedProjectScope；
 * projectId 只用于缩小范围，非成员或越权项目收敛为空页而不是 404（不泄露存在性）。
 * 状态：status 是可见性真相；非系统管理员请求 VOID / ALL 收敛为只返回 PUBLISHED
 * 行（不返回 403，也不泄露其他项目是否存在作废记录），VOID 行的全文投影可见性为
 * ADMIN_ONLY，与 record-lifecycle.service.ts 的作废投影口径一致。
 * 检索：q 复用 CHANGE_RECORD 全文投影（PGroonga），最短 2、最长 200 字，归一化
 * 后仍不足 2 字返回 422；检索在 SQL 层完成，不在应用层重排或过滤。
 * 事务：一次请求一个只读事务，不创建命令 UnitOfWork、不取行锁、不写投影。
 * 排序：固定 published_at DESC, id DESC；游标签名绑定 actor、命名空间、projectId
 * （null = 全部项目）与全部筛选摘要，不得跨接口、跨项目或跨筛选复用。
 */
export interface RecordFeedQueryCommand {
  readonly actorUserId: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly projectId?: number;
  readonly status?: "PUBLISHED" | "VOID" | "ALL";
  readonly source?: "ALL" | "MAIN" | "SOURCE" | "MODULE";
  readonly q?: string;
}

function inconsistentError(detail: string): AggregateReadError {
  return new AggregateReadError(
    500,
    "AGGREGATE_READ_INCONSISTENT",
    "聚合读数据不完整，无法完成查询：" + detail,
  );
}

/** 非管理员请求 VOID / ALL 收敛为 PUBLISHED；管理员 ALL 返回两种状态。 */
function resolveStatuses(
  status: RecordFeedQueryCommand["status"],
  isSystemAdmin: boolean,
): readonly ("PUBLISHED" | "VOID")[] {
  if (!isSystemAdmin || status === undefined || status === "PUBLISHED") {
    return ["PUBLISHED"];
  }
  if (status === "VOID") {
    return ["VOID"];
  }
  return ["PUBLISHED", "VOID"];
}

function resolveSource(
  source: RecordFeedQueryCommand["source"],
): RecordFeedSourceFilter | null {
  if (source === undefined || source === "ALL") {
    return null;
  }
  return source;
}

@Injectable()
export class RecordFeedQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(RecordFeedReadPort) private readonly records: RecordFeedReadPort,
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
    @Inject(RECORD_FEED_CURSOR) private readonly cursor: TimeCursorService,
  ) {}

  async list(command: RecordFeedQueryCommand): Promise<RecordFeedPage> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    const limit = command.limit ?? AGGREGATE_READ_PAGE_LIMIT_DEFAULT;
    const statuses = resolveStatuses(command.status, scope.isSystemAdmin);
    const visibilityScopes: readonly ("MEMBER" | "ADMIN_ONLY")[] =
      statuses.includes("VOID") ? ["MEMBER", "ADMIN_ONLY"] : ["MEMBER"];
    const normalizedQuery = this.resolveQuery(command.q);
    const source = resolveSource(command.source);
    const projectId = command.projectId ?? null;
    const filterKey = JSON.stringify([
      projectId,
      statuses.join(","),
      command.source ?? null,
      normalizedQuery,
    ]);
    const after = this.decodeCursor(
      command.cursor,
      command.actorUserId,
      projectId,
      filterKey,
    );
    const projectIds =
      projectId === null
        ? scope.projectIds
        : scope.projectIds.filter((candidate) => candidate === projectId);

    if (projectIds.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const data = await this.unitOfWork.run(async (tx) => {
      const page = await this.records.listFeedPage(tx, {
        projectIds,
        statuses,
        visibilityScopes,
        source,
        normalizedQuery,
        limit,
        after,
      });
      const pageProjectIds = [
        ...new Set(page.items.map((record) => record.projectId)),
      ];
      const moduleIds = [
        ...new Set(page.items.map((record) => record.moduleId)),
      ];
      const modules = await this.modules.listNames(tx, {
        projectIds: pageProjectIds,
        moduleIds,
      });
      const authors = await this.users.listByIds(tx, [
        ...new Set(page.items.map((record) => record.authorId)),
      ]);
      return { page, pageProjectIds, modules, authors };
    });

    const projects = await this.projects.list(data.pageProjectIds);
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const moduleNameById = new Map(
      data.modules.map((item) => [item.moduleId, item.name]),
    );
    const userById = new Map(data.authors.map((item) => [item.userId, item]));

    const items: RecordFeedItem[] = data.page.items.map((record) => {
      const projectName = projectNameById.get(record.projectId);
      if (projectName === undefined) {
        throw inconsistentError("记录缺少项目 " + String(record.projectId));
      }
      const moduleName = moduleNameById.get(record.moduleId);
      if (moduleName === undefined) {
        throw inconsistentError("记录缺少模块 " + String(record.moduleId));
      }
      const author = userById.get(record.authorId);
      return {
        record,
        projectName,
        moduleName,
        author: {
          userId: record.authorId,
          name: record.authorName ?? author?.name ?? "删除用户",
          avatarUrl: author?.avatarUrl ?? null,
        },
      };
    });

    const last = data.page.last;
    return {
      items,
      nextCursor:
        last === null || !data.page.hasMore
          ? null
          : this.cursor.encode({
              actorUserId: command.actorUserId,
              namespace: RECORD_FEED_CURSOR_NAMESPACE,
              projectId,
              afterAt: last.at,
              afterId: last.id,
              filterKey,
            }),
      hasMore: data.page.hasMore,
    };
  }

  /** 归一化并校验 q；nil 表示不启用全文过滤，非法（含归一化后为空）返回 422。 */
  private resolveQuery(q: string | undefined): string | null {
    if (q === undefined) {
      return null;
    }
    const validation = validateSearchQuery(q);
    if (validation.status !== "ok") {
      throw new AggregateReadError(
        422,
        "INVALID_RECORD_FEED_QUERY",
        "检索词无效：" + validation.reason,
      );
    }
    return validation.normalizedQuery;
  }

  private decodeCursor(
    cursor: string | undefined,
    actorUserId: number,
    projectId: number | null,
    filterKey: string,
  ): TimeCursorValue | null {
    try {
      return this.cursor.decode(cursor, {
        actorUserId,
        namespace: RECORD_FEED_CURSOR_NAMESPACE,
        projectId,
        filterKey,
      });
    } catch (error) {
      if (error instanceof TimeCursorError) {
        throw invalidCursorError();
      }
      throw error;
    }
  }
}
