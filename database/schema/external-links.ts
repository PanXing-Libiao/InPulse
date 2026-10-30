import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  uniqueIndex,
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { changeRecords } from "./change-records.js";
import { projects } from "./projects.js";
import { appSchema } from "./shared.js";
import { tasks } from "./work.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const externalLinks = appSchema.table(
  "external_links",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    projectId: integer("project_id").notNull(),
    displayUrl: text("display_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    provider: text("provider").notNull().default("GITHUB"),
    kind: text("kind").notNull(),
    repository: text("repository"),
    externalNumber: bigint("external_number", { mode: "number" }),
    externalSha: text("external_sha"),
    titleSnapshot: text("title_snapshot"),
    stateSnapshot: text("state_snapshot"),
    createdBy: integer("created_by").notNull(),
    createdBySnapshot: jsonb("created_by_snapshot").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("external_links_id_project_unique").on(table.id, table.projectId),
    unique("external_links_project_url_unique").on(
      table.projectId,
      table.normalizedUrl,
    ),
    foreignKey({
      name: "external_links_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    check(
      "external_links_display_url_check",
      sql.raw(
        "length(display_url) BETWEEN 1 AND 2048 AND display_url ~ '^https://github[.]com(/|$)'",
      ),
    ),
    check(
      "external_links_normalized_url_check",
      sql.raw(
        "length(normalized_url) BETWEEN 1 AND 2048 AND normalized_url ~ '^https://github[.]com(/|$)' AND normalized_url !~ '[#]'",
      ),
    ),
    check("external_links_provider_check", sql.raw("provider = 'GITHUB'")),
    check(
      "external_links_kind_check",
      sql.raw("kind IN ('ISSUE', 'PULL_REQUEST', 'COMMIT', 'OTHER')"),
    ),
    check(
      "external_links_repository_check",
      sql.raw(
        "repository IS NULL OR (length(repository) BETWEEN 3 AND 201 AND repository ~ '^[^/[:space:]]+/[^/[:space:]]+$')",
      ),
    ),
    check(
      "external_links_number_check",
      sql.raw("external_number IS NULL OR external_number > 0"),
    ),
    check(
      "external_links_sha_check",
      sql.raw("external_sha IS NULL OR external_sha ~ '^[0-9a-fA-F]{7,64}$'"),
    ),
    check(
      "external_links_title_check",
      sql.raw(
        "title_snapshot IS NULL OR length(title_snapshot) BETWEEN 1 AND 500",
      ),
    ),
    check(
      "external_links_state_check",
      sql.raw(
        "state_snapshot IS NULL OR length(state_snapshot) BETWEEN 1 AND 100",
      ),
    ),
  ],
);

export const projectExternalLinks = appSchema.table(
  "project_external_links",
  {
    projectId: integer("project_id").notNull(),
    linkId: integer("link_id").notNull(),
    isRootRepository: boolean("is_root_repository").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("project_external_links_one_root")
      .on(table.projectId)
      .where(sql.raw("is_root_repository")),
    primaryKey({
      name: "project_external_links_pk",
      columns: [table.projectId, table.linkId],
    }),
    foreignKey({
      name: "project_external_links_project_fk",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "project_external_links_link_fk",
      columns: [table.linkId, table.projectId],
      foreignColumns: [externalLinks.id, externalLinks.projectId],
    }).onDelete("restrict"),
  ],
);

export const taskExternalLinks = appSchema.table(
  "task_external_links",
  {
    projectId: integer("project_id").notNull(),
    taskId: integer("task_id").notNull(),
    linkId: integer("link_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "task_external_links_pk",
      columns: [table.projectId, table.taskId, table.linkId],
    }),
    foreignKey({
      name: "task_external_links_task_fk",
      columns: [table.taskId, table.projectId],
      foreignColumns: [tasks.id, tasks.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_external_links_link_fk",
      columns: [table.linkId, table.projectId],
      foreignColumns: [externalLinks.id, externalLinks.projectId],
    }).onDelete("restrict"),
  ],
);

export const changeRecordExternalLinks = appSchema.table(
  "change_record_external_links",
  {
    projectId: integer("project_id").notNull(),
    changeRecordId: integer("change_record_id").notNull(),
    linkId: integer("link_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "change_record_external_links_pk",
      columns: [table.projectId, table.changeRecordId, table.linkId],
    }),
    foreignKey({
      name: "change_record_external_links_record_fk",
      columns: [table.changeRecordId, table.projectId],
      foreignColumns: [changeRecords.id, changeRecords.projectId],
    }).onDelete("restrict"),
    foreignKey({
      name: "change_record_external_links_link_fk",
      columns: [table.linkId, table.projectId],
      foreignColumns: [externalLinks.id, externalLinks.projectId],
    }).onDelete("restrict"),
  ],
);
