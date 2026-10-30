import { Injectable } from "@nestjs/common";
import type { ExternalLinkTargetType } from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import { InvalidGitHubUrlError, normalizeGitHubUrl } from "./github-url.js";
import { githubLinkLabel } from "./github-link-label.js";
import { linkAssociation } from "./external-link-query.port.js";

/** R-4 聚合组记录链接的批量读模型；createdAt 取记录关联时刻 a.created_at。 */
export interface ChangeRecordLinkRow {
  readonly linkId: number;
  readonly recordId: number;
  readonly displayUrl: string;
  readonly kind: "ISSUE" | "PULL_REQUEST" | "COMMIT" | "OTHER";
  readonly repository: string | null;
  readonly externalNumber: string | null;
  readonly externalSha: string | null;
  readonly titleSnapshot: string | null;
  readonly stateSnapshot: string | null;
  readonly createdAt: Date;
}

interface ChangeRecordLinkRowRaw extends Omit<
  ChangeRecordLinkRow,
  "createdAt"
> {
  readonly createdAt: string;
}

/** R-3 任务外部链接计数行。 */
export interface TaskExternalLinkCountRow {
  readonly taskId: number;
  readonly count: number;
}

/** 项目面板聚合的来源标注。 */
export interface ProjectLibrarySource {
  readonly targetType: ExternalLinkTargetType;
  readonly targetId: number;
  readonly title: string;
}

/** 项目面板聚合行：一条链接 + 该项目内保留可见的全部关联来源。 */
export interface ProjectLibraryRow {
  readonly id: number;
  readonly projectId: number;
  readonly normalizedUrl: string;
  readonly isRootRepository: boolean;
  readonly kind: "ISSUE" | "PULL_REQUEST" | "COMMIT" | "OTHER";
  readonly repository: string | null;
  readonly externalNumber: string | null;
  readonly externalSha: string | null;
  readonly sources: readonly ProjectLibrarySource[];
}

interface ProjectLibraryAggregateRow extends Omit<
  ProjectLibraryRow,
  "sources"
> {
  readonly sourceType: ExternalLinkTargetType;
  readonly sourceId: number;
  readonly sourceTitle: string;
}

@Injectable()
export class ExternalLinksRepository {
  async list(
    tx: TransactionContext,
    p: number,
    type: ExternalLinkTargetType,
    id: number,
  ) {
    const a = linkAssociation[type];
    const rows = await tx.sql<
      {
        id: number;
        projectId: number;
        normalizedUrl: string;
        isRootRepository: boolean;
        kind: "ISSUE" | "PULL_REQUEST" | "COMMIT" | "OTHER";
        repository: string | null;
        externalNumber: string | null;
        externalSha: string | null;
      }[]
    >`SELECT ${type === "PROJECT" ? tx.sql`a.is_root_repository` : tx.sql`false`} AS "isRootRepository",l.id,l.project_id AS "projectId",l.normalized_url AS "normalizedUrl",l.kind,l.repository,l.external_number::text AS "externalNumber",l.external_sha AS "externalSha" FROM app.external_links l JOIN ${tx.sql("app." + a.table)} a ON a.project_id=l.project_id AND a.link_id=l.id WHERE a.project_id=${p} AND ${tx.sql("a." + a.column)}=${id} ORDER BY l.id`;
    return rows.map((row) => ({
      ...row,
      ...githubLinkLabel(row.normalizedUrl),
    }));
  }
  /**
   * 项目面板的聚合读取：项目级关联 + 其任务 /    * 已发布记录上的关联，按链接去重后标注全部来源。草稿与已作废记录不聚合
   * （草稿是私域内容，作废在搜索与统计口径上已对成员隐藏）；任务只取「有效
   * 任务」（排除已取消与无效，2026-10-09 用户指示：取消任务后项目面板隐藏
   * 其链接，仅在任务自身入口保留）。只读、不取锁，调用方必须先完成项目授权。
   */
  async listProjectLibrary(
    tx: TransactionContext,
    projectId: number,
  ): Promise<readonly ProjectLibraryRow[]> {
    const rows = await tx.sql<ProjectLibraryAggregateRow[]>`
      SELECT l.id,
             l.project_id AS "projectId",
             l.normalized_url AS "normalizedUrl",
             a.is_root_repository AS "isRootRepository",
             l.kind,
             l.repository,
             l.external_number::text AS "externalNumber",
             l.external_sha AS "externalSha",
             'PROJECT' AS "sourceType",
             p.id AS "sourceId",
             left(p.name, 500) AS "sourceTitle",
             1 AS "sourceRank"
        FROM app.external_links l
        JOIN app.project_external_links a ON a.project_id=l.project_id AND a.link_id=l.id
        JOIN app.projects p ON p.id=a.project_id
       WHERE a.project_id=${projectId}
      UNION ALL
      SELECT l.id,
             l.project_id,
             l.normalized_url,
             false,
             l.kind,
             l.repository,
             l.external_number::text,
             l.external_sha,
             'TASK',
             t.id,
             left(t.title, 500),
             2
        FROM app.external_links l
        JOIN app.task_external_links a ON a.project_id=l.project_id AND a.link_id=l.id
        JOIN app.tasks t ON t.id=a.task_id
       WHERE a.project_id=${projectId}          AND t.deleted_at IS NULL         AND t.lifecycle_status <> 'INVALID'
         AND t.work_status <> 'CANCELED'
      UNION ALL
      SELECT l.id,
             l.project_id,
             l.normalized_url,
             false,
             l.kind,
             l.repository,
             l.external_number::text,
             l.external_sha,
             'CHANGE_RECORD',
             r.id,
             left(r.title, 500),
             4
        FROM app.external_links l
        JOIN app.change_record_external_links a ON a.project_id=l.project_id AND a.link_id=l.id
        JOIN app.change_records r ON r.id=a.change_record_id
       WHERE a.project_id=${projectId} AND r.status='PUBLISHED'
       ORDER BY 1, 12`;
    const merged = new Map<number, ProjectLibraryRow>();
    for (const row of rows) {
      const source: ProjectLibrarySource = {
        targetType: row.sourceType,
        targetId: row.sourceId,
        title: row.sourceTitle,
      };
      const existing = merged.get(row.id);
      merged.set(
        row.id,
        existing === undefined
          ? {
              id: row.id,
              projectId: row.projectId,
              normalizedUrl: row.normalizedUrl,
              isRootRepository: row.isRootRepository,
              kind: row.kind,
              repository: row.repository,
              externalNumber: row.externalNumber,
              externalSha: row.externalSha,
              sources: [source],
            }
          : {
              ...existing,
              isRootRepository:
                existing.isRootRepository || row.isRootRepository,
              sources: [...existing.sources, source],
            },
      );
    }
    return [...merged.values()].map((row) => ({
      ...row,
      ...githubLinkLabel(row.normalizedUrl),
    }));
  }
  async add(
    tx: TransactionContext,
    p: number,
    type: ExternalLinkTargetType,
    id: number,
    actor: number,
    url: string,
    isRootRepository = false,
  ) {
    const value = normalizeGitHubUrl(url);
    if (
      isRootRepository &&
      (type !== "PROJECT" ||
        !/^https:\/\/github[.]com\/[^/?#]+\/[^/?#]+$/.test(value.normalizedUrl))
    )
      throw new InvalidGitHubUrlError(
        "项目根仓库必须是 https://github.com/owner/repository 链接",
      );
    // Persist only the safe canonical URL; discard unapproved query/fragment even in display_url.
    await tx.sql`INSERT INTO app.external_links(project_id,display_url,normalized_url,kind,repository,external_number,external_sha,created_by) VALUES(${p},${value.normalizedUrl},${value.normalizedUrl},${value.kind},${value.repository},${value.externalNumber},${value.externalSha},${actor}) ON CONFLICT(project_id,normalized_url) DO NOTHING`;
    const [link] = await tx.sql<
      { id: number }[]
    >`SELECT id FROM app.external_links WHERE project_id=${p} AND normalized_url=${value.normalizedUrl}`;
    const a = linkAssociation[type];
    const rows =
      type === "PROJECT"
        ? await tx.sql`INSERT INTO app.project_external_links(project_id,link_id) VALUES(${p},${link!.id}) ON CONFLICT DO NOTHING RETURNING link_id`
        : await tx.sql`INSERT INTO ${tx.sql("app." + a.table)}(project_id,${tx.sql(a.column)},link_id) VALUES(${p},${id},${link!.id}) ON CONFLICT DO NOTHING RETURNING link_id`;
    let rootChanged = false;
    if (isRootRepository) {
      await tx.sql`UPDATE app.project_external_links SET is_root_repository = false WHERE project_id=${p} AND link_id<>${link!.id} AND is_root_repository`;
      const updated =
        await tx.sql`UPDATE app.project_external_links SET is_root_repository = true WHERE project_id=${p} AND link_id=${link!.id} AND NOT is_root_repository RETURNING link_id`;
      rootChanged = updated.length > 0;
    }
    return {
      linkId: link!.id,
      changed: rows.length > 0 || rootChanged,
      associatedBefore: rows.length === 0,
      url: value.normalizedUrl,
    };
  }
  async remove(
    tx: TransactionContext,
    p: number,
    type: ExternalLinkTargetType,
    id: number,
    linkId: number,
  ) {
    const a = linkAssociation[type];
    const before = (await this.list(tx, p, type, id)).find(
      (link) => link.id === linkId,
    );
    if (!before) return undefined;
    await tx.sql`DELETE FROM ${tx.sql("app." + a.table)} WHERE project_id=${p} AND ${tx.sql(a.column)}=${id} AND link_id=${linkId}`;
    return {
      linkId,
      url: before.normalizedUrl,
      changed: true,
      associatedBefore: true,
    };
  }
  /**
   * ADR-058：目标被删除时解除其全部链接关联，返回解除的关联条数。
   * 只删关联行，`app.external_links` 链接本体保留，供项目面板聚合与其它目标继续使用。
   */
  async detachTarget(
    tx: TransactionContext,
    p: number,
    type: ExternalLinkTargetType,
    id: number,
  ): Promise<number> {
    const a = linkAssociation[type];
    const rows =
      await tx.sql`DELETE FROM ${tx.sql("app." + a.table)} WHERE project_id=${p} AND ${tx.sql(a.column)}=${id} RETURNING link_id`;
    return rows.length;
  }
  async exists(tx: TransactionContext, p: number, linkId: number) {
    const rows =
      await tx.sql`SELECT id FROM app.external_links WHERE id=${linkId} AND project_id=${p}`;
    return rows.length > 0;
  }
  /**
   * 项目根仓库的 `owner/repository` 快照；未设置或 slug 缺失时返回 null。
   * 只读，供裸 commit SHA 补全使用，授权由调用方在取得目标后完成。
   */
  async findRootRepository(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string | null> {
    const rows = await tx.sql<
      { repository: string | null }[]
    >`SELECT l.repository FROM app.external_links l JOIN app.project_external_links a ON a.project_id=l.project_id AND a.link_id=l.id WHERE a.project_id=${projectId} AND a.is_root_repository`;
    return rows[0]?.repository ?? null;
  }
  /**
   * R-3：批量统计任务上的外部链接数（去重后的 link_id 计数）。
   * projectIds 或 taskIds 为空短路返回空集；只读、不校验项目授权，
   * 调用方必须先取得 AuthorizedProjectScope。
   */
  async countTaskLinks(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly TaskExternalLinkCountRow[]> {
    if (projectIds.length === 0 || taskIds.length === 0) {
      return [];
    }
    const projects = [...projectIds];
    const tasks = [...taskIds];
    return (await tx.sql<TaskExternalLinkCountRow[]>`
      SELECT a.task_id AS "taskId",
             COUNT(DISTINCT a.link_id)::integer AS count
        FROM app.task_external_links a
       WHERE a.project_id = ANY(${projects}::integer[])
         AND a.task_id = ANY(${tasks}::integer[])
       GROUP BY a.task_id
       ORDER BY a.task_id ASC
    `) as unknown as readonly TaskExternalLinkCountRow[];
  }

  /**
   * R-4：批量读取记录上的 GitHub 链接快照。recordIds 为空短路；
   * SQL 只按 project_id 与 change_record_id 过滤，调用方必须先完成项目授权。
   */
  async listChangeRecordLinks(
    tx: TransactionContext,
    projectId: number,
    recordIds: readonly number[],
  ): Promise<readonly ChangeRecordLinkRow[]> {
    if (recordIds.length === 0) {
      return [];
    }
    const ids = [...recordIds];
    const rows = await tx.sql<ChangeRecordLinkRowRaw[]>`
      SELECT l.id AS "linkId",
             a.change_record_id AS "recordId",
             l.display_url AS "displayUrl",
             l.kind AS kind,
             l.repository AS repository,
             l.external_number::text AS "externalNumber",
             l.external_sha AS "externalSha",
             l.title_snapshot AS "titleSnapshot",
             l.state_snapshot AS "stateSnapshot",
             a.created_at AS "createdAt"
        FROM app.change_record_external_links a
        JOIN app.external_links l
          ON l.id = a.link_id
         AND l.project_id = a.project_id
       WHERE a.project_id = ${projectId}
         AND a.change_record_id = ANY(${ids}::integer[])
       ORDER BY a.change_record_id ASC, l.id ASC
    `;
    return rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
    }));
  }
}
