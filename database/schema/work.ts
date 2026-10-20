import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";
import { appSchema } from "./shared.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const modules = appSchema.table(
  "modules",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull().default("NORMAL"),
    /** ADR-044：模块层面下线归档，`status` 只有 `ACTIVE`（见 modules_status_check）。 */
    status: text("status").notNull().default("ACTIVE"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    /** ADR-044：归档时代的只读历史列，模块侧恒为空（见 modules_archived_at_null_check）。 */
    archivedAt: timestamptz("archived_at"),
    /**
     * ADR-059 软删除：非空表示模块已退出全部可见范围。功能、任务、迭代记录与
     * 审计链全部保留，只从列表、详情、统计、搜索与读写路径中排除。
     */
    deletedAt: timestamptz("deleted_at"),
    /** 执行删除的用户；与 deleted_at 成对写入（见 modules_deleted_state_check）。 */
    deletedBy: integer("deleted_by"),
    deletedBySnapshot: jsonb("deleted_by_snapshot"),
  },
  (table) => [
    unique("modules_project_code_unique").on(table.projectId, table.code),
    check(
      "modules_code_check",
      sql.raw(
        "code ~ '^[A-Z][A-Z0-9_]{1,31}-M-[1-9][0-9]*$' AND length(code) <= 64",
      ),
    ),
    unique("modules_id_project_unique").on(table.id, table.projectId),
    foreignKey({
      name: "modules_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    uniqueIndex("modules_name_project_unique").on(
      table.projectId,
      sql.raw("lower(btrim(name))"),
    ),
    uniqueIndex("modules_one_unclassified_unique")
      .on(table.projectId)
      .where(sql.raw("kind = 'UNCLASSIFIED'")),
    index("modules_project_order_idx").on(
      table.projectId,
      table.sortOrder,
      table.id,
    ),
    check(
      "modules_name_check",
      sql.raw("length(btrim(name)) BETWEEN 1 AND 200"),
    ),
    check("modules_description_check", sql.raw("length(description) <= 20000")),
    check("modules_kind_check", sql.raw("kind IN ('NORMAL', 'UNCLASSIFIED')")),
    check("modules_status_check", sql.raw("status = 'ACTIVE'")),
    check("modules_sort_order_check", sql.raw("sort_order >= 0")),
    check("modules_row_version_check", sql.raw("row_version > 0")),
    check("modules_archived_at_null_check", sql.raw("archived_at IS NULL")),
    check(
      "modules_deleted_state_check",
      sql.raw("(deleted_at IS NULL) = (deleted_by IS NULL)"),
    ),
  ],
);

export const features = appSchema.table(
  "features",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    moduleId: integer("module_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    currentBehavior: text("current_behavior").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
    tags: text("tags").array().notNull().default(sql.raw("'{}'::text[]")),
    /** ADR-045：功能层面下线归档，`status` 只有 `ACTIVE`（见 features_status_check）。 */
    status: text("status").notNull().default("ACTIVE"),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    /** ADR-045：归档时代的只读历史列，功能侧恒为空（见 features_archived_at_null_check）。 */
    archivedAt: timestamptz("archived_at"),
    /**
     * ADR-059 软删除：非空表示功能已退出全部可见范围。任务、迭代记录与审计链
     * 全部保留，只从列表、详情、统计、搜索与读写路径中排除。
     */
    deletedAt: timestamptz("deleted_at"),
    /** 执行删除的用户；与 deleted_at 成对写入（见 features_deleted_state_check）。 */
    deletedBy: integer("deleted_by"),
    deletedBySnapshot: jsonb("deleted_by_snapshot"),
  },
  (table) => [
    unique("features_project_code_unique").on(table.projectId, table.code),
    unique("features_id_project_unique").on(table.id, table.projectId),
    unique("features_id_module_project_unique").on(
      table.id,
      table.moduleId,
      table.projectId,
    ),
    foreignKey({
      name: "features_module_project_fk",
      columns: [table.moduleId, table.projectId],
      foreignColumns: [modules.id, modules.projectId],
    }).onDelete("restrict"),
    index("features_module_id_idx").on(
      table.projectId,
      table.moduleId,
      table.id,
    ),
    check(
      "features_code_check",
      sql.raw(
        "code ~ '^[A-Z][A-Z0-9_]{1,31}-F-[1-9][0-9]*$' AND length(code) <= 64",
      ),
    ),
    check(
      "features_name_check",
      sql.raw("length(btrim(name)) BETWEEN 1 AND 500"),
    ),
    check(
      "features_behavior_check",
      sql.raw("length(current_behavior) <= 50000"),
    ),
    check(
      "features_acceptance_check",
      sql.raw("length(acceptance_criteria) <= 50000"),
    ),
    check(
      "features_tags_check",
      sql.raw("cardinality(tags) <= 50 AND array_position(tags, NULL) IS NULL"),
    ),
    check("features_status_check", sql.raw("status = 'ACTIVE'")),
    check("features_row_version_check", sql.raw("row_version > 0")),
    check("features_archived_at_null_check", sql.raw("archived_at IS NULL")),
    check(
      "features_deleted_state_check",
      sql.raw("(deleted_at IS NULL) = (deleted_by IS NULL)"),
    ),
  ],
);

export const tasks = appSchema.table(
  "tasks",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    moduleId: integer("module_id").notNull(),
    featureId: integer("feature_id"),
    scopeType: text("scope_type").notNull(),
    code: text("code").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    creatorId: integer("creator_id").notNull(),
    creatorSnapshot: jsonb("creator_snapshot").notNull(),
    priority: text("priority").notNull().default("NORMAL"),
    workStatus: text("work_status").notNull().default("TODO"),
    lifecycleStatus: text("lifecycle_status").notNull().default("ACTIVE"),
    completionNote: text("completion_note"),
    completedAt: timestamptz("completed_at"),
    dueAt: timestamptz("due_at"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
    deletedBy: integer("deleted_by"),
    deletedBySnapshot: jsonb("deleted_by_snapshot"),
  },
  (table) => [
    unique("tasks_project_code_unique").on(table.projectId, table.code),
    unique("tasks_id_project_unique").on(table.id, table.projectId),
    unique("tasks_id_module_project_unique").on(
      table.id,
      table.moduleId,
      table.projectId,
    ),
    foreignKey({
      name: "tasks_module_project_fk",
      columns: [table.moduleId, table.projectId],
      foreignColumns: [modules.id, modules.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "tasks_feature_module_project_fk",
      columns: [table.featureId, table.moduleId, table.projectId],
      foreignColumns: [features.id, features.moduleId, features.projectId],
    }).onDelete("restrict"),
    index("tasks_project_status_idx").on(
      table.projectId,
      table.lifecycleStatus,
      table.workStatus,
      table.id,
    ),
    index("tasks_creator_status_idx").on(
      table.creatorId,
      table.workStatus,
      table.id,
    ),
    check("tasks_scope_check", sql.raw("scope_type IN ('FEATURE', 'MODULE')")),
    check(
      "tasks_scope_feature_check",
      sql.raw(
        "(scope_type = 'FEATURE' AND feature_id IS NOT NULL) OR (scope_type = 'MODULE' AND feature_id IS NULL)",
      ),
    ),
    check(
      "tasks_code_check",
      sql.raw(
        "code ~ '^[A-Z][A-Z0-9_]{1,31}-T-[1-9][0-9]*$' AND length(code) <= 64",
      ),
    ),
    check(
      "tasks_title_check",
      sql.raw("length(btrim(title)) BETWEEN 1 AND 500"),
    ),
    check("tasks_description_check", sql.raw("length(description) <= 50000")),
    check(
      "tasks_priority_check",
      sql.raw("priority IN ('NORMAL', 'HIGH', 'URGENT')"),
    ),
    check(
      "tasks_work_status_check",
      sql.raw("work_status IN ('TODO', 'DONE', 'CANCELED')"),
    ),
    check(
      "tasks_lifecycle_status_check",
      sql.raw("lifecycle_status IN ('ACTIVE', 'ARCHIVED', 'INVALID')"),
    ),
    check(
      "tasks_completion_note_check",
      sql.raw(
        "completion_note IS NULL OR length(btrim(completion_note)) BETWEEN 1 AND 10000",
      ),
    ),
    check(
      "tasks_completion_state_check",
      sql.raw(
        "(work_status = 'DONE' AND completed_at IS NOT NULL) OR (work_status <> 'DONE' AND completed_at IS NULL)",
      ),
    ),
    check("tasks_row_version_check", sql.raw("row_version > 0")),
  ],
);

export const taskFeatureImpacts = appSchema.table(
  "task_feature_impacts",
  {
    taskId: integer("task_id").notNull(),
    featureId: integer("feature_id").notNull(),
    moduleId: integer("module_id").notNull(),
    projectId: integer("project_id").notNull(),
    relationType: text("relation_type").notNull().default("IMPACT"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "task_feature_impacts_pk",
      columns: [table.taskId, table.featureId],
    }),
    foreignKey({
      name: "task_feature_impacts_task_fk",
      columns: [table.taskId, table.moduleId, table.projectId],
      foreignColumns: [tasks.id, tasks.moduleId, tasks.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_feature_impacts_feature_fk",
      columns: [table.featureId, table.moduleId, table.projectId],
      foreignColumns: [features.id, features.moduleId, features.projectId],
    }).onDelete("restrict"),
    check(
      "task_feature_impacts_type_check",
      sql.raw("relation_type = 'IMPACT'"),
    ),
  ],
);

/**
 * 任务负责人集合（ADR-040）：多负责人平权，本表是唯一真相。
 * 集合变更以“先删后插”实现，因此运行角色不持有 UPDATE。
 */
export const taskAssignees = appSchema.table(
  "task_assignees",
  {
    taskId: integer("task_id").notNull(),
    userId: integer("user_id").notNull(),
    userSnapshot: jsonb("user_snapshot").notNull(),
    projectId: integer("project_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "task_assignees_pkey",
      columns: [table.taskId, table.userId],
    }),
    foreignKey({
      name: "task_assignees_task_project_fk",
      columns: [table.taskId, table.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
    index("task_assignees_user_idx").on(table.userId, table.taskId),
  ],
);

export const taskStatusHistory = appSchema.table(
  "task_status_history",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    taskId: integer("task_id").notNull(),
    projectId: integer("project_id").notNull(),
    fromWorkStatus: text("from_work_status"),
    toWorkStatus: text("to_work_status").notNull(),
    completedAtSnapshot: timestamptz("completed_at_snapshot"),
    completionNoteSnapshot: text("completion_note_snapshot"),
    reason: text("reason"),
    changedBy: integer("changed_by").notNull(),
    changedBySnapshot: jsonb("changed_by_snapshot").notNull(),
    changedAt: timestamptz("changed_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "task_status_history_task_fk",
      columns: [table.taskId, table.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
    index("task_status_history_task_time_idx").on(
      table.projectId,
      table.taskId,
      table.changedAt,
      table.id,
    ),
    check(
      "task_status_history_from_check",
      sql.raw(
        "from_work_status IS NULL OR from_work_status IN ('TODO', 'DONE', 'CANCELED')",
      ),
    ),
    check(
      "task_status_history_to_check",
      sql.raw("to_work_status IN ('TODO', 'DONE', 'CANCELED')"),
    ),
    check(
      "task_status_history_transition_check",
      sql.raw("from_work_status IS NULL OR from_work_status <> to_work_status"),
    ),
    check(
      "task_status_history_completion_check",
      sql.raw(
        "((from_work_status = 'DONE' OR to_work_status = 'DONE') AND completed_at_snapshot IS NOT NULL) OR ((from_work_status IS DISTINCT FROM 'DONE' AND to_work_status <> 'DONE') AND completed_at_snapshot IS NULL)",
      ),
    ),
    check(
      "task_status_history_note_check",
      sql.raw(
        "completion_note_snapshot IS NULL OR length(btrim(completion_note_snapshot)) BETWEEN 1 AND 10000",
      ),
    ),
    check(
      "task_status_history_reason_check",
      sql.raw("reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 10000"),
    ),
  ],
);
