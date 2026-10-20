import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { appSchema, bytea } from "./shared.js";

const timestamptz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const auditChainHeads = appSchema.table(
  "audit_chain_heads",
  {
    chainId: text("chain_id").primaryKey(),
    projectId: integer("project_id"),
    lastSequence: bigint("last_sequence", { mode: "number" })
      .notNull()
      .default(0),
    lastHash: bytea("last_hash")
      .notNull()
      .default(sql.raw("decode(repeat('00', 32), 'hex')")),
    keyVersion: smallint("key_version").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  () => [
    check(
      "audit_chain_heads_chain_check",
      sql.raw(
        "(project_id IS NULL AND chain_id = 'SYSTEM') OR (project_id IS NOT NULL AND chain_id = 'PROJECT:' || project_id::text)",
      ),
    ),
    check("audit_chain_heads_sequence_check", sql.raw("last_sequence >= 0")),
    check(
      "audit_chain_heads_hash_check",
      sql.raw("octet_length(last_hash) = 32"),
    ),
    check("audit_chain_heads_key_version_check", sql.raw("key_version > 0")),
  ],
);

export const auditLogs = appSchema.table(
  "audit_logs",
  {
    chainId: text("chain_id").notNull(),
    sequenceNo: bigint("sequence_no", { mode: "number" }).notNull(),
    projectId: integer("project_id"),
    actorType: text("actor_type").notNull(),
    actorId: integer("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    eventPayload: jsonb("event_payload").notNull(),
    requestId: text("request_id").notNull(),
    clientRequestId: text("client_request_id"),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    occurredAt: timestamptz("occurred_at").notNull(),
    prevHash: bytea("prev_hash").notNull(),
    recordHash: bytea("record_hash").notNull(),
    keyVersion: smallint("key_version").notNull(),
    canonicalVersion: text("canonical_version").notNull(),
  },
  (table) => [
    primaryKey({
      name: "audit_logs_pk",
      columns: [table.chainId, table.sequenceNo],
    }),
    foreignKey({
      name: "audit_logs_chain_fk",
      columns: [table.chainId],
      foreignColumns: [auditChainHeads.chainId],
    }).onDelete("restrict"),
    unique("audit_logs_chain_hash_unique").on(table.chainId, table.recordHash),
    uniqueIndex("audit_logs_chain_prev_hash_unique")
      .on(table.chainId, table.prevHash)
      .where(sql.raw("sequence_no > 1")),
    index("audit_logs_project_time_idx").on(
      table.projectId,
      table.occurredAt,
      table.sequenceNo,
    ),
    index("audit_logs_actor_time_idx").on(
      table.actorId,
      table.occurredAt,
      table.sequenceNo,
    ),
    check(
      "audit_logs_chain_check",
      sql.raw(
        "(project_id IS NULL AND chain_id = 'SYSTEM') OR (project_id IS NOT NULL AND chain_id = 'PROJECT:' || project_id::text)",
      ),
    ),
    check("audit_logs_sequence_check", sql.raw("sequence_no > 0")),
    check(
      "audit_logs_actor_check",
      sql.raw(
        "(actor_type = 'USER' AND actor_id IS NOT NULL) OR (actor_type = 'SYSTEM' AND actor_id IS NULL)",
      ),
    ),
    check(
      "audit_logs_action_check",
      sql.raw("length(action) BETWEEN 1 AND 200"),
    ),
    check(
      "audit_logs_target_type_check",
      sql.raw("length(target_type) BETWEEN 1 AND 100"),
    ),
    check(
      "audit_logs_target_id_check",
      sql.raw("target_id IS NULL OR length(target_id) BETWEEN 1 AND 200"),
    ),
    check(
      "audit_logs_payload_check",
      sql.raw(
        "jsonb_typeof(event_payload) = 'object' AND pg_column_size(event_payload) <= 1048576",
      ),
    ),
    check(
      "audit_logs_request_id_check",
      sql.raw(
        "length(request_id) BETWEEN 1 AND 64 AND request_id ~ '^[A-Za-z0-9._:-]+$'",
      ),
    ),
    check(
      "audit_logs_client_request_id_check",
      sql.raw(
        "client_request_id IS NULL OR (length(client_request_id) BETWEEN 1 AND 64 AND client_request_id ~ '^[A-Za-z0-9._:-]+$')",
      ),
    ),
    check(
      "audit_logs_user_agent_check",
      sql.raw("user_agent IS NULL OR length(user_agent) <= 1000"),
    ),
    check(
      "audit_logs_hashes_check",
      sql.raw(
        "octet_length(prev_hash) = 32 AND octet_length(record_hash) = 32",
      ),
    ),
    check("audit_logs_key_version_check", sql.raw("key_version > 0")),
    check(
      "audit_logs_canonical_version_check",
      sql.raw("canonical_version = 'JCS-1'"),
    ),
  ],
);
