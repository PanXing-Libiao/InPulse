import { sql } from "drizzle-orm";
import {
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

import { appSchema } from "./shared.js";
import { features, modules, tasks } from "./work.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const changeRecords = appSchema.table(
  "change_records",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    taskId: integer("task_id"),
    moduleId: integer("module_id").notNull(),
    featureId: integer("feature_id"),
    scopeType: text("scope_type").notNull(),
    code: text("code"),
    title: text("title").notNull(),
    handlerId: integer("handler_id").notNull(),
    handlerSnapshot: jsonb("handler_snapshot").notNull(),
    authorId: integer("author_id").notNull(),
    authorSnapshot: jsonb("author_snapshot").notNull(),
    status: text("status").notNull().default("DRAFT"),
    currentVersion: integer("current_version").notNull().default(0),
    currentPayload: jsonb("current_payload")
      .notNull()
      .default(sql.raw("'{}'::jsonb")),
    publishedAt: timestamptz("published_at"),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("change_records_project_code_unique").on(
      table.projectId,
      table.code,
    ),
    unique("change_records_id_project_unique").on(table.id, table.projectId),
    unique("change_records_id_module_project_unique").on(
      table.id,
      table.moduleId,
      table.projectId,
    ),
    foreignKey({
      name: "change_records_module_project_fk",
      columns: [table.moduleId, table.projectId],
      foreignColumns: [modules.id, modules.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "change_records_task_project_fk",
      columns: [table.taskId, table.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "change_records_feature_module_project_fk",
      columns: [table.featureId, table.moduleId, table.projectId],
      foreignColumns: [features.id, features.moduleId, features.projectId],
    }).onDelete("restrict"),
    index("change_records_project_task_idx")
      .on(table.projectId, table.taskId, table.id)
      .where(sql.raw("task_id IS NOT NULL")),
    index("change_records_project_status_idx").on(
      table.projectId,
      table.status,
      table.id,
    ),
    index("change_records_status_published_idx").on(
      table.status,
      table.publishedAt.desc(),
      table.id.desc(),
    ),
    index("change_records_author_status_created_idx").on(
      table.authorId,
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "change_records_scope_check",
      sql.raw("scope_type IN ('FEATURE', 'MODULE')"),
    ),
    check(
      "change_records_scope_feature_check",
      sql.raw(
        "(scope_type = 'FEATURE' AND feature_id IS NOT NULL) OR (scope_type = 'MODULE' AND feature_id IS NULL)",
      ),
    ),
    check(
      "change_records_code_check",
      sql.raw(
        "code IS NULL OR (code ~ '^[A-Z][A-Z0-9_]{1,31}-CR-[1-9][0-9]*$' AND length(code) <= 64)",
      ),
    ),
    check(
      "change_records_title_check",
      sql.raw("length(btrim(title)) BETWEEN 1 AND 500"),
    ),
    check(
      "change_records_status_check",
      sql.raw("status IN ('DRAFT', 'PUBLISHED', 'VOID')"),
    ),
    check("change_records_version_check", sql.raw("current_version >= 0")),
    check(
      "change_records_payload_check",
      sql.raw(
        "jsonb_typeof(current_payload) = 'object' AND pg_column_size(current_payload) <= 1048576",
      ),
    ),
    check(
      "change_records_void_reason_check",
      sql.raw(
        "void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 10000",
      ),
    ),
    check(
      "change_records_state_check",
      sql.raw(
        "(status = 'DRAFT' AND code IS NULL AND current_version = 0 AND published_at IS NULL AND voided_at IS NULL AND void_reason IS NULL) OR (status = 'PUBLISHED' AND code IS NOT NULL AND current_version >= 1 AND published_at IS NOT NULL AND ((voided_at IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))) OR (status = 'VOID' AND code IS NOT NULL AND current_version >= 1 AND published_at IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)",
      ),
    ),
    check(
      "change_records_timestamp_check",
      sql.raw(
        "(published_at IS NULL OR published_at >= created_at) AND (voided_at IS NULL OR voided_at >= published_at)",
      ),
    ),
    check("change_records_row_version_check", sql.raw("row_version > 0")),
  ],
);

export const changeRecordVersions = appSchema.table(
  "change_record_versions",
  {
    recordId: integer("record_id").notNull(),
    projectId: integer("project_id").notNull(),
    versionNo: integer("version_no").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    payload: jsonb("payload").notNull(),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "change_record_versions_pk",
      columns: [table.recordId, table.versionNo],
    }),
    unique("change_record_versions_project_unique").on(
      table.recordId,
      table.versionNo,
      table.projectId,
    ),
    foreignKey({
      name: "change_record_versions_record_fk",
      columns: [table.recordId, table.projectId],
      foreignColumns: [changeRecords.id, changeRecords.projectId],
    }).onDelete("restrict"),
    check("change_record_versions_number_check", sql.raw("version_no > 0")),
    check(
      "change_record_versions_title_check",
      sql.raw("length(btrim(title_snapshot)) BETWEEN 1 AND 500"),
    ),
    check(
      "change_record_versions_payload_check",
      sql.raw(
        "jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 1048576",
      ),
    ),
  ],
);

export const changeRecordLeftoverItems = appSchema.table(
  "change_record_leftover_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    recordId: integer("record_id").notNull(),
    projectId: integer("project_id").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("change_record_leftovers_id_record_project_unique").on(
      table.id,
      table.recordId,
      table.projectId,
    ),
    unique("change_record_leftovers_id_project_unique").on(
      table.id,
      table.projectId,
    ),
    foreignKey({
      name: "change_record_leftovers_record_fk",
      columns: [table.recordId, table.projectId],
      foreignColumns: [changeRecords.id, changeRecords.projectId],
    }).onDelete("restrict"),
    index("change_record_leftovers_record_status_idx").on(
      table.projectId,
      table.recordId,
      table.status,
      table.id,
    ),
    check(
      "change_record_leftovers_status_check",
      sql.raw("status IN ('ACTIVE', 'CONVERTED', 'RESOLVED')"),
    ),
    check(
      "change_record_leftovers_row_version_check",
      sql.raw("row_version > 0"),
    ),
  ],
);

export const changeRecordVersionLeftovers = appSchema.table(
  "change_record_version_leftovers",
  {
    recordId: integer("record_id").notNull(),
    versionNo: integer("version_no").notNull(),
    leftoverItemId: integer("leftover_item_id").notNull(),
    projectId: integer("project_id").notNull(),
    contentSnapshot: text("content_snapshot").notNull(),
  },
  (table) => [
    primaryKey({
      name: "change_record_version_leftovers_pk",
      columns: [table.recordId, table.versionNo, table.leftoverItemId],
    }),
    foreignKey({
      name: "change_record_version_leftovers_version_fk",
      columns: [table.recordId, table.versionNo, table.projectId],
      foreignColumns: [
        changeRecordVersions.recordId,
        changeRecordVersions.versionNo,
        changeRecordVersions.projectId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "change_record_version_leftovers_item_fk",
      columns: [table.leftoverItemId, table.recordId, table.projectId],
      foreignColumns: [
        changeRecordLeftoverItems.id,
        changeRecordLeftoverItems.recordId,
        changeRecordLeftoverItems.projectId,
      ],
    }).onDelete("restrict"),
    check(
      "change_record_version_leftovers_content_check",
      sql.raw("length(btrim(content_snapshot)) BETWEEN 1 AND 10000"),
    ),
  ],
);

export const leftoverTaskLinks = appSchema.table(
  "leftover_task_links",
  {
    leftoverItemId: integer("leftover_item_id").primaryKey(),
    taskId: integer("task_id").notNull(),
    projectId: integer("project_id").notNull(),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("leftover_task_links_task_unique").on(table.taskId),
    foreignKey({
      name: "leftover_task_links_item_fk",
      columns: [table.leftoverItemId, table.projectId],
      foreignColumns: [
        changeRecordLeftoverItems.id,
        changeRecordLeftoverItems.projectId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "leftover_task_links_task_fk",
      columns: [table.taskId, table.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
  ],
);

export const changeRecordFeatureImpacts = appSchema.table(
  "change_record_feature_impacts",
  {
    changeRecordId: integer("change_record_id").notNull(),
    featureId: integer("feature_id").notNull(),
    moduleId: integer("module_id").notNull(),
    projectId: integer("project_id").notNull(),
    relationType: text("relation_type").notNull().default("IMPACT"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "change_record_feature_impacts_pk",
      columns: [table.changeRecordId, table.featureId],
    }),
    foreignKey({
      name: "change_record_feature_impacts_record_fk",
      columns: [table.changeRecordId, table.moduleId, table.projectId],
      foreignColumns: [
        changeRecords.id,
        changeRecords.moduleId,
        changeRecords.projectId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "change_record_feature_impacts_feature_fk",
      columns: [table.featureId, table.moduleId, table.projectId],
      foreignColumns: [features.id, features.moduleId, features.projectId],
    }).onDelete("restrict"),
    check(
      "change_record_feature_impacts_type_check",
      sql.raw("relation_type = 'IMPACT'"),
    ),
  ],
);
