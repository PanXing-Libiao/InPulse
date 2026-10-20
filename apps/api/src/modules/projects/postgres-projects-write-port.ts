import type { TransactionContext } from "../../database/transaction-context.js";
import { projectStatColumns } from "../../stats/card-stat-columns.js";
import {
  ActiveUsersQueryPort,
  type ActiveUserTokenResolution,
  type AddProjectMemberInput,
  type CreateProjectRecordInput,
  type ProjectChangeRecord,
  type ProjectCreatedRecord,
  type ProjectFirstTaskCompletionRecord,
  type ProjectLifecycleStatus,
  type ProjectMaintenanceReopenRecord,
  type ProjectMemberAddedRecord,
  type ProjectMemberIdentity,
  type ProjectMemberRecord,
  type ProjectPurgeCounts,
  type ProjectRecord,
  type ProjectWrapRecord,
  ProjectsWritePort,
} from "./projects-write.port.js";

interface ProjectInsertRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly created_by: number;
  readonly status: "NOT_STARTED";
  readonly row_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MemberInsertRow {
  readonly user_id: number;
  readonly status: "ACTIVE" | "REMOVED";
  readonly role: "MEMBER" | "LEADER";
  readonly joined_at: Date;
}

interface MemberRow {
  readonly membership_id: number;
  readonly project_id: number;
  readonly user_id: number;
  readonly name: string;
  readonly avatar_url: string | null;
  readonly status: "ACTIVE" | "REMOVED";
  readonly role: "MEMBER" | "LEADER";
  readonly joined_at: Date;
  readonly removed_at: Date | null;
}

interface ProjectSummaryRow {
  readonly id: number;
  readonly name: string;
  readonly status: ProjectLifecycleStatus;
  readonly row_version: number;
}

interface ProjectChangeRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly status: ProjectLifecycleStatus;
  readonly firstTaskCompletedAt: Date | null;
  readonly rowVersion: number;
  readonly createdBy: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly memberCount: number;
  readonly activeModuleCount: number;
  readonly activeFeatureCount: number;
  readonly openTaskCount: number;
  readonly completedTaskCount: number;
}

interface PurgeCountRow {
  readonly modules: number;
  readonly features: number;
  readonly tasks: number;
  readonly change_records: number;
  readonly audit_logs: number;
  readonly members: number;
  readonly total: number;
}

/** 项目写适配器；只接收显式 TransactionContext，从不开启事务或使用全局客户端。 */
export class PostgresProjectsWritePort extends ProjectsWritePort {
  async createProject(
    tx: TransactionContext,
    input: CreateProjectRecordInput,
  ): Promise<ProjectCreatedRecord> {
    const rows = (await tx.sql`
      INSERT INTO app.projects (code, name, description, created_by, status)
      VALUES (${input.code}, ${input.name}, ${input.description}, ${input.createdBy}, 'NOT_STARTED')
      RETURNING id,
                code,
                name,
                description,
                created_by,
                status,
                row_version,
                created_at,
                updated_at
    `) as unknown as readonly ProjectInsertRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Project insert returned no row");
    }
    return {
      projectId: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      createdBy: row.created_by,
      status: row.status,
      rowVersion: row.row_version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async addMember(
    tx: TransactionContext,
    input: AddProjectMemberInput,
  ): Promise<ProjectMemberAddedRecord> {
    const role = input.role ?? "MEMBER";
    const rows = (await tx.sql`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${input.projectId}, ${input.userId}, ${role})
      RETURNING user_id, status, role, joined_at
    `) as unknown as readonly MemberInsertRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Project member insert returned no row");
    }
    return {
      userId: row.user_id,
      status: row.status,
      role: row.role,
      joinedAt: new Date(row.joined_at).toISOString(),
    };
  }

  async listMembers(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectMemberRecord[]> {
    const rows = (await tx.sql`
      SELECT pm.id AS "membership_id",
             pm.project_id,
             pm.user_id,
             pm.user_snapshot->>'name' AS name,
             u.avatar_url,
             pm.status,
             pm.role,
             pm.joined_at,
             pm.removed_at
        FROM app.project_members AS pm
        LEFT JOIN app.users AS u ON u.id = pm.user_id
       WHERE pm.project_id = ${input.projectId}
       ORDER BY pm.joined_at ASC, pm.id ASC
    `) as unknown as readonly MemberRow[];
    return rows.map((row) => this.toRecord(row));
  }

  async findProject(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectRecord | undefined> {
    const rows = (await tx.sql`
      SELECT id,
             name,
             status,
             row_version
        FROM app.projects
       WHERE id = ${input.projectId}
       LIMIT 1
    `) as unknown as readonly ProjectSummaryRow[];
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          projectId: row.id,
          name: row.name,
          status: row.status,
          rowVersion: row.row_version,
        };
  }

  async findProjectForChange(
    tx: TransactionContext,
    input: { readonly projectId: number },
    lock = false,
  ): Promise<ProjectChangeRecord | undefined> {
    const rows = (await tx.sql`
      SELECT p.id,
             p.code,
             p.name,
             p.description,
             p.status,
             p.first_task_completed_at AS "firstTaskCompletedAt",
             p.row_version AS "rowVersion",
             p.created_by AS "createdBy",
             p.created_at AS "createdAt",
             p.updated_at AS "updatedAt",
             (
               SELECT COUNT(*)::integer
                 FROM app.project_members m
                WHERE m.project_id = p.id
                  AND m.status = 'ACTIVE'
             ) AS "memberCount",
             ${projectStatColumns(tx.sql, "p")}
        FROM app.projects p
       WHERE p.id = ${input.projectId}
       LIMIT 1
       ${lock ? tx.sql`FOR UPDATE` : tx.sql``}
    `) as unknown as readonly ProjectChangeRow[];
    const row = rows[0];
    return row === undefined ? undefined : this.toChangeRecord(row);
  }

  async updateProjectDetails(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly expectedRowVersion: number;
      readonly name: string;
      readonly description: string;
    },
  ): Promise<ProjectChangeRecord | undefined> {
    const rows = (await tx.sql`
      WITH updated AS (
        UPDATE app.projects
           SET name = ${input.name},
               description = ${input.description},
               updated_at = now(),
               row_version = row_version + 1
         WHERE id = ${input.projectId}
           AND row_version = ${input.expectedRowVersion}
        RETURNING id,
                  code,
                  name,
                  description,
                  status,
                  first_task_completed_at,
                  row_version,
                  created_by,
                  created_at,
                  updated_at
      )
      SELECT u.id,
             u.code,
             u.name,
             u.description,
             u.status,
             u.first_task_completed_at AS "firstTaskCompletedAt",
             u.row_version AS "rowVersion",
             u.created_by AS "createdBy",
             u.created_at AS "createdAt",
             u.updated_at AS "updatedAt",
             (
               SELECT COUNT(*)::integer
                 FROM app.project_members m
                WHERE m.project_id = u.id
                  AND m.status = 'ACTIVE'
             ) AS "memberCount",
             ${projectStatColumns(tx.sql, "u")}
        FROM updated u
    `) as unknown as readonly ProjectChangeRow[];
    const row = rows[0];
    return row === undefined ? undefined : this.toChangeRecord(row);
  }

  async updateProjectStatus(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly expectedRowVersion: number;
      readonly status: ProjectLifecycleStatus;
    },
  ): Promise<ProjectChangeRecord | undefined> {
    const rows = (await tx.sql`
      WITH updated AS (
        UPDATE app.projects
           SET status = ${input.status},
               updated_at = now(),
               row_version = row_version + 1
         WHERE id = ${input.projectId}
           AND row_version = ${input.expectedRowVersion}
        RETURNING id,
                  code,
                  name,
                  description,
                  status,
                  first_task_completed_at,
                  row_version,
                  created_by,
                  created_at,
                  updated_at
      )
      SELECT u.id,
             u.code,
             u.name,
             u.description,
             u.status,
             u.first_task_completed_at AS "firstTaskCompletedAt",
             u.row_version AS "rowVersion",
             u.created_by AS "createdBy",
             u.created_at AS "createdAt",
             u.updated_at AS "updatedAt",
             (
               SELECT COUNT(*)::integer
                 FROM app.project_members m
                WHERE m.project_id = u.id
                  AND m.status = 'ACTIVE'
             ) AS "memberCount",
             ${projectStatColumns(tx.sql, "u")}
        FROM updated u
    `) as unknown as readonly ProjectChangeRow[];
    const row = rows[0];
    return row === undefined ? undefined : this.toChangeRecord(row);
  }

  /**
   * ADR-091：以单条 INSERT ... SELECT 在同一事务内冻结封箱快照。
   * 任务统计沿用项目卡的有效任务口径；只有存在已完成任务且尚无快照时命中。
   * 主键与 ON CONFLICT DO NOTHING 让重复进入维护中不会改写历史快照。
   */
  async createProjectWrap(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly actorId: number;
      readonly sealedAt: Date;
    },
  ): Promise<ProjectWrapRecord | undefined> {
    const rows = (await tx.sql`
      WITH target AS (
        SELECT p.id,
               p.code,
               p.name,
               p.created_at,
               u.name AS actor_name
          FROM app.projects p
          JOIN app.users u ON u.id = ${input.actorId}
         WHERE p.id = ${input.projectId}
      ),
      done_tasks AS (
        SELECT t.id,
               t.completed_at
          FROM app.tasks t
          JOIN target x ON x.id = t.project_id
         WHERE t.deleted_at IS NULL
           AND t.lifecycle_status <> 'INVALID'
           AND t.work_status = 'DONE'
           AND NOT EXISTS (
             SELECT 1
               FROM app.task_group_members gm
               JOIN app.task_groups g
                 ON g.id = gm.group_id
                AND g.project_id = gm.project_id
              WHERE gm.task_id = t.id
                AND g.status = 'ACTIVE'
                AND gm.status = 'ACTIVE'
                AND gm.role = 'SOURCE'
                AND gm.source_kind = 'HISTORICAL'
           )
      ),
      stats AS (
        SELECT target.id,
               target.code,
               target.name,
               target.created_at,
               target.actor_name,
               (SELECT COUNT(*)::integer FROM done_tasks) AS completed_task_count,
               (SELECT MAX(done_tasks.completed_at) FROM done_tasks) AS last_task_completed_at,
               (
                 SELECT COUNT(*)::integer
                   FROM app.change_records cr
                  WHERE cr.project_id = target.id
                    AND cr.status = 'PUBLISHED'
               ) AS published_record_count,
               (
                 SELECT MIN(cr.published_at)
                   FROM app.change_records cr
                  WHERE cr.project_id = target.id
                    AND cr.published_at IS NOT NULL
               ) AS first_record_at,
               (
                 SELECT COUNT(*)::integer
                   FROM app.project_members pm
                  WHERE pm.project_id = target.id
                    AND pm.status = 'ACTIVE'
               ) AS active_member_count,
               (
                 SELECT COUNT(*)::integer
                   FROM app.modules m
                  WHERE m.project_id = target.id
                    AND m.status = 'ACTIVE'
                    AND m.deleted_at IS NULL
               ) AS active_module_count,
               (
                 SELECT COUNT(*)::integer
                   FROM app.features f
                  WHERE f.project_id = target.id
                    AND f.status = 'ACTIVE'
                    AND f.deleted_at IS NULL
               ) AS active_feature_count,
               (
                 SELECT COUNT(*)::integer
                   FROM app.tasks t
                  WHERE t.project_id = target.id
                    AND t.deleted_at IS NULL
                    AND t.lifecycle_status = 'ACTIVE'
                    AND t.work_status NOT IN ('DONE', 'CANCELED')
               ) AS open_task_count,
               GREATEST(
                 1,
                 FLOOR(
                   EXTRACT(EPOCH FROM (${input.sealedAt.toISOString()}::TIMESTAMPTZ - target.created_at))
                   / 86400
                 )::integer + 1
               ) AS duration_days
          FROM target
      )
      INSERT INTO app.project_wraps (
        project_id,
        sealed_at,
        sealed_by,
        sealed_by_snapshot,
        template_version,
        snapshot
      )
      SELECT s.id,
             ${input.sealedAt.toISOString()}::TIMESTAMPTZ,
             ${input.actorId},
             jsonb_build_object('id', ${input.actorId}::integer, 'name', s.actor_name),
             1,
             jsonb_build_object(
               'version', 1,
               'project', jsonb_build_object(
                 'id', s.id,
                 'code', s.code,
                 'name', s.name
               ),
               'stats', jsonb_build_object(
                 'completedTaskCount', s.completed_task_count,
                 'publishedRecordCount', s.published_record_count,
                 'activeMemberCount', s.active_member_count,
                 'activeModuleCount', s.active_module_count,
                 'activeFeatureCount', s.active_feature_count,
                 'openTaskCount', s.open_task_count,
                 'durationDays', s.duration_days,
                 'completionPercent', 100
               ),
               'participants', COALESCE((
                 SELECT jsonb_agg(
                   jsonb_build_object(
                     'userId', pm.user_id,
                     'name', pm.user_snapshot->>'name',
                     'role', pm.role,
                     'completedTaskCount', (
                       SELECT COUNT(DISTINCT t.id)::integer
                         FROM app.task_assignees ta
                         JOIN app.tasks t
                           ON t.id = ta.task_id
                          AND t.project_id = ta.project_id
                        WHERE ta.user_id = pm.user_id
                          AND ta.project_id = s.id
                          AND t.deleted_at IS NULL
                          AND t.lifecycle_status <> 'INVALID'
                          AND t.work_status = 'DONE'
                          AND NOT EXISTS (
                            SELECT 1
                              FROM app.task_group_members gm
                              JOIN app.task_groups g
                                ON g.id = gm.group_id
                               AND g.project_id = gm.project_id
                             WHERE gm.task_id = t.id
                               AND g.status = 'ACTIVE'
                               AND gm.status = 'ACTIVE'
                               AND gm.role = 'SOURCE'
                               AND gm.source_kind = 'HISTORICAL'
                          )
                     )
                   )
                   ORDER BY pm.joined_at ASC, pm.id ASC
                 )
                 FROM app.project_members pm
                WHERE pm.project_id = s.id
                  AND pm.status = 'ACTIVE'
               ), '[]'::jsonb),
               'timeline', jsonb_build_object(
                 'foundedAt', s.created_at,
                 'firstRecordAt', s.first_record_at,
                 'lastTaskCompletedAt', s.last_task_completed_at,
                 'sealedAt', ${input.sealedAt.toISOString()}::TIMESTAMPTZ
               )
             )
        FROM stats s
       WHERE s.completed_task_count > 0
      ON CONFLICT (project_id) DO NOTHING
      RETURNING project_id AS "projectId",
                sealed_at AS "sealedAt",
                template_version AS "templateVersion",
                snapshot
    `) as unknown as readonly {
      readonly projectId: number;
      readonly sealedAt: Date;
      readonly templateVersion: number;
      readonly snapshot: ProjectWrapRecord["snapshot"];
    }[];
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      projectId: row.projectId,
      sealedAt: new Date(row.sealedAt).toISOString(),
      templateVersion: row.templateVersion,
      snapshot: row.snapshot,
    };
  }

  /**
   * ADR-062 / ADR-085：`app_runtime` 对业务表没有 DELETE 权限，物理删除只能经
   * `app.purge_project` 这个 SECURITY DEFINER 窄口完成；函数内部按外键顺序
   * 删除全部下级业务数据与项目行本身，但保留项目自己的审计日志与链头；项目行
   * 不存在时 fail closed。
   */
  async purgeProject(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectPurgeCounts> {
    const rows = (await tx.sql`
      SELECT modules,
             features,
             tasks,
             change_records,
             audit_logs,
             members,
             total
        FROM app.purge_project(${input.projectId})
    `) as unknown as readonly PurgeCountRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("app.purge_project returned no counts");
    }
    return {
      modules: row.modules,
      features: row.features,
      tasks: row.tasks,
      changeRecords: row.change_records,
      retainedAuditLogs: row.audit_logs,
      members: row.members,
      total: row.total,
    };
  }

  /**
   * ADR-035 任务完成粘性置位：first_task_completed_at 取最早一次完成时间且永不回落；
   * 项目处于未开始时同一语句升级为进行中。
   *
   * `app.projects` 的 row_version 触发器要求每次 UPDATE 必须恰好 +1，因此这里用 WHERE
   * 只命中真正需要变更的行：粘性标记已存在且项目不再是未开始时整条语句不写任何行并返回
   * undefined，避免每次任务完成都把项目版本推高一格、连带作废在途的项目编辑 If-Match。
   * 行锁在语句内的 before CTE 中获取，与项目写路径的 project 优先锁序一致。
   */
  async recordFirstTaskCompletion(
    tx: TransactionContext,
    input: { readonly projectId: number; readonly completedAt: Date },
  ): Promise<ProjectFirstTaskCompletionRecord | undefined> {
    const rows = (await tx.sql`
      WITH before AS MATERIALIZED (
        SELECT id, code, name, description, status AS previous_status
          FROM app.projects
         WHERE id = ${input.projectId}
         FOR UPDATE
      ),
      updated AS (
        UPDATE app.projects p
           SET first_task_completed_at = ${input.completedAt.toISOString()}::TIMESTAMPTZ,
               status = CASE
                          WHEN p.status = 'NOT_STARTED' THEN 'ACTIVE'
                          ELSE p.status
                        END,
               row_version = p.row_version + 1,
               updated_at = now()
         WHERE p.id = (SELECT id FROM before)
           AND (p.first_task_completed_at IS NULL OR p.status = 'NOT_STARTED')
        RETURNING p.id,
                  p.code,
                  p.name,
                  p.description,
                  p.status,
                  p.row_version,
                  p.first_task_completed_at
      )
      SELECT u.id,
             u.code,
             u.name,
             u.description,
             u.status,
             u.row_version AS "rowVersion",
             u.first_task_completed_at AS "firstTaskCompletedAt",
             b.previous_status AS "previousStatus"
        FROM updated u
       CROSS JOIN before b
    `) as unknown as readonly {
      readonly id: number;
      readonly code: string;
      readonly name: string;
      readonly description: string;
      readonly status: ProjectLifecycleStatus;
      readonly rowVersion: number;
      readonly firstTaskCompletedAt: Date;
      readonly previousStatus: ProjectLifecycleStatus;
    }[];
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      projectId: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      previousStatus: row.previousStatus,
      status: row.status,
      rowVersion: row.rowVersion,
      firstTaskCompletedAt: new Date(row.firstTaskCompletedAt).toISOString(),
    };
  }

  /**
   * ADR-056 / ADR-057：任务重新变为未收尾后维护中项目重新开工；
   * 非维护中项目不命中行，不产生副作用。
   */
  async reopenMaintenanceProject(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<ProjectMaintenanceReopenRecord | undefined> {
    // 单条条件 UPDATE：非维护中项目不命中任何行、不取行锁，
    // 因此不会与创建路径中 checkProjectForWrite 持有的 FOR SHARE 形成锁升级等待。
    const rows = (await tx.sql`
      UPDATE app.projects p
         SET status = 'ACTIVE',
             row_version = p.row_version + 1,
             updated_at = now()
       WHERE p.id = ${input.projectId}
         AND p.status = 'MAINTENANCE'
      RETURNING p.id,
                p.code,
                p.name,
                p.description,
                p.status,
                p.row_version AS "rowVersion"
    `) as unknown as readonly {
      readonly id: number;
      readonly code: string;
      readonly name: string;
      readonly description: string;
      readonly status: "ACTIVE";
      readonly rowVersion: number;
    }[];
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      projectId: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      rowVersion: row.rowVersion,
    };
  }

  /** ADR-043：进入维护中要求项目下任务全部收尾；ADR-054 起归档链路已下线，口径只是「未完成且未取消」。 */
  async countOpenTasks(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<number> {
    const rows = (await tx.sql`
      SELECT COUNT(*)::integer AS "count"
        FROM app.tasks
       WHERE project_id = ${input.projectId}          AND deleted_at IS NULL         AND lifecycle_status = 'ACTIVE'
         AND work_status NOT IN ('DONE', 'CANCELED')
    `) as unknown as readonly { count: number }[];
    return rows[0]?.count ?? 0;
  }

  async findLatestMember(
    tx: TransactionContext,
    input: ProjectMemberIdentity,
    lock = false,
  ): Promise<ProjectMemberRecord | undefined> {
    const rows = (await tx.sql`
      SELECT pm.id AS "membership_id",
             pm.project_id,
             pm.user_id,
             pm.user_snapshot->>'name' AS name,
             u.avatar_url,
             pm.status,
             pm.role,
             pm.joined_at,
             pm.removed_at
        FROM app.project_members AS pm
        LEFT JOIN app.users AS u ON u.id = pm.user_id
       WHERE pm.project_id = ${input.projectId}
         AND pm.user_id = ${input.userId}
       ORDER BY pm.joined_at DESC, pm.id DESC
       LIMIT 1
       ${lock ? tx.sql`FOR UPDATE OF pm` : tx.sql``}
    `) as unknown as readonly MemberRow[];
    const row = rows[0];
    return row === undefined ? undefined : this.toRecord(row);
  }

  async addMemberHistory(
    tx: TransactionContext,
    input: AddProjectMemberInput,
  ): Promise<ProjectMemberRecord> {
    const role = input.role ?? "MEMBER";
    const inserted = (await tx.sql`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${input.projectId}, ${input.userId}, ${role})
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (inserted.length === 0) {
      throw new Error("Project member history insert returned no row");
    }
    const record = await this.findLatestMember(tx, input);
    if (record === undefined) {
      throw new Error("Project member history insert could not be reloaded");
    }
    return record;
  }

  async removeMember(
    tx: TransactionContext,
    input: ProjectMemberIdentity,
  ): Promise<ProjectMemberRecord | undefined> {
    const current = await this.findLatestMember(tx, input, true);
    if (current === undefined || current.status !== "ACTIVE") {
      return undefined;
    }
    const updated = (await tx.sql`
      UPDATE app.project_members
         SET status = 'REMOVED',
             removed_at = now(),
             role = 'MEMBER'
       WHERE id = ${current.membershipId}
         AND status = 'ACTIVE'
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (updated.length === 0) {
      return undefined;
    }
    return this.findLatestMember(tx, input);
  }

  async setMemberRole(
    tx: TransactionContext,
    input: ProjectMemberIdentity & {
      readonly role: "MEMBER" | "LEADER";
    },
  ): Promise<ProjectMemberRecord | undefined> {
    // ADR-033：project_members_one_leader 是非延迟部分唯一索引，转移组长
    // 必须先把原组长降级为普通成员，再提升目标，否则中途出现两名 LEADER。
    if (input.role === "LEADER") {
      await tx.sql`
        UPDATE app.project_members
           SET role = 'MEMBER'
         WHERE project_id = ${input.projectId}
           AND status = 'ACTIVE'
           AND role = 'LEADER'
           AND user_id <> ${input.userId}
      `;
    }
    const updated = (await tx.sql`
      UPDATE app.project_members
         SET role = ${input.role}
       WHERE project_id = ${input.projectId}
         AND user_id = ${input.userId}
         AND status = 'ACTIVE'
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (updated.length === 0) {
      return undefined;
    }
    return this.findLatestMember(tx, input);
  }

  private toRecord(row: MemberRow): ProjectMemberRecord {
    return {
      membershipId: row.membership_id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      avatarUrl: row.avatar_url,
      status: row.status,
      role: row.role,
      joinedAt: new Date(row.joined_at).toISOString(),
      removedAt:
        row.removed_at === null ? null : new Date(row.removed_at).toISOString(),
    };
  }

  private toChangeRecord(row: ProjectChangeRow): ProjectChangeRecord {
    return {
      projectId: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      firstTaskCompletedAt:
        row.firstTaskCompletedAt === null
          ? null
          : new Date(row.firstTaskCompletedAt).toISOString(),
      rowVersion: row.rowVersion,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      memberCount: row.memberCount,
      stats: {
        activeModuleCount: row.activeModuleCount,
        activeFeatureCount: row.activeFeatureCount,
        openTaskCount: row.openTaskCount,
        completedTaskCount: row.completedTaskCount,
      },
    };
  }
}

/** 项目成员 ACTIVE 校验；只读取，不决定业务流转。 */
export class PostgresActiveUsersQueryPort extends ActiveUsersQueryPort {
  async resolveActiveUsersByTokens(
    tx: TransactionContext,
    normalizedTokens: readonly string[],
  ): Promise<readonly ActiveUserTokenResolution[]> {
    const unique = [...new Set(normalizedTokens)];
    if (unique.length === 0) {
      return [];
    }
    const batchSize = 500;
    const rows: {
      userId: number;
      loginKey: string;
      nameKey: string;
      name: string;
    }[] = [];
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      const slice = unique.slice(offset, offset + batchSize);
      const batch = (await tx.sql<
        { userId: number; loginKey: string; nameKey: string; name: string }[]
      >`SELECT id AS "userId", lower(btrim(login_name)) AS "loginKey", lower(btrim(name)) AS "nameKey", name FROM app.users WHERE status = 'ACTIVE' AND disabled_at IS NULL AND (lower(btrim(login_name)) = ANY(${slice}::text[]) OR lower(btrim(name)) = ANY(${slice}::text[]))`) as unknown as readonly {
        userId: number;
        loginKey: string;
        nameKey: string;
        name: string;
      }[];
      rows.push(...batch);
    }
    const byLogin = new Map<string, { userId: number; name: string }>();
    const byName = new Map<string, { userId: number; name: string }[]>();
    for (const row of rows) {
      byLogin.set(row.loginKey, { userId: row.userId, name: row.name });
      const list = byName.get(row.nameKey);
      if (list === undefined) {
        byName.set(row.nameKey, [{ userId: row.userId, name: row.name }]);
      } else {
        list.push({ userId: row.userId, name: row.name });
      }
    }
    return unique.map((token): ActiveUserTokenResolution => {
      const login = byLogin.get(token);
      if (login !== undefined) {
        return {
          token,
          kind: "resolved",
          userId: login.userId,
          name: login.name,
        };
      }
      const named = byName.get(token) ?? [];
      if (named.length === 0) {
        return { token, kind: "not-found" };
      }
      if (named.length > 1) {
        return { token, kind: "ambiguous" };
      }
      return {
        token,
        kind: "resolved",
        userId: named[0]!.userId,
        name: named[0]!.name,
      };
    });
  }

  async findActiveUserIds(
    tx: TransactionContext,
    userIds: readonly number[],
  ): Promise<readonly number[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = (await tx.sql`
      SELECT id
        FROM app.users
       WHERE id = ANY(${userIds}::integer[])
         AND status = 'ACTIVE'
         AND disabled_at IS NULL
       ORDER BY id ASC
    `) as unknown as readonly { id: number }[];
    return rows.map((row) => row.id);
  }
}
