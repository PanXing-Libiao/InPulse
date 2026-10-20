import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
import { RecordSummaryQueryService } from "../src/modules/aggregate-read/record-summary-query.service.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectQueryPort } from "../src/modules/projects/postgres-project-query-port.js";
import {
  PostgresChangeRecordReadPort,
  type RecordSummaryReadInput,
} from "../src/modules/change-records/change-record-read.port.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import {
  PostgresTaskQueryPort,
  type SummaryTaskReadInput,
} from "../src/modules/tasks/task-query.port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { createProject, createUser, testUrls } from "./database.helpers.js";

// F-33 迭代总结取数端口（summaryRecords / summaryLeftovers / summaryCompletedTasks）
// 的真实 PostgreSQL 验收：日期边界按 Asia/Shanghai 自然日换算、只取 PUBLISHED 与
// 未失效的 DONE、总数不受 limit 截断、空授权范围短路。全部在真实约束下验证，
// 不使用 mock。

let client: DatabaseClient | undefined;
let uow: PostgresUnitOfWork;
const records = new PostgresChangeRecordReadPort();
const tasks = new PostgresTaskQueryPort();
const draftWrites = new RecordDraftRepository();
const taskWrites = new TaskManagementRepository();

let sequence = 0;

const baseMs = Date.now();

/** 相对当前时刻的 ISO 时间戳：published_at / completed_at 不能早于 created_at。 */
function isoAt(minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

function isoDays(days: number): string {
  return new Date(baseMs + days * 86_400_000).toISOString();
}

/** Asia/Shanghai 自然日（YYYY-MM-DD），与端口内日界换算保持同一时区。 */
function shanghaiDay(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(baseMs + offsetDays * 86_400_000));
}

interface ProjectScope {
  readonly code: string;
  readonly projectId: number;
  readonly moduleId: number;
  readonly featureId: number;
  readonly userId: number;
}

const recordContent = {
  title: "迭代总结夹具记录",
  contextProblem: "上下文问题",
  changeSolution: "变更方案",
  resultVerification: "验证结果",
  remainingIssues: [],
};

function nextSuffix(kind: "T" | "F" | "CR"): string {
  sequence += 1;
  return "-" + kind + "-" + String(sequence);
}

async function newFeature(scope: {
  readonly projectId: number;
  readonly moduleId: number;
  readonly userId: number;
  readonly code: string;
}): Promise<number> {
  const [row] = await client!.sql<{ id: number }[]>`
    INSERT INTO app.features (project_id, module_id, code, name, created_by)
    VALUES (${scope.projectId}, ${scope.moduleId}, ${scope.code + nextSuffix("F")}, '总结夹具功能', ${scope.userId})
    RETURNING id
  `;
  if (!row) throw new Error("feature fixture insert returned no row");
  return row.id;
}

/** 发布一条记录并可指定 published_at（用文本直接转 timestamptz，绕过进程时区）。 */
async function newPublishedRecord(
  scope: ProjectScope,
  options: {
    readonly featureId?: number | null;
    readonly publishedAt: string;
    readonly status?: "PUBLISHED" | "VOID";
    readonly authorUserId?: number;
  },
): Promise<number> {
  const code = scope.code + nextSuffix("CR");
  const author = options.authorUserId ?? scope.userId;
  const draft = await uow.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
        featureId: options.featureId ?? null,
        impactFeatureIds: [],
      },
      author,
      recordContent,
    ),
  );
  await uow.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by) SELECT id, project_id, 1, title, current_payload, ${author} FROM app.change_records WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    await tx.sql`UPDATE app.change_records SET status = 'PUBLISHED', code = ${code}, current_version = 1, published_at = ${options.publishedAt}::timestamptz, row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    if (options.status === "VOID") {
      await tx.sql`UPDATE app.change_records SET status = 'VOID', voided_at = GREATEST(clock_timestamp(), published_at), void_reason = '总结夹具作废', row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    }
  });
  return draft.id;
}

async function newLeftover(
  scope: ProjectScope,
  recordId: number,
  status: "ACTIVE" | "CONVERTED" | "RESOLVED",
  content: string,
): Promise<number> {
  return uow.run(async (tx) => {
    const [row] = await tx.sql<{ id: number }[]>`
      INSERT INTO app.change_record_leftover_items (record_id, project_id, status, created_by)
      VALUES (${recordId}, ${scope.projectId}, ${status}, ${scope.userId})
      RETURNING id
    `;
    if (!row) throw new Error("leftover fixture insert returned no row");
    await tx.sql`
      INSERT INTO app.change_record_version_leftovers (leftover_item_id, record_id, project_id, version_no, content_snapshot)
      VALUES (${row.id}, ${recordId}, ${scope.projectId}, 1, ${content})
    `;
    return row.id;
  });
}

/**
 * 完成任务夹具：走真实 transition（completed_at 与状态历史快照天然一致，
 * app_runtime 对 task_status_history 只有 SELECT/INSERT）。lifecycle 用于构造已失效任务。
 */
async function newCompletedTask(
  scope: ProjectScope,
  options: {
    readonly featureId?: number | null;
    readonly assigneeUserId?: number;
    readonly lifecycleStatus?: "ACTIVE" | "ARCHIVED" | "INVALID";
  },
): Promise<number> {
  const code = scope.code + nextSuffix("T");
  const assignee = options.assigneeUserId ?? scope.userId;
  return uow.run(async (tx) => {
    const created = await taskWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
        featureId: options.featureId ?? null,
      },
      scope.userId,
      code,
      {
        title: "总结夹具任务",
        description: "",
        assigneeIds: [assignee],
        priority: "NORMAL",
        dueAt: null,
      },
    );
    const done = await taskWrites.transition(
      tx,
      created,
      scope.userId,
      "DONE",
      "总结夹具完成",
      "总结夹具",
    );
    if (!done) {
      throw new Error("task fixture transition to DONE returned no row");
    }
    if ((options.lifecycleStatus ?? "ACTIVE") !== "ACTIVE") {
      await tx.sql`UPDATE app.tasks SET lifecycle_status = ${options.lifecycleStatus!}, updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = ${done.id} AND project_id = ${scope.projectId}`;
    }
    return done.id;
  });
}

const recordInput: Omit<RecordSummaryReadInput, "projectIds"> = {
  fromDate: shanghaiDay(0),
  toDate: shanghaiDay(2),
  limit: 50,
};

const taskInput: Omit<SummaryTaskReadInput, "projectIds"> = {
  fromDate: shanghaiDay(0),
  toDate: shanghaiDay(2),
  limit: 50,
};

let scope: ProjectScope;
let outsiderScope: ProjectScope;

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-record-summary-integration-test",
  });
  uow = new PostgresUnitOfWork(client);

  const userId = await createUser(client.sql);
  const project = await createProject(client.sql, userId);
  const featureId = await newFeature({
    projectId: project.projectId,
    moduleId: project.moduleId,
    userId,
    code: project.code,
  });
  scope = {
    code: project.code,
    projectId: project.projectId,
    moduleId: project.moduleId,
    featureId,
    userId,
  };

  const outsiderUserId = await createUser(client.sql);
  const outsiderProject = await createProject(client.sql, outsiderUserId);
  const outsiderFeatureId = await newFeature({
    projectId: outsiderProject.projectId,
    moduleId: outsiderProject.moduleId,
    userId: outsiderUserId,
    code: outsiderProject.code,
  });
  outsiderScope = {
    code: outsiderProject.code,
    projectId: outsiderProject.projectId,
    moduleId: outsiderProject.moduleId,
    featureId: outsiderFeatureId,
    userId: outsiderUserId,
  };
});

afterAll(async () => {
  await client?.close();
});

describe("ChangeRecordReadPort.summaryRecords", () => {
  test("只取范围内 PUBLISHED 记录，排除草稿 / 作废 / 范围外，total 不受 limit 截断", async () => {
    const older = await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoAt(1),
    });
    const newer = await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoAt(2),
    });
    await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoAt(3),
      status: "VOID",
    });
    // 超出 toDate 的未来记录（published_at 必须不早于 created_at，无法构造历史记录）。
    await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoDays(60),
    });
    const foreign = await newPublishedRecord(outsiderScope, {
      featureId: outsiderScope.featureId,
      publishedAt: isoAt(4),
    });

    const page = await uow.run((tx) =>
      records.summaryRecords(tx, {
        ...recordInput,
        projectIds: [scope.projectId],
        limit: 1,
      }),
    );

    // hasMore 由 limit 触发，但 total 仍是范围内全量口径（只数 PUBLISHED）。
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(2);

    const all = await uow.run((tx) =>
      records.summaryRecords(tx, {
        ...recordInput,
        projectIds: [scope.projectId],
      }),
    );
    const ids = all.items.map((row) => row.recordId);
    expect(ids).toEqual([newer, older]);
    expect(ids).not.toContain(foreign);
    expect(all.items.every((row) => row.projectId === scope.projectId)).toBe(
      true,
    );
    // 固定 published_at DESC：最新的排在最前。
    expect(all.items[0]?.publishedAt.getTime()).toBeGreaterThanOrEqual(
      all.items[all.items.length - 1]!.publishedAt.getTime(),
    );
    expect(
      all.items.find((row) => row.recordId === older)?.resultVerification,
    ).toBe("验证结果");

    const narrowed = await uow.run((tx) =>
      records.summaryRecords(tx, {
        ...recordInput,
        projectIds: [scope.projectId],
        authorId: outsiderScope.userId,
      }),
    );
    expect(narrowed.items).toEqual([]);
    expect(narrowed.total).toBe(0);
  });

  test("fromDate 之前与 toDate 之后的记录都排除", async () => {
    const beyondWindow = await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoDays(10),
    });

    const inWindow = await uow.run((tx) =>
      records.summaryRecords(tx, {
        ...recordInput,
        fromDate: shanghaiDay(8),
        toDate: shanghaiDay(12),
        projectIds: [scope.projectId],
      }),
    );
    expect(inWindow.items.map((row) => row.recordId)).toContain(beyondWindow);

    const afterWindow = await uow.run((tx) =>
      records.summaryRecords(tx, {
        ...recordInput,
        fromDate: shanghaiDay(12),
        toDate: shanghaiDay(14),
        projectIds: [scope.projectId],
      }),
    );
    expect(afterWindow.items.map((row) => row.recordId)).not.toContain(
      beyondWindow,
    );
    expect(afterWindow.items).toEqual([]);
  });

  test("空授权范围短路返回空页", async () => {
    const page = await uow.run((tx) =>
      records.summaryRecords(tx, { ...recordInput, projectIds: [] }),
    );
    expect(page).toEqual({ items: [], total: 0, hasMore: false });
  });
});

describe("ChangeRecordReadPort.summaryLeftovers", () => {
  test("按来源记录发布日过滤，closedTotal 计入已处理与父记录已作废项", async () => {
    const recordId = await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoAt(1),
    });
    const active = await newLeftover(scope, recordId, "ACTIVE", "还没覆盖退款");
    const converted = await newLeftover(
      scope,
      recordId,
      "CONVERTED",
      "已转任务跟进",
    );
    const voidRecord = await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoAt(2),
      status: "VOID",
    });
    const voided = await newLeftover(
      scope,
      voidRecord,
      "ACTIVE",
      "来源记录已作废",
    );
    const outOfRange = await newPublishedRecord(scope, {
      featureId: scope.featureId,
      publishedAt: isoDays(60),
    });
    await newLeftover(scope, outOfRange, "ACTIVE", "范围外遗留");

    const page = await uow.run((tx) =>
      records.summaryLeftovers(tx, {
        projectIds: [scope.projectId],
        ...recordInput,
      }),
    );

    const ids = page.items.map((row) => row.leftoverItemId);
    expect(ids).toContain(active);
    expect(ids).toContain(converted);
    expect(ids).toContain(voided);
    expect(page.items.some((row) => row.content === "范围外遗留")).toBe(false);
    expect(page.total).toBe(3);
    expect(page.closedTotal).toBe(2);
    const convertedRow = page.items.find(
      (row) => row.leftoverItemId === converted,
    );
    expect(convertedRow?.status).toBe("CONVERTED");
    expect(convertedRow?.recordCode.startsWith(scope.code)).toBe(true);
    const voidedRow = page.items.find((row) => row.leftoverItemId === voided);
    expect(voidedRow?.status).toBe("VOIDED");
    expect(voidedRow?.followupTaskId).toBeNull();
  });
});

describe("TaskQueryPort.summaryCompletedTasks", () => {
  test("只取已完成且未失效的任务，可按负责人收窄", async () => {
    const otherUser = await createUser(client!.sql);
    await client!.sql`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${scope.projectId}, ${otherUser}, 'MEMBER')
    `;
    const mine = await newCompletedTask(scope, {
      featureId: scope.featureId,
    });
    const theirs = await newCompletedTask(scope, {
      featureId: scope.featureId,
      assigneeUserId: otherUser,
    });
    await newCompletedTask(scope, {
      featureId: scope.featureId,
      lifecycleStatus: "INVALID",
    });

    const page = await uow.run((tx) =>
      tasks.summaryCompletedTasks(tx, {
        ...taskInput,
        projectIds: [scope.projectId],
      }),
    );
    const ids = page.items.map((row) => row.taskId);
    expect(ids).toContain(mine);
    expect(ids).toContain(theirs);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(ids.indexOf(theirs)).toBeLessThan(ids.indexOf(mine));

    const byAssignee = await uow.run((tx) =>
      tasks.summaryCompletedTasks(tx, {
        ...taskInput,
        projectIds: [scope.projectId],
        assigneeId: otherUser,
      }),
    );
    expect(byAssignee.items.map((row) => row.taskId)).toEqual([theirs]);
    expect(byAssignee.total).toBe(1);
  });

  test("按项目收窄与 fromDate 下界过滤，空授权范围短路", async () => {
    const outsider = await newCompletedTask(outsiderScope, {
      featureId: outsiderScope.featureId,
    });
    const narrowed = await uow.run((tx) =>
      tasks.summaryCompletedTasks(tx, {
        ...taskInput,
        projectIds: [scope.projectId],
      }),
    );
    expect(
      narrowed.items.every((row) => row.projectId === scope.projectId),
    ).toBe(true);
    expect(narrowed.items.map((row) => row.taskId)).not.toContain(outsider);

    // 完成时间都在「现在」，把 fromDate 推到后天即可命中下界过滤。
    const afterWindow = await uow.run((tx) =>
      tasks.summaryCompletedTasks(tx, {
        ...taskInput,
        fromDate: shanghaiDay(2),
        toDate: shanghaiDay(4),
        projectIds: [scope.projectId],
      }),
    );
    expect(afterWindow).toEqual({ items: [], total: 0, hasMore: false });

    const empty = await uow.run((tx) =>
      tasks.summaryCompletedTasks(tx, { ...taskInput, projectIds: [] }),
    );
    expect(empty).toEqual({ items: [], total: 0, hasMore: false });
  });
});

// 回归：服务端按契约上限（RECORD_SUMMARY_ITEM_MAX / RECORD_SUMMARY_POINT_MAX）下发取数
// limit，真实端口必须接受——此前端口沿用分页口径的 100 上限，导致线上取数必然抛
// `limit exceeds CHANGE_RECORD_READ_LIMIT_MAX (100)`。这里用真实端口把整条读链路走通。
describe("RecordSummaryQueryService（真实端口）", () => {
  test("服务端下发的总结取数上限能被真实端口接受，并返回本项目分节", async () => {
    const service = new RecordSummaryQueryService(
      new PostgresProjectAccessQueryPort(client!),
      new PostgresProjectQueryPort(client!),
      new PostgresModuleReadPort(),
      new PostgresFeatureReadPort(),
      new PostgresChangeRecordReadPort(),
      new PostgresTaskQueryPort(),
      new PostgresUserReadPort(),
      uow,
    );

    const summary = await service.get({
      actorUserId: scope.userId,
      fromDate: shanghaiDay(0),
      toDate: shanghaiDay(2),
      groupBy: "PROJECT",
    });

    expect(
      summary.sections.some((row) => row.projectId === scope.projectId),
    ).toBe(true);
    expect(summary.totals.recordCount).toBeGreaterThanOrEqual(2);
    expect(summary.truncated).toBe(false);
    expect(summary.points.every((row) => row.detail.length > 0)).toBe(true);
  });

  // 回归：授权范围内存在本期没有任何记录 / 任务的项目（如刚创建的项目）时，
  // 它不会出现在结果集里，但 scope.projectNames 仍必须解析全部范围项目——
  // 此前「按结果集取名」把它判成 `AGGREGATE_READ_INCONSISTENT` 并返回 500。
  test("范围内没有记录 / 任务的项目不会让总结失败，名称覆盖全部授权项目", async () => {
    const idleProject = await createProject(client!.sql, scope.userId);
    const service = new RecordSummaryQueryService(
      new PostgresProjectAccessQueryPort(client!),
      new PostgresProjectQueryPort(client!),
      new PostgresModuleReadPort(),
      new PostgresFeatureReadPort(),
      new PostgresChangeRecordReadPort(),
      new PostgresTaskQueryPort(),
      new PostgresUserReadPort(),
      uow,
    );

    const summary = await service.get({
      actorUserId: scope.userId,
      fromDate: shanghaiDay(0),
      toDate: shanghaiDay(2),
      groupBy: "PROJECT",
    });

    expect(summary.scope.projectIds).toEqual(
      expect.arrayContaining([scope.projectId, idleProject.projectId]),
    );
    expect(summary.scope.projectNames).toHaveLength(
      summary.scope.projectIds.length,
    );
    const nameById = new Map([
      [scope.projectId, `Project ${scope.code}`],
      [idleProject.projectId, `Project ${idleProject.code}`],
    ]);
    summary.scope.projectIds.forEach((id, index) => {
      const expectedName = nameById.get(id);
      if (expectedName !== undefined) {
        expect(summary.scope.projectNames[index]).toBe(expectedName);
      }
    });
    // 本期没有记录 / 任务的项目不进分节，不产生空分节。
    expect(
      summary.sections.some((row) => row.projectId === idleProject.projectId),
    ).toBe(false);
  });
});
