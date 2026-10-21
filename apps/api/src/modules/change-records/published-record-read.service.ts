import { Inject, Injectable } from "@nestjs/common";
import {
  RECORD_PAGE_LIMIT_DEFAULT,
  type ReadableRecordPage,
} from "@inpulse/api-contract";
import {
  TimeCursorError,
  TimeCursorService,
  type TimeCursorValue,
} from "../../cursors/time-cursor.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import { PublishedRecordRepository } from "./published-record.repository.js";
import { RecordDraftError } from "./record-drafts.service.js";

const RECORD_LIST_NAMESPACE = "CHANGE_RECORDS";

/** F-18 记录列表查询：status 默认 PUBLISHED，VOID 仅系统管理员；分页见 B-1。 */
export interface PublishedRecordListCommand {
  readonly status?: "PUBLISHED" | "VOID";
  readonly cursor?: string;
  readonly limit?: number;
}

const missing = () =>
  new RecordDraftError(
    404,
    "CHANGE_RECORD_NOT_FOUND",
    "记录或版本不存在或无法访问",
  );

const invalidCursor = () =>
  new RecordDraftError(
    422,
    "INVALID_CURSOR",
    "游标无效、已过期或与当前筛选条件不匹配",
  );

@Injectable()
export class PublishedRecordReadService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(PublishedRecordRepository)
    private readonly repository: PublishedRecordRepository,
    @Inject(TimeCursorService) private readonly cursor: TimeCursorService,
  ) {}
  /**
   * 正式记录列表分页（B-1 / C-006）：items / nextCursor / hasMore，limit 1..100
   * 默认 20；签名游标绑定 actor、命名空间与项目，15 分钟过期，失效统一 422。
   */
  async list(
    actorId: number,
    projectId: number,
    command: PublishedRecordListCommand,
  ): Promise<ReadableRecordPage> {
    const scope = await this.access.getAuthorizedSearchScope(actorId);
    if (!scope.projectIds.includes(projectId)) throw missing();
    const status = command.status ?? "PUBLISHED";
    if (status === "VOID" && !scope.isSystemAdmin) throw missing();
    const limit = command.limit ?? RECORD_PAGE_LIMIT_DEFAULT;
    const after = this.decodeCursor(command.cursor, actorId, projectId);
    return this.uow.run(async (tx) => {
      const page =
        status === "VOID"
          ? await this.repository.listVoidedPage(tx, {
              projectId,
              limit,
              after,
            })
          : await this.repository.listPublishedPage(tx, {
              projectId,
              limit,
              after,
            });
      return {
        items: page.items,
        hasMore: page.hasMore,
        nextCursor:
          page.last === null
            ? null
            : this.cursor.encode({
                actorUserId: actorId,
                namespace: RECORD_LIST_NAMESPACE,
                projectId,
                afterAt: page.last.at,
                afterId: page.last.id,
              }),
      };
    });
  }
  async read(
    actorId: number,
    projectId: number,
    recordId?: number,
    versions = false,
    versionNo?: number,
  ) {
    const scope = await this.access.getAuthorizedSearchScope(actorId);
    if (!scope.projectIds.includes(projectId)) throw missing();
    if (recordId === undefined) throw missing();
    return this.uow.run(async (tx) => {
      const record =
        (await this.repository.find(tx, projectId, recordId)) ??
        (scope.isSystemAdmin
          ? await this.repository.findVoided(tx, projectId, recordId)
          : undefined);
      if (!record) throw missing();
      if (!versions) return record;
      const items = await this.repository.versions(tx, record, versionNo);
      if (versionNo !== undefined) {
        if (!items[0]) throw missing();
        return items[0];
      }
      return { items };
    });
  }
  private decodeCursor(
    cursor: string | undefined,
    actorId: number,
    projectId: number,
  ): TimeCursorValue | null {
    try {
      return this.cursor.decode(cursor, {
        actorUserId: actorId,
        namespace: RECORD_LIST_NAMESPACE,
        projectId,
      });
    } catch (error) {
      if (error instanceof TimeCursorError) throw invalidCursor();
      throw error;
    }
  }
}
