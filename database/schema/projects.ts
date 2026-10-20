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

import { appSchema } from "./shared.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const projects = appSchema.table(
  "projects",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    /** ADR-043：项目生命周期三态（未开始 / 进行中 / 维护中）；新建项目从未开始起步，归档已下线。 */
    status: text("status").notNull().default("NOT_STARTED"),
    /**
     * 粘性标记：项目第一次有任务完成时置位，永不回落。
     * 有值即表示项目已有产出，服务端禁止把项目回退为未开始。
     */
    firstTaskCompletedAt: timestamptz("first_task_completed_at"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    /** ADR-043：归档时代的只读历史列，项目侧恒为空（见 projects_archived_at_null_check）。 */
    archivedAt: timestamptz("archived_at"),
    /** ADR-062：项目删除为不可逆物理删除，不存在软删除列。 */
  },
  (table) => [
    unique("projects_code_unique").on(table.code),
    unique("projects_id_unique").on(table.id),
    check("projects_code_check", sql.raw("code ~ '^[A-Z][A-Z0-9_]{1,31}$'")),
    check(
      "projects_name_check",
      sql.raw("length(btrim(name)) BETWEEN 1 AND 200"),
    ),
    check(
      "projects_description_check",
      sql.raw("length(description) <= 20000"),
    ),
    check(
      "projects_status_check",
      sql.raw("status IN ('NOT_STARTED', 'ACTIVE', 'MAINTENANCE')"),
    ),
    check(
      "projects_not_started_lock_check",
      sql.raw("status <> 'NOT_STARTED' OR first_task_completed_at IS NULL"),
    ),
    check("projects_row_version_check", sql.raw("row_version > 0")),
    check("projects_archived_at_null_check", sql.raw("archived_at IS NULL")),
  ],
);

export const projectMembers = appSchema.table(
  "project_members",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    userId: integer("user_id").notNull(),
    userSnapshot: jsonb("user_snapshot").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    /** ADR-033/ADR-039：项目内角色（组长或普通成员）；成员被移除即失效，重新加入从 MEMBER 开始。 */
    role: text("role").notNull().default("MEMBER"),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    removedAt: timestamptz("removed_at"),
  },
  (table) => [
    unique("project_members_id_project_unique").on(table.id, table.projectId),
    foreignKey({
      name: "project_members_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    uniqueIndex("project_members_active_unique")
      .on(table.projectId, table.userId)
      .where(sql.raw("status = 'ACTIVE'")),
    uniqueIndex("project_members_one_leader")
      .on(table.projectId)
      .where(sql.raw("status = 'ACTIVE' AND role = 'LEADER'")),
    index("project_members_user_active_idx")
      .on(table.userId, table.projectId)
      .where(sql.raw("status = 'ACTIVE'")),
    check(
      "project_members_status_check",
      sql.raw("status IN ('ACTIVE', 'REMOVED')"),
    ),
    check(
      "project_members_role_check",
      sql.raw("role IN ('MEMBER', 'LEADER')"),
    ),
    check(
      "project_members_removed_role_check",
      sql.raw("status = 'ACTIVE' OR role = 'MEMBER'"),
    ),
    check(
      "project_members_state_check",
      sql.raw(
        "(status = 'ACTIVE' AND removed_at IS NULL) OR (status = 'REMOVED' AND removed_at IS NOT NULL AND removed_at >= joined_at)",
      ),
    ),
  ],
);

export const projectWraps = appSchema.table(
  "project_wraps",
  {
    projectId: integer("project_id").primaryKey(),
    sealedAt: timestamptz("sealed_at").notNull(),
    sealedBy: integer("sealed_by").notNull(),
    sealedBySnapshot: jsonb("sealed_by_snapshot").notNull(),
    templateVersion: integer("template_version").notNull().default(1),
    snapshot: jsonb("snapshot").notNull(),
  },
  (table) => [
    foreignKey({
      name: "project_wraps_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("cascade"),
    check("project_wraps_sealed_by_check", sql.raw("sealed_by > 0")),
    check(
      "project_wraps_template_version_check",
      sql.raw("template_version >= 1"),
    ),
    check(
      "project_wraps_sealed_by_snapshot_check",
      sql.raw(
        "jsonb_typeof(sealed_by_snapshot) = 'object' AND jsonb_typeof(sealed_by_snapshot->'id') = 'number' AND jsonb_typeof(sealed_by_snapshot->'name') = 'string' AND length(btrim(sealed_by_snapshot->>'name')) BETWEEN 1 AND 200 AND sealed_by_snapshot->>'id' = sealed_by::text",
      ),
    ),
    check(
      "project_wraps_snapshot_check",
      sql.raw(
        "jsonb_typeof(snapshot) = 'object' AND snapshot->>'version' = template_version::text AND jsonb_typeof(snapshot->'project') = 'object' AND jsonb_typeof(snapshot->'stats') = 'object' AND jsonb_typeof(snapshot->'participants') = 'array' AND jsonb_typeof(snapshot->'timeline') = 'object' AND pg_column_size(snapshot) <= 262144",
      ),
    ),
  ],
);
