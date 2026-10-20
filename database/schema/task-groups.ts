import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";
import { appSchema } from "./shared.js";
import { tasks } from "./work.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const taskGroups = appSchema.table(
  "task_groups",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    closedAt: timestamptz("closed_at"),
  },
  (table) => [
    unique("task_groups_id_project_unique").on(table.id, table.projectId),
    unique("task_groups_project_code_unique").on(table.projectId, table.code),
    foreignKey({
      name: "task_groups_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("task_groups_project_status_idx").on(
      table.projectId,
      table.status,
      table.id,
    ),
    check(
      "task_groups_code_check",
      sql.raw(
        "code ~ '^[A-Z][A-Z0-9_]{1,31}-TG-[1-9][0-9]*$' AND length(code) <= 64",
      ),
    ),
    check(
      "task_groups_name_check",
      sql.raw("length(btrim(name)) BETWEEN 1 AND 500"),
    ),
    check(
      "task_groups_status_check",
      sql.raw("status IN ('ACTIVE', 'CLOSED')"),
    ),
    check("task_groups_row_version_check", sql.raw("row_version > 0")),
    check(
      "task_groups_close_state_check",
      sql.raw(
        "(status = 'ACTIVE' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL)",
      ),
    ),
  ],
);

export const taskGroupMembers = appSchema.table(
  "task_group_members",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    groupId: integer("group_id").notNull(),
    taskId: integer("task_id").notNull(),
    projectId: integer("project_id").notNull(),
    role: text("role").notNull(),
    sourceKind: text("source_kind"),
    status: text("status").notNull().default("ACTIVE"),
    originalWorkStatus: text("original_work_status"),
    originalAssigneeId: integer("original_assignee_id"),
    originalAssigneeSnapshot: jsonb("original_assignee_snapshot"),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    detachedAt: timestamptz("detached_at"),
    detachedBy: integer("detached_by"),
    detachedBySnapshot: jsonb("detached_by_snapshot"),
    detachReason: text("detach_reason"),
  },
  (table) => [
    unique("task_group_members_group_task_unique").on(
      table.projectId,
      table.groupId,
      table.taskId,
    ),
    foreignKey({
      name: "task_group_members_group_fk",
      columns: [table.groupId, table.projectId],
      foreignColumns: [taskGroups.id, taskGroups.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_group_members_task_fk",
      columns: [table.taskId, table.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
    uniqueIndex("task_group_members_one_active_group_unique")
      .on(table.taskId)
      .where(sql.raw("status = 'ACTIVE'")),
    uniqueIndex("task_group_members_one_active_main_unique")
      .on(table.groupId)
      .where(sql.raw("status = 'ACTIVE' AND role = 'MAIN'")),
    index("task_group_members_group_status_idx").on(
      table.projectId,
      table.groupId,
      table.status,
      table.id,
    ),
    check(
      "task_group_members_role_check",
      sql.raw("role IN ('MAIN', 'SOURCE')"),
    ),
    check(
      "task_group_members_source_kind_check",
      sql.raw("source_kind IS NULL OR source_kind IN ('ACTIVE', 'HISTORICAL')"),
    ),
    check(
      "task_group_members_status_check",
      sql.raw("status IN ('ACTIVE', 'DETACHED')"),
    ),
    check(
      "task_group_members_original_status_check",
      sql.raw(
        "original_work_status IS NULL OR original_work_status IN ('TODO', 'DONE', 'CANCELED')",
      ),
    ),
    check(
      "task_group_members_snapshot_check",
      sql.raw(
        "(role = 'MAIN' AND source_kind IS NULL AND original_work_status IS NULL AND original_assignee_id IS NULL) OR (role = 'SOURCE' AND source_kind IS NOT NULL AND original_work_status IS NOT NULL AND original_assignee_id IS NOT NULL)",
      ),
    ),
    check(
      "task_group_members_detach_state_check",
      sql.raw(
        "(status = 'ACTIVE' AND detached_at IS NULL AND detached_by IS NULL AND detach_reason IS NULL) OR (status = 'DETACHED' AND detached_at IS NOT NULL AND detached_by IS NOT NULL AND detach_reason IS NOT NULL AND length(btrim(detach_reason)) BETWEEN 1 AND 10000)",
      ),
    ),
    check(
      "task_group_members_detach_time_check",
      sql.raw("detached_at IS NULL OR detached_at >= joined_at"),
    ),
  ],
);
