import "reflect-metadata";
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, test } from "vitest";
import type { DatabaseClient } from "@inpulse/database/client";
import { createDatabaseClient } from "@inpulse/database/client";

import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { canonicalizeJson } from "@inpulse/canonical-json";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let runtime: DatabaseClient | undefined;
let reader: DatabaseClient | undefined;
let bootstrap: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let port: PostgresAuditWritePort | undefined;
let userId: number | undefined;
let project: ProjectFixture | undefined;

const auditKey = Buffer.from(
  "integration-only-audit-key-not-a-production-secret",
  "utf8",
);

beforeAll(async () => {
  runtime = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-audit-write-test",
  });
  uow = new PostgresUnitOfWork(runtime);
  port = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => auditKey,
  });
  userId = await createUser(runtime.sql);
  project = await createProject(runtime.sql, userId);
  reader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-audit-write-reader-test",
  });
  bootstrap = createDatabaseClient(testUrls().bootstrap, {
    applicationName: "inpulse-audit-write-bootstrap-test",
  });
});

afterAll(async () => {
  await runtime?.close();
  await reader?.close();
  await bootstrap?.close();
});

test("port appends a record into a project audit chain and links prev_hash", async () => {
  const chainId = `PROJECT:${project!.projectId}`;
  const first = await uow!.run((tx) =>
    port!.append(tx, {
      projectId: project!.projectId,
      actorType: "USER",
      actorId: userId!,
      action: "PROJECT_CREATED",
      targetType: "PROJECT",
      targetId: String(project!.projectId),
      eventPayload: { code: project!.code },
      requestId: randomUUID(),
      clientRequestId: null,
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      occurredAt: new Date(),
    }),
  );
  expect(first.chainId).toBe(chainId);
  expect(first.sequenceNo).toBe(1);
  expect(first.recordHash).toHaveLength(32);

  const second = await uow!.run((tx) =>
    port!.append(tx, {
      projectId: project!.projectId,
      actorType: "USER",
      actorId: userId!,
      action: "PROJECT_EDITED",
      targetType: "PROJECT",
      targetId: String(project!.projectId),
      eventPayload: { field: "name" },
      requestId: randomUUID(),
      clientRequestId: null,
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      occurredAt: new Date(),
    }),
  );
  expect(second.sequenceNo).toBe(2);

  const rows = (await reader!.sql`
    SELECT sequence_no AS "sequenceNo", prev_hash AS "prevHash",
           record_hash AS "recordHash", action, event_payload AS "eventPayload"
      FROM app.audit_logs
     WHERE chain_id = ${chainId}
     ORDER BY sequence_no
  `) as unknown as readonly {
    sequenceNo: string;
    prevHash: Buffer;
    recordHash: Buffer;
    action: string;
    eventPayload: Record<string, unknown>;
  }[];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.action).toBe("PROJECT_CREATED");
  expect(rows[1]!.action).toBe("PROJECT_EDITED");
  expect(Buffer.from(rows[0]!.prevHash)).toEqual(Buffer.alloc(32));
  expect(Buffer.from(rows[1]!.prevHash)).toEqual(rows[0]!.recordHash);
  expect(rows[0]!.eventPayload["code"]).toBe(project!.code);
  expect(rows[0]!.eventPayload["action"]).toBe("PROJECT_CREATED");
  expect(rows[0]!.eventPayload["actorSnapshot"]).toEqual({
    id: userId,
    name: expect.any(String),
    loginName: expect.any(String),
  });

  const [head] = (await reader!.sql`
    SELECT last_sequence AS "lastSequence", last_hash AS "lastHash"
      FROM app.audit_chain_heads
     WHERE chain_id = ${chainId}
  `) as unknown as readonly { lastSequence: string; lastHash: Buffer }[];
  expect(Number(head?.lastSequence)).toBe(2);
  expect(Buffer.from(head?.lastHash ?? [])).toEqual(rows[1]!.recordHash);
});

test("hard-deleting an actor keeps the audit row and its identity snapshot", async () => {
  const deletedActorId = await createUser(runtime!.sql);
  const requestId = randomUUID();
  const action = "SYSTEM_TEST_ACTOR_SNAPSHOT";
  await uow!.run((tx) =>
    port!.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: deletedActorId,
      action,
      targetType: "USER",
      targetId: String(deletedActorId),
      eventPayload: { marker: "actor-deleted-after-audit" },
      requestId,
      occurredAt: new Date(),
    }),
  );

  await bootstrap!.sql`DELETE FROM app.users WHERE id = ${deletedActorId}`;

  const [actor] = (await bootstrap!.sql`
    SELECT count(*)::INTEGER AS count
      FROM app.users
     WHERE id = ${deletedActorId}
  `) as unknown as readonly { count: number }[];
  expect(actor?.count).toBe(0);

  const rows = (await reader!.sql`
    SELECT actor_id AS "actorId", event_payload AS "eventPayload"
      FROM app.audit_logs
     WHERE request_id = ${requestId}
       AND action = ${action}
  `) as unknown as readonly {
    actorId: number;
    eventPayload: Record<string, unknown>;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.actorId).toBe(deletedActorId);
  expect(rows[0]!.eventPayload["actorSnapshot"]).toEqual({
    id: deletedActorId,
    name: expect.any(String),
    loginName: expect.any(String),
  });
});

test("SYSTEM chain is used when projectId is null", async () => {
  const requestId = randomUUID();
  const result = await uow!.run((tx) =>
    port!.append(tx, {
      projectId: null,
      actorType: "SYSTEM",
      actorId: null,
      action: "SYSTEM_TEST",
      targetType: "SYSTEM",
      targetId: null,
      eventPayload: { marker: "system" },
      requestId,
      clientRequestId: null,
      ipAddress: null,
      userAgent: null,
      occurredAt: new Date(),
    }),
  );
  expect(result.chainId).toBe("SYSTEM");
  const rows = (await reader!.sql`
    SELECT event_payload AS "eventPayload"
      FROM app.audit_logs
     WHERE chain_id = 'SYSTEM'
       AND request_id = ${requestId}
  `) as unknown as readonly {
    eventPayload: Record<string, unknown>;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.eventPayload["actorSnapshot"]).toBeNull();
});

test("USER audit fails closed when the actor row is missing", async () => {
  await expect(
    uow!.run((tx) =>
      port!.append(tx, {
        projectId: null,
        actorType: "USER",
        actorId: 2_147_483_647,
        action: "SYSTEM_TEST_MISSING_ACTOR",
        targetType: "USER",
        targetId: "2147483647",
        eventPayload: { marker: "must-not-write" },
        requestId: randomUUID(),
        occurredAt: new Date(),
      }),
    ),
  ).rejects.toThrow("audit actor does not exist");
});

test("port lazily rotates an existing chain when the keyring current version increases", async () => {
  const key1 = Buffer.alloc(32, 0x11);
  const key2 = Buffer.alloc(32, 0x22);
  const oldPort = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key1,
  });
  const rotatedPort = new PostgresAuditWritePort({
    currentVersion: 2,
    keyFor: (version) => (version === 1 ? key1 : key2),
  });
  const rotationProject = await createProject(runtime!.sql, userId!);
  const chainId = `PROJECT:${rotationProject.projectId}`;

  await uow!.run((tx) =>
    oldPort.append(tx, {
      projectId: rotationProject.projectId,
      actorType: "USER",
      actorId: userId!,
      action: "PROJECT_CREATED",
      targetType: "PROJECT",
      targetId: String(rotationProject.projectId),
      eventPayload: { code: rotationProject.code },
      requestId: randomUUID(),
      occurredAt: new Date(),
    }),
  );

  const result = await uow!.run((tx) =>
    rotatedPort.append(tx, {
      projectId: rotationProject.projectId,
      actorType: "USER",
      actorId: userId!,
      action: "PROJECT_EDITED",
      targetType: "PROJECT",
      targetId: String(rotationProject.projectId),
      eventPayload: { field: "description" },
      requestId: randomUUID(),
      occurredAt: new Date(),
    }),
  );
  expect(result.sequenceNo).toBe(3);

  const rows = (await reader!.sql`
    SELECT sequence_no::INTEGER AS "sequenceNo",
           key_version::INTEGER AS "keyVersion",
           action, prev_hash AS "prevHash",
           record_hash AS "recordHash",
           event_payload AS "eventPayload"
      FROM app.audit_logs
     WHERE chain_id = ${chainId}
     ORDER BY sequence_no
  `) as unknown as readonly {
    sequenceNo: number;
    keyVersion: number;
    action: string;
    prevHash: Buffer;
    recordHash: Buffer;
    eventPayload: Record<string, unknown>;
  }[];
  expect(rows).toHaveLength(3);
  expect(rows[0]!.keyVersion).toBe(1);
  expect(rows[1]!.action).toBe("AUDIT_KEY_ROTATED");
  expect(rows[1]!.keyVersion).toBe(1);
  expect(rows[1]!.eventPayload["newKeyVersion"]).toBe(2);
  expect(rows[2]!.action).toBe("PROJECT_EDITED");
  expect(rows[2]!.keyVersion).toBe(2);

  for (const row of rows) {
    const key = row.keyVersion === 1 ? key1 : key2;
    const envelope = {
      chainScope: chainId,
      sequenceNo: row.sequenceNo,
      keyVersion: row.keyVersion,
      prevHash: Buffer.from(row.prevHash).toString("base64url"),
      eventPayload: row.eventPayload,
    };
    const hash = createHmac("sha256", key)
      .update(canonicalizeJson(envelope), "utf8")
      .digest();
    expect(hash).toEqual(Buffer.from(row.recordHash));
  }

  const heads = (await reader!.sql`
    SELECT key_version::INTEGER AS "keyVersion",
           last_sequence::INTEGER AS "lastSequence"
      FROM app.audit_chain_heads
     WHERE chain_id = ${chainId}
  `) as unknown as readonly { keyVersion: number; lastSequence: number }[];
  expect(heads[0]).toMatchObject({ keyVersion: 2, lastSequence: 3 });
});

test("append inside a failed UnitOfWork rolls back business, audit log and chain head", async () => {
  const rollbackProject = await createProject(runtime!.sql, userId!);
  const chainId = `PROJECT:${rollbackProject.projectId}`;
  const originalName = `Rollback ${rollbackProject.code}`;
  await runtime!.sql`
    UPDATE app.projects
       SET name = ${originalName},
           row_version = row_version + 1
     WHERE id = ${rollbackProject.projectId}
  `;

  await expect(
    uow!.run(async (tx) => {
      await tx.sql`
        UPDATE app.projects
           SET name = 'changed-in-rolled-back-transaction',
               row_version = row_version + 1
         WHERE id = ${rollbackProject.projectId}
      `;
      await port!.append(tx, {
        projectId: rollbackProject.projectId,
        actorType: "USER",
        actorId: userId!,
        action: "ROLLBACK_PROOF",
        targetType: "PROJECT",
        targetId: String(rollbackProject.projectId),
        eventPayload: { marker: "must-rollback" },
        requestId: randomUUID(),
        occurredAt: new Date(),
      });
      throw new Error("force audit transaction rollback");
    }),
  ).rejects.toThrow("force audit transaction rollback");

  const [project] = (await runtime!.sql`
    SELECT name
      FROM app.projects
     WHERE id = ${rollbackProject.projectId}
  `) as unknown as readonly { name: string }[];
  expect(project?.name).toBe(originalName);

  const [audit] = (await reader!.sql`
    SELECT count(*)::INTEGER AS count
      FROM app.audit_logs
     WHERE chain_id = ${chainId}
  `) as unknown as readonly { count: number }[];
  expect(audit?.count).toBe(0);

  const [head] = (await reader!.sql`
    SELECT count(*)::INTEGER AS count
      FROM app.audit_chain_heads
     WHERE chain_id = ${chainId}
  `) as unknown as readonly { count: number }[];
  expect(head?.count).toBe(0);
});
