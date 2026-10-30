import { Inject, Injectable } from "@nestjs/common";

import {
  AGGREGATE_READ_PAGE_LIMIT_DEFAULT,
  type MyRecordDraftItem,
  type MyRecordDraftPage,
} from "@inpulse/api-contract";

import {
  TimeCursorError,
  TimeCursorService,
  type TimeCursorValue,
} from "../../cursors/time-cursor.js";
import {
  PostgresUnitOfWork,
  type UnitOfWork,
} from "../../database/unit-of-work.js";
import { RecordFeedReadPort } from "../change-records/index.js";
import { ModuleReadPort } from "../modules/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectQueryPort,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import {
  AggregateReadError,
  invalidCursorError,
} from "./aggregate-read.errors.js";

/** 我的草稿游标命名空间；与 CHANGE_RECORDS / RECORD_DRAFTS 单项目游标互不通用。 */
export const MY_RECORD_DRAFTS_CURSOR_NAMESPACE = "MY_RECORD_DRAFTS";

/** 我的草稿查询服务的游标实例 token（工厂绑定 MY_RECORD_DRAFTS 命名空间）。 */
export const MY_RECORD_DRAFTS_CURSOR = Symbol("MY_RECORD_DRAFTS_CURSOR");

/**
 * B-3b 我的草稿（GET /me/record-drafts）。
 *
 * 作者恒为当前认证 actor，接口不接受任何他人身份或授权范围参数，因此也不登记
 * 403；projectIds 固定取服务端 AuthorizedProjectScope，被移出项目后其草稿立即
 * 不可见（与项目内草稿列表同一口径）。草稿本体保持 B-1 的 RecordDraftItem 形状，
 * 项目 / 模块名由服务端按本页可见范围批量回填。
 * 事务：一次请求一个只读事务，不创建命令 UnitOfWork、不取行锁、不写投影。
 * 排序：固定 created_at DESC, id DESC；游标签名绑定 actor、命名空间与固定筛选
 * 摘要，不得跨接口或跨 actor 复用。
 */
export interface MyRecordDraftsQueryCommand {
  readonly actorUserId: number;
  readonly cursor?: string;
  readonly limit?: number;
}

function inconsistentError(detail: string): AggregateReadError {
  return new AggregateReadError(
    500,
    "AGGREGATE_READ_INCONSISTENT",
    "聚合读数据不完整，无法完成查询：" + detail,
  );
}

@Injectable()
export class MyRecordDraftsQueryService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ProjectQueryPort) private readonly projects: ProjectQueryPort,
    @Inject(ModuleReadPort) private readonly modules: ModuleReadPort,
    @Inject(RecordFeedReadPort) private readonly records: RecordFeedReadPort,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: UnitOfWork,
    @Inject(MY_RECORD_DRAFTS_CURSOR) private readonly cursor: TimeCursorService,
  ) {}

  async list(command: MyRecordDraftsQueryCommand): Promise<MyRecordDraftPage> {
    const scope = await this.projectAccess.getAuthorizedSearchScope(
      command.actorUserId,
    );
    const limit = command.limit ?? AGGREGATE_READ_PAGE_LIMIT_DEFAULT;
    // 本接口没有筛选参数：固定空筛选摘要，防止游标跨接口复用（命名空间已区分）。
    const filterKey = JSON.stringify([]);
    const after = this.decodeCursor(
      command.cursor,
      command.actorUserId,
      filterKey,
    );

    if (scope.projectIds.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const data = await this.unitOfWork.run(async (tx) => {
      const page = await this.records.listMyDraftsPage(tx, {
        authorId: command.actorUserId,
        projectIds: scope.projectIds,
        limit,
        after,
      });
      const pageProjectIds = [
        ...new Set(page.items.map((draft) => draft.projectId)),
      ];
      const moduleIds = [...new Set(page.items.map((draft) => draft.moduleId))];
      const modules = await this.modules.listNames(tx, {
        projectIds: pageProjectIds,
        moduleIds,
      });
      return { page, pageProjectIds, modules };
    });

    const projects = await this.projects.list(data.pageProjectIds);
    const projectNameById = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const moduleNameById = new Map(
      data.modules.map((item) => [item.moduleId, item.name]),
    );

    const items: MyRecordDraftItem[] = data.page.items.map((draft) => {
      const projectName = projectNameById.get(draft.projectId);
      if (projectName === undefined) {
        throw inconsistentError("草稿缺少项目 " + String(draft.projectId));
      }
      const moduleName = moduleNameById.get(draft.moduleId);
      if (moduleName === undefined) {
        throw inconsistentError("草稿缺少模块 " + String(draft.moduleId));
      }
      return { draft, projectName, moduleName };
    });

    const last = data.page.last;
    return {
      items,
      nextCursor:
        last === null || !data.page.hasMore
          ? null
          : this.cursor.encode({
              actorUserId: command.actorUserId,
              namespace: MY_RECORD_DRAFTS_CURSOR_NAMESPACE,
              projectId: null,
              afterAt: last.at,
              afterId: last.id,
              filterKey,
            }),
      hasMore: data.page.hasMore,
    };
  }

  private decodeCursor(
    cursor: string | undefined,
    actorUserId: number,
    filterKey: string,
  ): TimeCursorValue | null {
    try {
      return this.cursor.decode(cursor, {
        actorUserId,
        namespace: MY_RECORD_DRAFTS_CURSOR_NAMESPACE,
        projectId: null,
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
