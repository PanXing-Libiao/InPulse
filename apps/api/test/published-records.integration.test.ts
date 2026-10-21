import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { RecordPublicationAccess } from "../src/modules/change-records/record-publication-access.js";
import { RecordPublicationRepository } from "../src/modules/change-records/record-publication.repository.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresTaskQueryPort } from "../src/modules/tasks/task-query.port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PublishedRecordRepository } from "../src/modules/change-records/published-record.repository.js";
import { PublishedRecordReadService } from "../src/modules/change-records/published-record-read.service.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import { PublishedRecordsHttpService } from "../src/modules/change-records/published-records-http.service.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
} from "./database.helpers.js";
let client: DatabaseClient,
  uow: PostgresUnitOfWork,
  read: PublishedRecordReadService,
  http: PublishedRecordsHttpService;
const ring = VersionedHmacKeyring.fromEntries(
  [{ version: 1, key: randomBytes(32) }],
  1,
);
const content = {
  title: "正式记录",
  contextProblem: "版本并发问题",
  changeSolution: "数据库事务",
  resultVerification: "验证一",
  remainingIssues: [],
};
beforeAll(() => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f18-records",
  });
  uow = new PostgresUnitOfWork(client);
  read = new PublishedRecordReadService(
    new PostgresProjectAccessQueryPort(client),
    uow,
    new PublishedRecordRepository(),
    new TimeCursorService(ring, "CHANGE_RECORDS"),
  );
  http = new PublishedRecordsHttpService(
    new SessionAuthService(
      uow,
      new PostgresUserSessionRepository(),
      new SessionTokenService(ring),
    ),
    read,
  );
});
afterAll(async () => client?.close());
async function fixture() {
  const userId = await createUser(client.sql),
    project = await createProject(client.sql, userId);
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      {
        projectId: project.projectId,
        moduleId: project.moduleId,
        featureId: null,
        impactFeatureIds: [],
      },
      userId,
      content,
    ),
  );
  // Preexisting formal data fixture; it makes no assumptions about pending text-to-leftover rules.
  await uow.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) SELECT id,project_id,1,title,current_payload,${userId} FROM app.change_records WHERE id=${draft.id}`;
    await tx.sql`UPDATE app.change_records SET status='PUBLISHED',code=${project.code + "-CR-1"},current_version=1,published_at=clock_timestamp(),row_version=row_version+1 WHERE id=${draft.id}`;
  });
  return { ...project, userId, draft };
}
async function publishAdditionalRecord(
  f: Awaited<ReturnType<typeof fixture>>,
  sequence: number,
  title: string,
) {
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      {
        projectId: f.projectId,
        moduleId: f.moduleId,
        featureId: null,
        impactFeatureIds: [],
      },
      f.userId,
      { ...content, title },
    ),
  );
  await uow.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) SELECT id,project_id,1,title,current_payload,${f.userId} FROM app.change_records WHERE id=${draft.id}`;
    await tx.sql`UPDATE app.change_records SET status='PUBLISHED',code=${f.code + "-CR-" + sequence},current_version=1,published_at=clock_timestamp(),row_version=row_version+1 WHERE id=${draft.id}`;
  });
  return draft;
}
describe("F18 formal record reads", () => {
  it("allocates formal record codes transactionally and rolls back a failed allocation", async () => {
    const userId = await createUser(client.sql),
      project = await createProject(client.sql, userId),
      codes = new PostgresProjectCodePort();
    await expect(
      uow.run(async (tx) => {
        await codes.allocateChangeRecordCode(tx, project.projectId);
        throw Error("rollback code");
      }),
    ).rejects.toThrow("rollback code");
    const values = await Promise.all(
      [1, 2].map(() =>
        uow.run((tx) => codes.allocateChangeRecordCode(tx, project.projectId)),
      ),
    );
    expect(values.sort()).toEqual([
      project.code + "-CR-1",
      project.code + "-CR-2",
    ]);
    expect(
      await client.sql`SELECT 1 FROM app.code_sequences WHERE project_id=${project.projectId} AND entity_type='TASK'`,
    ).toHaveLength(0);
  });
  it("reads current content and immutable historical versions without counting drafts", async () => {
    const f = await fixture();
    await uow.run((tx) =>
      new RecordDraftRepository().create(
        tx,
        {
          projectId: f.projectId,
          moduleId: f.moduleId,
          featureId: null,
          impactFeatureIds: [],
        },
        f.userId,
        { ...content, title: "仍为草稿" },
      ),
    );
    const next = {
      contextProblem: content.contextProblem,
      changeSolution: content.changeSolution,
      resultVerification: "验证二",
      // 模拟多条化之前写入的历史版本：遗留问题仍是字符串，读取时必须归一化为数组。
      remainingIssues: "",
    };
    await uow.run(async (tx) => {
      await tx.sql`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) VALUES(${f.draft.id},${f.projectId},2,'修订标题',${JSON.stringify(next)}::jsonb,${f.userId})`;
      await tx.sql`UPDATE app.change_records SET current_version=2,title='修订标题',current_payload=${JSON.stringify(next)}::jsonb,row_version=row_version+1 WHERE id=${f.draft.id}`;
    });
    expect(await read.list(f.userId, f.projectId, {})).toMatchObject({
      items: [
        {
          id: f.draft.id,
          currentVersion: 2,
          title: "修订标题",
          resultVerification: "验证二",
        },
      ],
    });
    expect(
      await read.read(f.userId, f.projectId, f.draft.id, true, 1),
    ).toMatchObject({ ...content, versionNo: 1 });
    expect(
      await read.read(f.userId, f.projectId, f.draft.id, true),
    ).toMatchObject({
      items: [
        { versionNo: 2, remainingIssues: [], leftovers: [] },
        { versionNo: 1 },
      ],
    });
    await expect(
      read.read(f.userId, f.projectId, f.draft.id, true, 3),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.sql`UPDATE app.change_record_versions SET title_snapshot='不得改写' WHERE record_id=${f.draft.id}`,
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("uses current status and membership, preserves published-after-restore visibility, and never exposes VOID", async () => {
    const f = await fixture(),
      outsider = await createUser(client.sql);
    await expect(
      read.read(outsider, f.projectId, f.draft.id, true),
    ).rejects.toMatchObject({ status: 404 });
    await client.sql`UPDATE app.change_records SET status='VOID',voided_at=clock_timestamp(),void_reason='测试快照',row_version=row_version+1 WHERE id=${f.draft.id}`;
    await expect(
      read.read(f.userId, f.projectId, f.draft.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(await read.list(f.userId, f.projectId, {})).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    await client.sql`UPDATE app.change_records SET status='PUBLISHED',row_version=row_version+1 WHERE id=${f.draft.id}`;
    expect(await read.read(f.userId, f.projectId, f.draft.id)).toMatchObject({
      id: f.draft.id,
      status: "PUBLISHED",
    });
    await removeMember(client.sql, f.projectId, f.userId);
    await expect(
      read.read(f.userId, f.projectId, f.draft.id, true, 1),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects anonymous reads through the HTTP boundary before exposing record identity", async () => {
    const result = await http.handle("getChangeRecord", {
      headers: {},
      params: { projectId: 1, recordId: 1 },
      query: {},
    });
    expect(result).toMatchObject({
      status: 401,
      body: { code: "RECORD_SESSION_REQUIRED", requestId: expect.any(String) },
    });
  });
  it("pages published records newest-first with the signed keyset cursor", async () => {
    const f = await fixture();
    const second = await publishAdditionalRecord(f, 2, "补充分页记录二");
    const third = await publishAdditionalRecord(f, 3, "补充分页记录三");
    const newestFirst = [third.id, second.id, f.draft.id];
    const first = await read.list(f.userId, f.projectId, { limit: 2 });
    expect(first.items.map((x) => x.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const rest = await read.list(f.userId, f.projectId, {
      limit: 2,
      cursor: cursor!,
    });
    expect(rest.items.map((x) => x.id)).toEqual(newestFirst.slice(2));
    expect(rest).toMatchObject({ hasMore: false, nextCursor: null });
    const other = await createProject(client.sql, f.userId);
    await expect(
      read.list(f.userId, other.projectId, { cursor: cursor! }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
  });
});
function publicationAccess() {
  return new RecordPublicationAccess(
    new PostgresProjectAccessQueryPort(client),
    new PostgresModuleQueryPort(),
    new PostgresFeatureQueryPort(),
    new PostgresTaskQueryPort(),
    new RecordPublicationRepository(),
  );
}
async function sourceFixture(status: "TODO" | "DONE" | "CANCELED") {
  const userId = await createUser(client.sql),
    project = await createProject(client.sql, userId),
    tasks = new TaskManagementRepository();
  const task = await uow.run(async (tx) => {
    const t = await tasks.create(
      tx,
      { ...project, featureId: null },
      userId,
      project.code + "-T-1",
      {
        title: "来源任务",
        description: "",
        assigneeIds: [userId],
        priority: "NORMAL",
        dueAt: null,
      },
    );
    return status === "TODO"
      ? t
      : (await tasks.transition(
          tx,
          t,
          userId,
          status,
          status === "DONE" ? "测试验证" : null,
          "fixture",
        ))!;
  });
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      { ...project, featureId: null, impactFeatureIds: [] },
      userId,
      content,
      { taskId: task.id, handlerId: userId },
    ),
  );
  return { ...project, userId, task, draft, tasks };
}
describe("F18 publishing lock prerequisites", () => {
  // ADR-047：来源任务的完成状态不再是发布门禁——未完成与已取消的来源都能就地发布，
  // 取锁、锁内重读与归属校验保持不变。
  it.each(["TODO", "CANCELED"] as const)(
    "opens %s sources under locks without modifying tasks or drafts",
    async (status) => {
      const f = await sourceFixture(status);
      await expect(
        uow.run((tx) =>
          publicationAccess().prepare(
            tx,
            f.userId,
            f.projectId,
            f.draft.id,
            true,
          ),
        ),
      ).resolves.toMatchObject({
        record: { id: f.draft.id, status: "DRAFT" },
        source: { taskId: f.task.id, workStatus: status },
      });
      expect(
        await client.sql`SELECT 1 FROM app.change_record_versions WHERE record_id=${f.draft.id}`,
      ).toHaveLength(0);
      expect(
        await uow.run((tx) =>
          new RecordDraftRepository().find(tx, f.projectId, f.draft.id),
        ),
      ).toEqual(f.draft);
      expect(
        await uow.run((tx) =>
          f.tasks.find(
            tx,
            { projectId: f.projectId, moduleId: f.moduleId, featureId: null },
            f.task.id,
          ),
        ),
      ).toEqual(f.task);
    },
  );
  it("does not use a later reopened task to forbid revising published history", async () => {
    const f = await sourceFixture("DONE");
    expect(
      await uow.run((tx) =>
        publicationAccess().prepare(
          tx,
          f.userId,
          f.projectId,
          f.draft.id,
          true,
        ),
      ),
    ).toMatchObject({ source: { workStatus: "DONE" } });
    await uow.run(async (tx) => {
      await tx.sql`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) SELECT id,project_id,1,title,current_payload,${f.userId} FROM app.change_records WHERE id=${f.draft.id}`;
      await tx.sql`UPDATE app.change_records SET status='PUBLISHED',code=${f.code + "-CR-1"},current_version=1,published_at=clock_timestamp(),row_version=row_version+1 WHERE id=${f.draft.id}`;
      await f.tasks.transition(tx, f.task, f.userId, "TODO", null, "补充工作");
    });
    expect(
      await uow.run((tx) =>
        publicationAccess().prepare(
          tx,
          f.userId,
          f.projectId,
          f.draft.id,
          false,
        ),
      ),
    ).toMatchObject({ record: { status: "PUBLISHED" } });
  });
  it("re-reads the source under the lock after a concurrent reopening transaction", async () => {
    const f = await sourceFixture("DONE");
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        acquired = r;
      });
    const reopen = uow.run(async (tx) => {
      await f.tasks.transition(tx, f.task, f.userId, "TODO", null, "并发重开");
      acquired();
      await gate;
    });
    await ready;
    // ADR-047 之后这里断言的不再是「重开后拒绝发布」，而是必须等到任务锁、重读到最新
    // 来源状态后才发布：完成状态不再是门禁，但来源归属与其版本仍是锁内真相。
    const pending = uow
      .run((tx) =>
        publicationAccess().prepare(
          tx,
          f.userId,
          f.projectId,
          f.draft.id,
          true,
        ),
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name='inpulse-f18-records' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`
            ).length,
          ).toBeGreaterThan(0),
        { timeout: 4000, interval: 30 },
      );
    } finally {
      release();
      await reopen;
    }
    const outcome = await pending;
    if (!outcome.ok) throw outcome.error;
    expect(outcome.value).toMatchObject({
      record: { id: f.draft.id, status: "DRAFT" },
      source: { taskId: f.task.id, workStatus: "TODO" },
    });
  });
});
