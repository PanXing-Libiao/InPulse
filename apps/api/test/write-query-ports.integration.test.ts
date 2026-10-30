import "reflect-metadata";
import { setTimeout } from "node:timers/promises";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import type { TransactionContext } from "../src/database/transaction-context.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import {
  ModuleQueryPort,
  ModulesModule,
} from "../src/modules/modules/index.js";
import { createProject, createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient;
let writer: DatabaseClient;
let moduleContext: INestApplicationContext;
let modules: ModuleQueryPort;
let uow: PostgresUnitOfWork;
let userId: number;

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, { maxConnections: 1 });
  writer = createDatabaseClient(testUrls().runtime, { maxConnections: 1 });
  expect((await client.sql`SELECT current_user AS role`)[0]?.role).toBe(
    "app_runtime",
  );
  expect((await writer.sql`SELECT current_user AS role`)[0]?.role).toBe(
    "app_runtime",
  );
  uow = new PostgresUnitOfWork(client);
  userId = await createUser(client.sql);
  moduleContext = await NestFactory.createApplicationContext(ModulesModule, {
    logger: false,
  });
  modules = moduleContext.get(ModuleQueryPort);
});

afterAll(async () => {
  await moduleContext?.close();
  await writer?.close();
  await client?.close();
});

async function fixture() {
  // Existing helper commits a valid project, creator membership and an unclassified module.
  const project = await createProject(client.sql, userId);
  const [module] = await client.sql<{ id: number }[]>`
    INSERT INTO app.modules (project_id, name, created_by)
    VALUES (${project.projectId}, 'Normal fixture', ${userId}) RETURNING id
  `;
  if (!module) throw new Error("Missing module fixture");
  return {
    projectId: project.projectId,
    moduleId: module.id,
    otherModuleId: project.moduleId,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Domain = "module";
async function check(domain: Domain, tx: TransactionContext, input: Fixture) {
  void domain;
  return modules.checkModuleForWrite(tx, input);
}
/** ADR-044 / ADR-109：模块没有状态列，摘要只剩归属与 row_version。 */
function summary(domain: Domain, f: Fixture, rowVersion = 1) {
  return {
    projectId: f.projectId,
    moduleId: f.moduleId,
    rowVersion,
  };
}
/**
 * 对行做一次真实写入并递增 row_version：模块只做改名（ADR-044 起模块没有可写的生命周期状态；ADR-109 已移除功能层）。
 */
async function writeRow(tx: TransactionContext, domain: Domain, f: Fixture) {
  void domain;
  await tx.sql`UPDATE app.modules SET name = 'Renamed fixture', row_version = row_version + 1 WHERE id = ${f.moduleId}`;
}
/** 写入后的公共读取结果只有 allowed，不再有归档只读态。 */
function afterWrite(domain: Domain, f: Fixture) {
  return { kind: "allowed" as const, resource: summary(domain, f, 2) };
}

for (const domain of ["module"] as const) {
  test(`${domain}: active, absent and wrong ownership have exact public results`, async () => {
    const f = await fixture();
    const otherProject = await createProject(client.sql, userId);
    await uow.run(async (tx) => {
      expect(await check(domain, tx, f)).toEqual({
        kind: "allowed",
        resource: summary(domain, f),
      });
      expect(
        await check(domain, tx, {
          ...f,
          moduleId: -1,
        }),
      ).toEqual({ kind: "not-found" });
      expect(
        await check(domain, tx, { ...f, projectId: otherProject.projectId }),
      ).toEqual({
        kind: "not-found",
      });
      await writeRow(tx, domain, f);
      expect(await check(domain, tx, f)).toEqual(afterWrite(domain, f));
      expect(await check(domain, tx, { ...f, projectId: -1 })).toEqual({
        kind: "not-found",
      });
    });
  });

  for (const end of ["commit", "rollback"] as const) {
    test(`${domain}: FOR SHARE blocks a real row UPDATE until ${end}`, async () => {
      const f = await fixture();
      const rollback = new Error("Release holder by rollback");
      let update: Promise<void> | undefined;
      let updateError: unknown;
      let updated = false;
      try {
        const holding = uow.run(async (tx) => {
          expect((await check(domain, tx, f)).kind).toBe("allowed");
          const [holder] = await tx.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          let announce!: (pid: number) => void;
          const ready = new Promise<number>((resolve) => {
            announce = resolve;
          });
          update = new PostgresUnitOfWork(writer)
            .run(async (other) => {
              await other.sql`SET LOCAL statement_timeout = '10s'`;
              const [session] = await other.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`;
              if (!session) throw new Error("Missing writer PID");
              announce(session.pid);
              await writeRow(other, domain, f);
              updated = true;
            })
            .catch((error: unknown) => {
              updateError = error;
              announce(-1);
            });
          const writerPid = await ready;
          expect(writerPid).not.toBe(holder?.pid);
          let blocked = false;
          const deadline = Date.now() + 5000;
          while (
            Date.now() < deadline &&
            !blocked &&
            !updated &&
            updateError === undefined
          ) {
            const [row] = await tx.sql<{ blocked: boolean }[]>`
              SELECT ${holder!.pid} = ANY(pg_blocking_pids(${writerPid})) AS blocked
            `;
            blocked = row?.blocked === true;
            if (!blocked) await setTimeout(20);
          }
          expect(updateError).toBeUndefined();
          expect(blocked).toBe(true);
          expect(updated).toBe(false);
          if (end === "rollback") throw rollback;
        });
        if (end === "rollback") await expect(holding).rejects.toBe(rollback);
        else await holding;
      } finally {
        await update;
      }
      expect(updateError).toBeUndefined();
      expect(updated).toBe(true);
      // Independent transaction after both connections finish proves release and persistence.
      expect(await uow.run((tx) => check(domain, tx, f))).toEqual(
        afterWrite(domain, f),
      );
    });
  }
}
