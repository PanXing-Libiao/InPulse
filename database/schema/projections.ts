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
} from "drizzle-orm/pg-core";

import { auditLogs } from "./audit.js";
import { users } from "./identity.js";
import { projects } from "./projects.js";
import { appSchema } from "./shared.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const codeSequences = appSchema.table(
  "code_sequences",
  {
    projectId: integer("project_id").notNull(),
    entityType: text("entity_type").notNull(),
    lastNumber: integer("last_number").notNull(),
  },
  (table) => [
    primaryKey({
      name: "code_sequences_pk",
      columns: [table.projectId, table.entityType],
    }),
    foreignKey({
      name: "code_sequences_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    check(
      "code_sequences_entity_check",
      sql.raw(
        "entity_type IN ('TASK', 'CHANGE_RECORD', 'TASK_GROUP', 'MODULE')",
      ),
    ),
    check("code_sequences_number_check", sql.raw("last_number > 0")),
  ],
);

export const notifications = appSchema.table(
  "notifications",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    recipientId: integer("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    sourceChainId: text("source_chain_id").notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    notificationType: text("notification_type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    targetPath: text("target_path"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    readAt: timestamptz("read_at"),
  },
  (table) => [
    unique("notifications_source_recipient_type_unique").on(
      table.sourceChainId,
      table.sourceSequence,
      table.recipientId,
      table.notificationType,
    ),
    foreignKey({
      name: "notifications_source_audit_fk",
      columns: [table.sourceChainId, table.sourceSequence],
      foreignColumns: [auditLogs.chainId, auditLogs.sequenceNo],
    }).onDelete("restrict"),
    index("notifications_recipient_cursor_idx").on(
      table.recipientId,
      table.createdAt,
      table.id,
    ),
    index("notifications_recipient_unread_idx")
      .on(table.recipientId, table.createdAt, table.id)
      .where(sql.raw("read_at IS NULL")),
    check(
      "notifications_type_check",
      sql.raw("length(notification_type) BETWEEN 1 AND 100"),
    ),
    check(
      "notifications_source_scope_check",
      sql.raw(
        "(project_id IS NULL AND source_chain_id = 'SYSTEM') OR (project_id IS NOT NULL AND source_chain_id = 'PROJECT:' || project_id::text)",
      ),
    ),
    check(
      "notifications_title_check",
      sql.raw("length(btrim(title)) BETWEEN 1 AND 500"),
    ),
    check("notifications_body_check", sql.raw("length(body) <= 5000")),
    check(
      "notifications_target_path_check",
      sql.raw(
        "target_path IS NULL OR (length(target_path) BETWEEN 1 AND 2048 AND target_path LIKE '/%')",
      ),
    ),
    check(
      "notifications_read_at_check",
      sql.raw("read_at IS NULL OR read_at >= created_at"),
    ),
  ],
);

export const activityProjection = appSchema.table(
  "activity_projection",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    sourceChainId: text("source_chain_id").notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceEntityId: integer("source_entity_id").notNull(),
    activityType: text("activity_type").notNull(),
    actorId: integer("actor_id"),
    actorSnapshot: jsonb("actor_snapshot"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").notNull().default(sql.raw("'{}'::jsonb")),
    visibilityScope: text("visibility_scope").notNull().default("MEMBER"),
    sourceStatus: text("source_status").notNull(),
    sourceRowVersion: integer("source_row_version").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
  },
  (table) => [
    unique("activity_projection_source_unique").on(
      table.sourceChainId,
      table.sourceSequence,
    ),
    foreignKey({
      name: "activity_projection_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "activity_projection_source_audit_fk",
      columns: [table.sourceChainId, table.sourceSequence],
      foreignColumns: [auditLogs.chainId, auditLogs.sequenceNo],
    }).onDelete("restrict"),
    index("activity_projection_project_cursor_idx").on(
      table.projectId,
      table.occurredAt,
      table.id,
    ),
    index("activity_projection_entity_idx").on(
      table.projectId,
      table.sourceEntityType,
      table.sourceEntityId,
      table.occurredAt,
    ),
    check(
      "activity_projection_entity_type_check",
      sql.raw("length(source_entity_type) BETWEEN 1 AND 100"),
    ),
    check(
      "activity_projection_source_scope_check",
      sql.raw("source_chain_id = 'PROJECT:' || project_id::text"),
    ),
    check(
      "activity_projection_activity_type_check",
      sql.raw("length(activity_type) BETWEEN 1 AND 100"),
    ),
    check(
      "activity_projection_summary_check",
      sql.raw("length(btrim(summary)) BETWEEN 1 AND 1000"),
    ),
    check(
      "activity_projection_metadata_check",
      sql.raw(
        "jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 65536",
      ),
    ),
    check(
      "activity_projection_actor_snapshot_check",
      sql.raw(
        "actor_snapshot IS NULL OR (actor_id IS NOT NULL AND jsonb_typeof(actor_snapshot) = 'object' AND pg_column_size(actor_snapshot) <= 4096 AND jsonb_typeof(actor_snapshot->'id') = 'number' AND jsonb_typeof(actor_snapshot->'name') = 'string' AND jsonb_typeof(actor_snapshot->'loginName') = 'string' AND length(btrim(actor_snapshot->>'name')) BETWEEN 1 AND 200 AND length(btrim(actor_snapshot->>'loginName')) BETWEEN 1 AND 100 AND actor_snapshot->>'id' = actor_id::text)",
      ),
    ),
    check(
      "activity_projection_visibility_check",
      sql.raw("visibility_scope IN ('MEMBER', 'ADMIN_ONLY')"),
    ),
    check(
      "activity_projection_source_status_check",
      sql.raw("length(source_status) BETWEEN 1 AND 50"),
    ),
    check(
      "activity_projection_source_version_check",
      sql.raw("source_row_version > 0"),
    ),
  ],
);

export const searchProjection = appSchema.table(
  "search_projection",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    rawText: text("raw_text").notNull(),
    normalizedSearchText: text("normalized_search_text").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("MEMBER"),
    sourceStatus: text("source_status").notNull(),
    sourceRowVersion: integer("source_row_version").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("search_projection_entity_unique").on(
      table.projectId,
      table.entityType,
      table.entityId,
    ),
    foreignKey({
      name: "search_projection_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    index("search_projection_project_type_idx").on(
      table.projectId,
      table.entityType,
      table.visibilityScope,
      table.id,
    ),
    check(
      "search_projection_entity_type_check",
      sql.raw(
        "entity_type IN ('PROJECT', 'MODULE', 'TASK', 'CHANGE_RECORD', 'EXTERNAL_LINK', 'TASK_GROUP', 'LEFTOVER')",
      ),
    ),
    check(
      "search_projection_title_check",
      sql.raw("length(btrim(title)) BETWEEN 1 AND 500"),
    ),
    check(
      "search_projection_summary_check",
      sql.raw("length(summary) <= 5000"),
    ),
    check(
      "search_projection_raw_text_check",
      sql.raw("length(raw_text) BETWEEN 1 AND 100000"),
    ),
    check(
      "search_projection_normalized_text_check",
      sql.raw("length(normalized_search_text) BETWEEN 1 AND 100000"),
    ),
    check(
      "search_projection_visibility_check",
      sql.raw("visibility_scope IN ('MEMBER', 'ADMIN_ONLY', 'HIDDEN')"),
    ),
    check(
      "search_projection_source_status_check",
      sql.raw("length(source_status) BETWEEN 1 AND 50"),
    ),
    check(
      "search_projection_source_version_check",
      sql.raw("source_row_version > 0"),
    ),
  ],
);
