import { PostgresMyTaskQueryPort } from "../src/modules/change-records/my-task-query.port.js";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { TaskCreateController } from "../src/workflows/task-create.controller.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { taskCreateRequestSchema } from "@inpulse/api-contract";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
import type { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { ProjectCreationLockPort } from "../src/modules/projects/project-creation-lock.port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { ModuleManagementRepository } from "../src/modules/modules/module-management.repository.js";
import { ModulesManagementService } from "../src/modules/modules/modules-management.service.js";
import { ModuleCreateCommandPort } from "../src/modules/modules/create.command-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { FeatureManagementRepository } from "../src/modules/features/feature-management.repository.js";
import { FeaturesManagementService } from "../src/modules/features/features-management.service.js";
import { FeatureCreateCommandPort } from "../src/modules/features/create.command-port.js";
import { FeatureCandidatesQueryPort } from "../src/modules/search/index.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { TaskCreateCommandPort } from "../src/modules/tasks/create.command-port.js";
import { TaskCreateWorkflow } from "../src/workflows/task-create.workflow.js";
import { TaskCreateHttpService } from "../src/workflows/task-create-http.service.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
} from "./database.helpers.js";

let db: DatabaseClient;
let uow: PostgresUnitOfWork;
let workflow: TaskCreateWorkflow;
let tasks: TasksManagementService;
const key = randomBytes(32);
beforeAll(() => {
  db = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-task-scope-test",
  });
  uow = new PostgresUnitOfWork(db);
  const access = new PostgresProjectAccessQueryPort(db),
    codes = new PostgresProjectCodePort();
  const moduleRead = new PostgresModuleReadPort(),
    moduleQuery = new PostgresModuleQueryPort();
  const featureRead = new PostgresFeatureReadPort();
  const audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key,
  });
  const activity = new PostgresActivityWritePort(),
    search = new PostgresSearchProjectionWritePort();
  const modules = new ModulesManagementService(
    access,
    uow,
    new ModuleManagementRepository(),
    audit,
    activity,
    search,
  );
  const features = new FeaturesManagementService(
    access,
    new FeatureCandidatesQueryPort(),
    moduleQuery,
    moduleRead,
    codes,
    uow,
    new FeatureManagementRepository(),
    audit,
    activity,
    search,
    new PostgresUserReadPort(),
  );
  tasks = new TasksManagementService(
    access,
    moduleQuery,
    new PostgresFeatureQueryPort(),
    featureRead,
    codes,
    new PostgresProjectMembersQueryPort(),
    uow,
    new TaskManagementRepository(),
    audit,
    activity,
    search,
    new PostgresNotificationWritePort(),
    moduleRead,
    new PostgresProjectsWritePort(),
    new PostgresUserReadPort(),
  );
  workflow = new TaskCreateWorkflow(
    new ProjectCreationLockPort(),
    access,
    new ModuleCreateCommandPort(modules),
    new FeatureCreateCommandPort(features),
    new TaskCreateCommandPort(tasks),
  );
});
afterAll(async () => {
  await db?.close();
});
const input = (assigneeId: number, moduleName = "自建模块") =>
  taskCreateRequestSchema.parse({
    module: { kind: "new", input: { name: moduleName } },
    feature: {
      kind: "new",
      input: { name: "新功能", acceptanceCriteria: "响应低于 400ms" },
    },
    task: {
      title: "联合创建",
      description: "",
      priority: "NORMAL",
      dueAt: null,
      assigneeIds: [assigneeId],
    },
    impactFeatureIds: [],
  });
async function fixture() {
  const userId = await createUser(db.sql);
  return createProject(db.sql, userId);
}

it("联合创建在一个事务中落库并分配项目业务编号", async () => {
  const f = await fixture();
  const result = await uow.run((tx) =>
    workflow.execute(tx, f.userId, f.projectId, input(f.userId), randomUUID()),
  );
  const [row] =
    await db.sql`SELECT m.code AS module_code,f.code AS feature_code,f.acceptance_criteria,t.code AS task_code FROM app.tasks t JOIN app.modules m ON m.id=t.module_id AND m.project_id=t.project_id JOIN app.features f ON f.id=t.feature_id AND f.project_id=t.project_id WHERE t.id=${result.taskId}`;
  expect(row).toEqual({
    module_code: f.code + "-M-2",
    feature_code: f.code + "-F-1",
    acceptance_criteria: "响应低于 400ms",
    task_code: f.code + "-T-1",
  });
});
it("无效负责人让已创建模块、功能、编号、投影整笔回滚", async () => {
  const f = await fixture(),
    outsider = await createUser(db.sql);
  await expect(
    uow.run((tx) =>
      workflow.execute(
        tx,
        f.userId,
        f.projectId,
        input(outsider),
        randomUUID(),
      ),
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(
    await db.sql`SELECT id FROM app.modules WHERE project_id=${f.projectId}`,
  ).toHaveLength(1);
  for (const table of [
    "features",
    "tasks",
    "activity_projection",
    "search_projection",
  ]) {
    expect(
      await db.sql`SELECT 1 FROM ${db.sql("app." + table)} WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  }
  const sequence =
    await db.sql`SELECT entity_type,last_number FROM app.code_sequences WHERE project_id=${f.projectId}`;
  expect(sequence).toEqual([{ entity_type: "MODULE", last_number: 1 }]);
});
it("项目创建锁与已有任务创建并发时保留唯一编号且没有孤立内容", async () => {
  const f = await fixture();
  const results = await Promise.all([
    ...[1, 2, 3].map((n) =>
      uow.run((tx) =>
        workflow.execute(
          tx,
          f.userId,
          f.projectId,
          input(f.userId, "并发模块" + n),
          randomUUID(),
        ),
      ),
    ),
    uow.run((tx) =>
      tasks.execute(tx, {
        operation: "createModuleTask",
        actorId: f.userId,
        projectId: f.projectId,
        moduleId: f.moduleId,
        featureId: null,
        edit: input(f.userId).task,
        impactFeatureIds: [],
        requestId: randomUUID(),
      }),
    ),
  ]);
  expect(results).toHaveLength(4);
  const [counts] =
    await db.sql`SELECT count(*)::int AS total,count(DISTINCT code)::int AS codes FROM app.tasks WHERE project_id=${f.projectId}`;
  expect(counts).toEqual({ total: 4, codes: 4 });
});
it("整笔幂等重放不重复建归属，成员移除后拒绝重放", async () => {
  const f = await fixture();
  // Authentication itself is covered by session HTTP tests; exercise the real DB idempotency runner and project authorization here.
  const auth = {
    verify: async () => ({ userId: f.userId }),
  } as unknown as AuthenticatedMutationService;
  const service = new TaskCreateHttpService(
    auth,
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    workflow,
  );
  const headers = {
    host: "localhost",
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "x-csrf-token": "a".repeat(43),
    "idempotency-key": randomUUID(),
  };
  const body = input(f.userId);
  const first = await service.create(headers, f.projectId, body);
  expect(await service.create(headers, f.projectId, body)).toEqual(first);
  expect(
    await db.sql`SELECT id FROM app.modules WHERE project_id=${f.projectId}`,
  ).toHaveLength(2);
  await expect(
    service.create(headers, f.projectId, {
      ...body,
      task: { ...body.task, title: "changed" },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await removeMember(db.sql, f.projectId, f.userId);
  await expect(
    service.create(headers, f.projectId, body),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it("成员目录按真实项目授权，跨项目和已移除成员不可见", async () => {
  const f = await fixture(),
    outsider = await createUser(db.sql),
    port = new PostgresProjectMembersQueryPort();
  const members = await uow.run((tx) =>
    port.listActiveMembers(tx, {
      actorUserId: f.userId,
      projectId: f.projectId,
    }),
  );
  expect(members?.map((member) => member.id)).toEqual([f.userId]);
  expect(
    await uow.run((tx) =>
      port.listActiveMembers(tx, {
        actorUserId: outsider,
        projectId: f.projectId,
      }),
    ),
  ).toBeUndefined();
  await removeMember(db.sql, f.projectId, f.userId);
  expect(
    await uow.run((tx) =>
      port.listActiveMembers(tx, {
        actorUserId: f.userId,
        projectId: f.projectId,
      }),
    ),
  ).toBeUndefined();
});

it("真实 HTTP 联合创建契约返回 200，非法归属在写入前拒绝", async () => {
  const f = await fixture();
  const auth = {
    verify: async () => ({ userId: f.userId }),
  } as unknown as AuthenticatedMutationService;
  const http = new TaskCreateHttpService(
    auth,
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    workflow,
  );
  class TestModule {}
  Module({
    controllers: [TaskCreateController],
    providers: [{ provide: TaskCreateHttpService, useValue: http }],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ContractResponseInterceptor());
  await app.listen(0, "127.0.0.1");
  try {
    const base = await app.getUrl();
    const request = (body: unknown) =>
      fetch(`${base}/api/v1/projects/${f.projectId}/tasks`, {
        method: "POST",
        headers: {
          origin: base,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "x-csrf-token": "a".repeat(43),
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(body),
      });
    const invalid = await request({
      ...input(f.userId),
      feature: { kind: "existing", id: 1 },
    });
    expect(invalid.status).toBe(422);
    const response = await request(input(f.userId));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      projectId: f.projectId,
      moduleId: expect.any(Number),
      featureId: expect.any(Number),
      taskId: expect.any(Number),
    });
  } finally {
    await app.close();
  }
});

it("逾期在分页前过滤，新建未逾期任务不会挤掉较早的逾期任务", async () => {
  const f = await fixture(),
    other = await createUser(db.sql);
  await db.sql`INSERT INTO app.project_members(project_id,user_id) VALUES(${f.projectId},${other})`;
  const dueAt = new Date(Date.now() - 86400000).toISOString();
  const created = [];
  for (const [title, due, assigneeId] of [
    ["旧逾期一", dueAt, f.userId],
    ["旧逾期二", dueAt, other],
    ["新未逾期", null, f.userId],
  ] as const) {
    created.push(
      await uow.run((tx) =>
        tasks.execute(tx, {
          operation: "createModuleTask",
          actorId: f.userId,
          projectId: f.projectId,
          moduleId: f.moduleId,
          featureId: null,
          impactFeatureIds: [],
          edit: {
            ...input(f.userId).task,
            title,
            dueAt: due,
            assigneeIds: [assigneeId],
          },
          requestId: randomUUID(),
        }),
      ),
    );
  }
  const query = new PostgresMyTaskQueryPort();
  const first = await uow.run((tx) =>
    query.list(tx, { projectIds: [f.projectId], overdue: true, limit: 1 }),
  );
  // ADR-037：两条逾期任务同桶、同优先级、同截止时间，按 id 升序兜底。
  expect(first.items.map((item) => item.taskId)).toEqual([created[0]!.id]);
  expect(first.hasMore).toBe(true);
  const second = await uow.run((tx) =>
    query.list(tx, {
      projectIds: [f.projectId],
      overdue: true,
      limit: 1,
      after: first.next!,
    }),
  );
  expect(second.items.map((item) => item.taskId)).toEqual([created[1]!.id]);
  expect(second.hasMore).toBe(false);
});
