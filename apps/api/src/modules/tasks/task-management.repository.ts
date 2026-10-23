import { Injectable } from "@nestjs/common";
import {
  taskItemSchema,
  moduleTaskItemSchema,
  type ModuleTaskItem,
  type TaskItem,
  type TaskEditRequest,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import { taskListOrderBy } from "./task-list-order.js";

export type TaskRecord = TaskItem | ModuleTaskItem;
export interface TaskStatusHistoryRow {
  readonly id: string;
  readonly fromWorkStatus: "TODO" | "DONE" | "CANCELED" | null;
  readonly toWorkStatus: "TODO" | "DONE" | "CANCELED";
  readonly completedAtSnapshot: string | null;
  readonly completionNoteSnapshot: string | null;
  readonly reason: string | null;
  readonly changedBy: number;
  readonly changedByName: string;
  readonly changedAt: string;
}
type Row = Omit<TaskRecord, "createdAt" | "updatedAt" | "dueAt"> & {
  createdAt: Date;
  updatedAt: Date;
  dueAt: Date | null;
  impactFeatureIds: number[];
};
const dto = (row: Row): TaskRecord =>
  (row.featureId === null ? moduleTaskItemSchema : taskItemSchema).parse({
    ...Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => row.featureId === null || key !== "impactFeatureIds",
      ),
    ),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    dueAt: row.dueAt === null ? null : new Date(row.dueAt).toISOString(),
  });

export interface TaskScope {
  projectId: number;
  moduleId: number;
  featureId: number | null;
}

/** ADR-096：物理删除后的结果快照与影响面计数。 */
export interface TaskHardDeletedRow {
  id: number;
  projectId: number;
  moduleId: number;
  featureId: number | null;
  code: string;
  title: string;
  workStatus: "TODO" | "DONE" | "CANCELED";
  deletedAt: string;
  deletedRecordCount: number;
  removedLinkCount: number;
  detachedGroupRole: "MAIN" | "SOURCE" | null;
  detachedGroupId: number | null;
}

@Injectable()
export class TaskManagementRepository {
  async history(
    tx: TransactionContext,
    scope: TaskScope,
    taskId: number,
  ): Promise<TaskStatusHistoryRow[]> {
    const rows = await tx.sql<
      {
        id: string;
        fromWorkStatus: "TODO" | "DONE" | "CANCELED" | null;
        toWorkStatus: "TODO" | "DONE" | "CANCELED";
        completedAtSnapshot: Date | null;
        completionNoteSnapshot: string | null;
        reason: string | null;
        changedBy: number;
        changedByName: string;
        changedAt: Date;
      }[]
    >`
      SELECT id::text, from_work_status AS "fromWorkStatus", to_work_status AS "toWorkStatus",
        completed_at_snapshot AS "completedAtSnapshot", completion_note_snapshot AS "completionNoteSnapshot",
        reason, changed_by AS "changedBy",
        changed_by_snapshot->>'name' AS "changedByName", changed_at AS "changedAt"
      FROM app.task_status_history WHERE task_id=${taskId} AND project_id=${scope.projectId} ORDER BY app.task_status_history.id`;
    return rows.map((row) => ({
      ...row,
      completedAtSnapshot:
        row.completedAtSnapshot === null
          ? null
          : new Date(row.completedAtSnapshot).toISOString(),
      changedAt: new Date(row.changedAt).toISOString(),
    }));
  }
  async transition(
    tx: TransactionContext,
    current: TaskRecord,
    actorId: number,
    to: TaskRecord["workStatus"],
    completionNote: string | null,
    reason: string | null,
  ) {
    // The service has validated the transition under the task lock. Preserve DB timestamp
    // precision in SQL; transaction-start now() can predate a concurrent completed transition.
    const rows = await tx.sql`
      WITH previous AS MATERIALIZED (
        SELECT * FROM app.tasks WHERE id=${current.id} AND project_id=${current.projectId}
      ), stamp AS MATERIALIZED (SELECT GREATEST(clock_timestamp(), updated_at) AS at FROM previous),
      updated AS (
        UPDATE app.tasks SET work_status=${to}, completion_note=${completionNote},
          completed_at=CASE WHEN ${to}='DONE' THEN (SELECT at FROM stamp) ELSE NULL END,
          updated_at=(SELECT at FROM stamp), row_version=row_version+1
        WHERE id=${current.id} AND project_id=${current.projectId} AND row_version=${current.rowVersion}
          AND work_status=${current.workStatus} AND lifecycle_status='ACTIVE'           AND deleted_at IS NULL        RETURNING *
      )
      INSERT INTO app.task_status_history(task_id,project_id,from_work_status,to_work_status,
        completed_at_snapshot,completion_note_snapshot,reason,changed_by,changed_at)
      SELECT u.id,u.project_id,p.work_status,u.work_status,
        CASE WHEN u.work_status='DONE' THEN u.completed_at WHEN p.work_status='DONE' THEN p.completed_at ELSE NULL END,
        CASE WHEN u.work_status='DONE' THEN u.completion_note WHEN p.work_status='DONE' THEN p.completion_note ELSE NULL END,
        ${reason},${actorId},u.updated_at FROM updated u CROSS JOIN previous p RETURNING id`;
    return rows.length ? this.find(tx, current, current.id) : undefined;
  }
  async impacts(tx: TransactionContext, scope: TaskScope, taskId: number) {
    const rows = await tx.sql<
      {
        taskId: number;
        featureId: number;
        moduleId: number;
        projectId: number;
        relationType: string;
        createdAt: Date;
      }[]
    >`SELECT task_id AS "taskId",feature_id AS "featureId",module_id AS "moduleId",project_id AS "projectId",relation_type AS "relationType",created_at AS "createdAt" FROM app.task_feature_impacts WHERE task_id=${taskId} AND project_id=${scope.projectId} AND module_id=${scope.moduleId} ORDER BY feature_id`;
    return rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }
  async replaceImpacts(
    tx: TransactionContext,
    task: TaskRecord,
    target: readonly number[],
  ): Promise<void> {
    const previous = await this.impacts(tx, task, task.id);
    for (const relation of previous)
      if (!target.includes(relation.featureId))
        await tx.sql`DELETE FROM app.task_feature_impacts WHERE task_id=${task.id} AND feature_id=${relation.featureId} AND project_id=${task.projectId} AND module_id=${task.moduleId}`;
    for (const featureId of target)
      if (!previous.some((row) => row.featureId === featureId))
        await tx.sql`INSERT INTO app.task_feature_impacts (task_id,feature_id,module_id,project_id) VALUES (${task.id},${featureId},${task.moduleId},${task.projectId})`;
  }
  async list(tx: TransactionContext, scope: TaskScope): Promise<TaskRecord[]> {
    const rows = await tx.sql<
      Row[]
    >`SELECT t.id, t.project_id AS "projectId", t.module_id AS "moduleId", t.feature_id AS "featureId", t.scope_type AS "scopeType", t.code, t.title, t.description, a.ids AS "assigneeIds", a.ids[1] AS "assigneeId", t.creator_id AS "creatorId", t.creator_snapshot->>'name' AS "creatorName", a.names AS "assigneeNames", t.priority, t.work_status AS "workStatus", t.lifecycle_status AS "lifecycleStatus", t.due_at AS "dueAt", t.row_version AS "rowVersion", t.created_at AS "createdAt", t.updated_at AS "updatedAt", ARRAY(SELECT i.feature_id FROM app.task_feature_impacts i JOIN app.features x ON x.id = i.feature_id AND x.deleted_at IS NULL WHERE i.task_id=t.id ORDER BY i.feature_id) AS "impactFeatureIds" FROM app.tasks t LEFT JOIN LATERAL (SELECT array_agg(ta.user_id ORDER BY ta.user_id) AS ids, array_agg(ta.user_snapshot->>'name' ORDER BY ta.user_id) AS names FROM app.task_assignees ta WHERE ta.task_id=t.id) AS a ON true WHERE t.deleted_at IS NULL AND t.project_id = ${scope.projectId} AND t.module_id = ${scope.moduleId} AND ${scope.featureId === null ? tx.sql`t.scope_type = 'MODULE' AND t.feature_id IS NULL` : tx.sql`((t.feature_id = ${scope.featureId} AND t.scope_type = 'FEATURE') OR (t.scope_type = 'MODULE' AND EXISTS (SELECT 1 FROM app.task_feature_impacts i WHERE i.task_id = t.id AND i.feature_id = ${scope.featureId})))`} ORDER BY ${taskListOrderBy(tx.sql)}`;
    return rows.map(dto);
  }
  async find(
    tx: TransactionContext,
    scope: TaskScope,
    taskId: number,
    lock = false,
  ): Promise<TaskRecord | undefined> {
    const [row] = await tx.sql<
      Row[]
    >`SELECT id, project_id AS "projectId", module_id AS "moduleId", feature_id AS "featureId", scope_type AS "scopeType", code, title, description, (SELECT array_agg(ta.user_id ORDER BY ta.user_id) FROM app.task_assignees ta WHERE ta.task_id=app.tasks.id) AS "assigneeIds", (SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id=app.tasks.id) AS "assigneeId", (SELECT array_agg(ta.user_snapshot->>'name' ORDER BY ta.user_id) FROM app.task_assignees ta WHERE ta.task_id=app.tasks.id) AS "assigneeNames", creator_id AS "creatorId", creator_snapshot->>'name' AS "creatorName", priority, work_status AS "workStatus", lifecycle_status AS "lifecycleStatus", due_at AS "dueAt", row_version AS "rowVersion", created_at AS "createdAt", updated_at AS "updatedAt", ARRAY(SELECT i.feature_id FROM app.task_feature_impacts i JOIN app.features x ON x.id = i.feature_id AND x.deleted_at IS NULL WHERE i.task_id=app.tasks.id ORDER BY i.feature_id) AS "impactFeatureIds" FROM app.tasks WHERE deleted_at IS NULL AND project_id = ${scope.projectId} AND module_id = ${scope.moduleId} AND ${scope.featureId === null ? tx.sql`scope_type = 'MODULE' AND feature_id IS NULL` : tx.sql`scope_type = 'FEATURE' AND feature_id = ${scope.featureId}`} AND id = ${taskId} ${lock ? tx.sql`FOR UPDATE` : tx.sql``}`;
    return row ? dto(row) : undefined;
  }
  async create(
    tx: TransactionContext,
    scope: TaskScope,
    actorId: number,
    code: string,
    edit: TaskEditRequest,
  ): Promise<TaskRecord> {
    const [row] = await tx.sql<
      { id: number }[]
    >`INSERT INTO app.tasks (project_id, module_id, feature_id, scope_type, code, title, description, creator_id, priority, due_at, work_status, lifecycle_status) VALUES (${scope.projectId}, ${scope.moduleId}, ${scope.featureId}, ${scope.featureId === null ? "MODULE" : "FEATURE"}, ${code}, ${edit.title}, ${edit.description}, ${actorId}, ${edit.priority}, ${edit.dueAt}, 'TODO', 'ACTIVE') RETURNING id`;
    await this.replaceAssignees(tx, scope.projectId, row!.id, edit.assigneeIds);
    await tx.sql`INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, changed_by) VALUES (${row!.id}, ${scope.projectId}, NULL, 'TODO', ${actorId})`;
    return (await this.find(tx, scope, row!.id))!;
  }
  async update(
    tx: TransactionContext,
    current: TaskRecord,
    edit: TaskEditRequest,
  ): Promise<TaskRecord | undefined> {
    const rows =
      await tx.sql`UPDATE app.tasks SET title = ${edit.title}, description = ${edit.description}, priority = ${edit.priority}, due_at = ${edit.dueAt}, row_version = row_version + 1, updated_at = now() WHERE id = ${current.id} AND project_id = ${current.projectId} AND row_version = ${current.rowVersion} AND deleted_at IS NULL RETURNING id`;
    if (rows.length === 0) return undefined;
    await this.replaceAssignees(
      tx,
      current.projectId,
      current.id,
      edit.assigneeIds,
      current.assigneeIds,
    );
    return this.find(tx, current, current.id);
  }
  /**
   * ADR-096：任务物理删除。任务本体、状态历史、负责人、影响关系、外部链接关联、
   * 聚合组关系与该任务全部迭代记录由数据库窄口函数在同一事务内删除。
   */
  async hardDelete(
    tx: TransactionContext,
    current: Pick<TaskRecord, "id" | "projectId">,
    expectedRowVersion: number,
    actorId: number,
    reason: string,
  ): Promise<TaskHardDeletedRow | undefined> {
    const rows = await tx.sql<{ result: TaskHardDeletedRow | null }[]>`
      SELECT app.hard_delete_task(
        ${current.projectId}, ${current.id}, ${expectedRowVersion},
        ${actorId}, ${reason}
      ) AS result
    `;
    return rows[0]?.result ?? undefined;
  }
  /**
   * 负责人集合的唯一写入路径：先删后插（app_runtime 不持有 UPDATE）。
   *
   * 集合未变化时整体跳过：已完成任务允许保留历史已移除成员的负责人，
   * 重写会触发 task_assignees_active_assignee 校验并把这些任务锁死（功能设计 §824）。
   */
  private async replaceAssignees(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
    target: readonly number[],
    current: readonly number[] = [],
  ): Promise<void> {
    if (
      current.length === target.length &&
      current.every((userId, index) => userId === target[index])
    )
      return;
    await tx.sql`DELETE FROM app.task_assignees WHERE task_id = ${taskId} AND project_id = ${projectId}`;
    for (const userId of target)
      await tx.sql`INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES (${taskId}, ${userId}, ${projectId})`;
  }
}
