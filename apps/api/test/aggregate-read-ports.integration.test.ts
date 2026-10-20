import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import type { TransactionContext } from "../src/database/transaction-context.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import {
  FeatureReadPort,
  FeaturesModule,
} from "../src/modules/features/index.js";
import { ModuleReadPort, ModulesModule } from "../src/modules/modules/index.js";
import {
  PostgresTaskQueryPort,
  TASK_EXCLUDED_IDS_MAX,
  TaskListInputError,
  type TaskListSortKey,
} from "../src/modules/tasks/index.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import {
  CHANGE_RECORD_TASK_IDS_MAX,
  ChangeRecordReadInputError,
  PostgresChangeRecordReadPort,
} from "../src/modules/change-records/change-record-read.port.js";
import { PostgresMyTaskQueryPort } from "../src/modules/change-records/my-task-query.port.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { createProject, createUser, testUrls } from "./database.helpers.js";
import type { TestUrls } from "./database.helpers.js";
import { connect } from "./database.helpers.js";
import type { Sql } from "postgres";

// F-29 / F-32 只读端口验收（C 端口提案 §9.1、A 裁决 §7）：
// 1. 每个新方法至少 1 条真实 PostgreSQL 用例，覆盖正常 / 空 projectIds / 跨项目不返回 /
//    状态边界。
// 2. count 与不分页 list.items.length 在同一 filter 下相等。
// 3. excludedTaskIds 与 hasPublishedRecord 在分页前过滤。
// 4. 空 projectIds 短路且不发出 SQL（captureTransaction 断言零调用）。
// 5. 查询计划命中既有索引、无 Seq Scan on tasks；端口可在只读事务中执行。

let client: DatabaseClient;
let bootstrap: Sql;
let uow: PostgresUnitOfWork;
let moduleContext: INestApplicationContext;
let featureContext: INestApplicationContext;
let modules: ModuleReadPort;
let features: FeatureReadPort;
const taskQuery = new PostgresTaskQueryPort();
const myTasks = new PostgresMyTaskQueryPort();
const records = new PostgresChangeRecordReadPort();
const taskWrites = new TaskManagementRepository();
const draftWrites = new RecordDraftRepository();
let sequence = 0;

interface ProjectScope {
  readonly code: string;
  readonly moduleId: number;
  readonly projectId: number;
  readonly userId: number;
}

interface SqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

const recordContent = {
  title: "聚合读端口记录",
  contextProblem: "上下文问题",
  changeSolution: "变更方案",
  resultVerification: "验证结果",
  remainingIssues: [],
};

beforeAll(async () => {
  const urls: TestUrls = testUrls();
  client = createDatabaseClient(urls.runtime, {
    applicationName: "inpulse-aggregate-read-ports",
  });
  bootstrap = connect(urls.bootstrap, 2);
  expect((await client.sql`SELECT current_user AS role`)[0]?.role).toBe(
    "app_runtime",
  );
  uow = new PostgresUnitOfWork(client);
  moduleContext = await NestFactory.createApplicationContext(ModulesModule, {
    logger: false,
  });
  featureContext = await NestFactory.createApplicationContext(FeaturesModule, {
    logger: false,
  });
  modules = moduleContext.get(ModuleReadPort);
  features = featureContext.get(FeatureReadPort);
});

afterAll(async () => {
  await featureContext?.close();
  await moduleContext?.close();
  await client?.close();
  await bootstrap?.end({ timeout: 5 });
});

function nextSuffix(kind: "T" | "F" | "CR"): string {
  sequence += 1;
  return "-" + kind + "-" + sequence;
}

async function newProject(): Promise<ProjectScope> {
  const userId = await createUser(client.sql);
  const project = await createProject(client.sql, userId);
  return { ...project, userId };
}

async function newModule(scope: ProjectScope, name: string): Promise<number> {
  const [row] = await client.sql<{ id: number }[]>`
    INSERT INTO app.modules (project_id, name, created_by)
    VALUES (${scope.projectId}, ${name}, ${scope.userId})
    RETURNING id
  `;
  if (!row) throw new Error("module fixture insert returned no row");
  return row.id;
}

async function newFeature(
  scope: ProjectScope,
  moduleId: number,
  name: string,
): Promise<number> {
  const [row] = await client.sql<{ id: number }[]>`
    INSERT INTO app.features (project_id, module_id, code, name, created_by)
    VALUES (${scope.projectId}, ${moduleId}, ${scope.code + nextSuffix("F")}, ${name}, ${scope.userId})
    RETURNING id
  `;
  if (!row) throw new Error("feature fixture insert returned no row");
  return row.id;
}

async function addMember(projectId: number, userId: number): Promise<void> {
  await client.sql`
    INSERT INTO app.project_members (project_id, user_id)
    VALUES (${projectId}, ${userId})
  `;
}

interface TaskOptions {
  readonly assigneeIds?: number[];
  readonly featureId?: number | null;
  readonly workStatus?: "TODO" | "DONE" | "CANCELED";
  readonly lifecycleStatus?: "ACTIVE" | "INVALID";
  readonly title?: string;
  /** 创建者（app.tasks.creator_id）；缺省用项目创建者，用于构造 creator ≠ assignee 的夹具。 */
  readonly actorUserId?: number;
  /** 优先级（ADR-037 排序键的第二级）：缺省 NORMAL。 */
  readonly priority?: "NORMAL" | "HIGH" | "URGENT";
  /** 截止时间文本（由 SQL 直接转 timestamptz）：缺省无截止。 */
  readonly dueAt?: string | null;
}

async function newTask(
  scope: ProjectScope,
  options: TaskOptions = {},
): Promise<number> {
  const featureId = options.featureId ?? null;
  const workStatus = options.workStatus ?? "TODO";
  const code = scope.code + nextSuffix("T");
  const actorUserId = options.actorUserId ?? scope.userId;
  return uow.run(async (tx) => {
    const created = await taskWrites.create(
      tx,
      { projectId: scope.projectId, moduleId: scope.moduleId, featureId },
      actorUserId,
      code,
      {
        title: options.title ?? "聚合读端口任务",
        description: "",
        assigneeIds: options.assigneeIds ?? [scope.userId],
        priority: options.priority ?? "NORMAL",
        dueAt: options.dueAt ?? null,
      },
    );
    const current =
      workStatus === "TODO"
        ? created
        : (await taskWrites.transition(
            tx,
            created,
            scope.userId,
            workStatus,
            workStatus === "DONE" ? "聚合读端口夹具完成" : null,
            "聚合读端口夹具",
          ))!;
    if ((options.lifecycleStatus ?? "ACTIVE") !== "ACTIVE") {
      await tx.sql`UPDATE app.tasks SET lifecycle_status = ${options.lifecycleStatus!}, updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = ${current.id} AND project_id = ${scope.projectId}`;
    }
    return current.id;
  });
}

interface RecordOptions {
  readonly featureId?: number | null;
  readonly taskId?: number | null;
  readonly status?: "PUBLISHED" | "VOID";
}

async function newPublishedRecord(
  scope: ProjectScope,
  options: RecordOptions = {},
): Promise<number> {
  const code = scope.code + nextSuffix("CR");
  const taskId = options.taskId ?? null;
  const draft = await uow.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
        featureId: options.featureId ?? null,
        impactFeatureIds: [],
      },
      scope.userId,
      recordContent,
      taskId === null ? undefined : { taskId, handlerId: scope.userId },
    ),
  );
  await uow.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by) SELECT id, project_id, 1, title, current_payload, ${scope.userId} FROM app.change_records WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    await tx.sql`UPDATE app.change_records SET status = 'PUBLISHED', code = ${code}, current_version = 1, published_at = clock_timestamp(), row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    if (options.status === "VOID") {
      await tx.sql`UPDATE app.change_records SET status = 'VOID', voided_at = clock_timestamp(), void_reason = '聚合读端口夹具作废', row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    }
  });
  return draft.id;
}

async function newDraftRecord(
  scope: ProjectScope,
  options: {
    readonly featureId?: number | null;
    readonly taskId?: number | null;
  } = {},
): Promise<number> {
  const featureId = options.featureId ?? null;
  const taskId = options.taskId ?? null;
  const draft = await uow.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
        featureId,
        impactFeatureIds: [],
      },
      scope.userId,
      recordContent,
      taskId === null ? undefined : { taskId, handlerId: scope.userId },
    ),
  );
  return draft.id;
}

async function newRecordVersion(
  scope: ProjectScope,
  recordId: number,
  versionNo: number,
): Promise<void> {
  await uow.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by) SELECT id, project_id, ${versionNo}, title, current_payload, ${scope.userId} FROM app.change_records WHERE id = ${recordId} AND project_id = ${scope.projectId}`;
    await tx.sql`UPDATE app.change_records SET current_version = ${versionNo}, row_version = row_version + 1, updated_at = clock_timestamp() WHERE id = ${recordId} AND project_id = ${scope.projectId}`;
  });
}

async function newLeftover(
  scope: ProjectScope,
  recordId: number,
  options: {
    readonly status?: "ACTIVE" | "CONVERTED" | "RESOLVED";
    readonly contents: readonly string[];
  },
): Promise<number> {
  const status = options.status ?? "ACTIVE";
  const contents = [...options.contents];
  return uow.run(async (tx) => {
    const [row] = await tx.sql<{ id: number }[]>`
      INSERT INTO app.change_record_leftover_items (record_id, project_id, status, created_by)
      VALUES (${recordId}, ${scope.projectId}, ${status}, ${scope.userId})
      RETURNING id
    `;
    if (!row) throw new Error("leftover fixture insert returned no row");
    // change_record_version_leftovers 以 (record_id, version_no) 外键引用
    // change_record_versions；草稿记录没有版本，快照行只能按现有版本写入。
    const [record] = await tx.sql<{ currentVersion: number }[]>`
      SELECT current_version AS "currentVersion"
        FROM app.change_records
       WHERE id = ${recordId}
         AND project_id = ${scope.projectId}
    `;
    const availableVersions = record?.currentVersion ?? 0;
    for (let index = 0; index < contents.length; index += 1) {
      if (index + 1 > availableVersions) {
        break;
      }
      const content = contents[index];
      if (content === undefined) {
        throw new Error("leftover fixture content is missing");
      }
      await tx.sql`INSERT INTO app.change_record_version_leftovers (record_id, version_no, leftover_item_id, project_id, content_snapshot) VALUES (${recordId}, ${index + 1}, ${row.id}, ${scope.projectId}, ${content})`;
    }
    return row.id;
  });
}

async function newTaskBatch(
  scope: ProjectScope,
  count: number,
  startCode: number,
): Promise<void> {
  await client.sql.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO app.tasks (project_id, module_id, feature_id, scope_type, code, title, description, creator_id, priority, work_status, lifecycle_status)
      SELECT ${scope.projectId}, ${scope.moduleId}, NULL, 'MODULE', ${scope.code + "-T-"} || (${startCode} + n), '批量夹具任务 ' || n, '', ${scope.userId}, 'NORMAL', 'TODO', 'ACTIVE'
        FROM generate_series(1, ${count}) AS n
      RETURNING id
    `;
    await tx`
      INSERT INTO app.task_assignees (task_id, user_id, project_id)
      SELECT id, ${scope.userId}, ${scope.projectId}
        FROM unnest(${rows.map((row) => row.id)}::integer[]) AS id
    `;
    await tx`
      INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, changed_by)
      SELECT id, ${scope.projectId}, NULL, 'TODO', ${scope.userId}
        FROM unnest(${rows.map((row) => row.id)}::integer[]) AS id
    `;
  });
}

/** postgres.js 的嵌套片段（sql 模板对象）形状：strings + args。 */
function isFragment(value: unknown): value is {
  readonly strings: readonly string[];
  readonly args: readonly unknown[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { strings?: unknown }).strings) &&
    Array.isArray((value as { args?: unknown }).args)
  );
}

/** 与 postgres.js 一致：嵌套片段原地展开，普通值按出现顺序编号为 $n。 */
function renderSql(
  strings: readonly string[],
  values: readonly unknown[],
  parameters: unknown[],
): string {
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    text += isFragment(value)
      ? renderSql(value.strings, value.args, parameters)
      : "$" + parameters.push(value);
    text += strings[index + 1] ?? "";
  }
  return text;
}

/**
 * 捕获顶层查询：postgres.js 的 sql 片段（如排序键表达式）本身也是 sql 模板对象，
 * 被外层模板引用时不算一次独立查询。这里把「被别的调用当作值引用」的片段从
 * calls 里剔除，只保留顶层语句，并支持嵌套渲染。
 */
function captureTransaction(): { calls: SqlCall[]; tx: TransactionContext } {
  const calls: Array<SqlCall & { readonly hybrid: object }> = [];
  const drop = (value: unknown): void => {
    if (!isFragment(value)) {
      return;
    }
    const index = calls.findIndex((call) => call.hybrid === value);
    if (index >= 0) {
      calls.splice(index, 1);
    }
    for (const argument of (value as { readonly args: readonly unknown[] })
      .args) {
      drop(argument);
    }
  };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const parameters: unknown[] = [];
    const text = renderSql(strings, values, parameters);
    const hybrid = Object.assign(Promise.resolve([] as unknown[]), {
      strings,
      args: values,
    });
    // 片段总是先于外层调用创建，因此这里可以先剔除、再登记顶层语句。
    for (const value of values) {
      drop(value);
    }
    calls.push({ text, values: parameters, hybrid });
    return hybrid;
  };
  const tx: TransactionContext = {
    db: {} as TransactionContext["db"],
    sql: sql as unknown as TransactionContext["sql"],
  };
  return {
    get calls(): SqlCall[] {
      return calls.map(({ text, values }) => ({ text, values }));
    },
    tx,
  };
}

async function explain(call: SqlCall): Promise<string> {
  // 计划断言依赖 app.tasks / app.change_records 的统计信息：夹具库会被反复增删，
  // 统计信息滞后时规划器可能把刚插入 200 行的项目估成 2 行、改选另一条等价索引，
  // 使断言随环境漂移。app_runtime 无 MAINTAIN 权限，这里用 bootstrap 连接刷新。
  await bootstrap.unsafe("ANALYZE app.tasks, app.change_records");
  return client.sql.begin(async (tx) => {
    // 夹具库规模小，统计信息之外再关闭顺序扫描：计划仍出现索引路径，才证明该查询
    // 形状可被既有索引服务（不依赖 Seq Scan）。
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = await tx.unsafe<Array<Record<string, string>>>(
      "EXPLAIN (ANALYZE, BUFFERS) " + call.text,
      [...call.values] as never[],
    );
    return rows
      .map((row) => row["QUERY PLAN"] ?? JSON.stringify(row))
      .join(String.fromCharCode(10));
  });
}

describe("ModuleReadPort.count and FeatureReadPort.count", () => {
  test("module count covers every module of one project and never crosses projects", async () => {
    const scope = await newProject();
    const other = await newProject();
    const extraModule = await newModule(scope, "正常模块");
    expect(
      await uow.run((tx) => modules.count(tx, { projectId: scope.projectId })),
    ).toBe(2);
    // ADR-044：模块不再有归档态，count 只按 project_id 统计，且不随模块改名变化。
    await client.sql`UPDATE app.modules SET name = '重命名模块', row_version = row_version + 1 WHERE id = ${extraModule}`;
    expect(
      await uow.run((tx) => modules.count(tx, { projectId: scope.projectId })),
    ).toBe(2);
    expect(
      await uow.run((tx) => modules.count(tx, { projectId: other.projectId })),
    ).toBe(1);
    expect(await uow.run((tx) => modules.count(tx, { projectId: -1 }))).toBe(0);
  });

  // ADR-045：功能不再有归档态，count 只按 project_id + 可选 module_id 统计。
  test("feature count narrows by module without leaking projects", async () => {
    const scope = await newProject();
    const other = await newProject();
    const secondModule = await newModule(scope, "第二模块");
    await newFeature(scope, scope.moduleId, "功能甲");
    await newFeature(scope, scope.moduleId, "功能乙");
    await newFeature(scope, secondModule, "功能丙");
    expect(
      await uow.run((tx) => features.count(tx, { projectId: scope.projectId })),
    ).toBe(3);
    expect(
      await uow.run((tx) =>
        features.count(tx, {
          projectId: scope.projectId,
          moduleId: scope.moduleId,
        }),
      ),
    ).toBe(2);
    expect(
      await uow.run((tx) =>
        features.count(tx, {
          projectId: scope.projectId,
          moduleId: secondModule,
        }),
      ),
    ).toBe(1);
    expect(
      await uow.run((tx) => features.count(tx, { projectId: other.projectId })),
    ).toBe(0);
    expect(
      await uow.run((tx) =>
        features.count(tx, {
          projectId: scope.projectId,
          moduleId: other.moduleId,
        }),
      ),
    ).toBe(0);
  });
});

describe("TaskQueryPort list and count", () => {
  test("filters, ordering and count agree with the unpaged list", async () => {
    const scope = await newProject();
    const other = await newProject();
    const colleague = await createUser(client.sql);
    await addMember(scope.projectId, colleague);
    const todo = await newTask(scope, { assigneeIds: [colleague] });
    const done = await newTask(scope, { workStatus: "DONE" });
    const canceled = await newTask(scope, { workStatus: "CANCELED" });
    const foreign = await newTask(other);
    const page = await uow.run((tx) =>
      taskQuery.list(tx, { projectIds: [scope.projectId], limit: 100 }),
    );
    // ADR-037：状态分组为 未完成 → 已完成 → 已取消，组内按 id 升序。
    expect(page.items.map((item) => item.taskId)).toEqual([
      todo,
      done,
      canceled,
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.next).toBeNull();
    expect(page.items[0]).toMatchObject({
      projectId: scope.projectId,
      moduleId: scope.moduleId,
      featureId: null,
      scopeType: "MODULE",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
    });
    expect(page.items[0]?.createdAt).toBeInstanceOf(Date);
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, { projectIds: [scope.projectId] }),
      ),
    ).toBe(page.items.length);
    const byAssignee = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        assigneeId: colleague,
        limit: 100,
      }),
    );
    expect(byAssignee.items.map((item) => item.taskId)).toEqual([todo]);
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, {
          projectIds: [scope.projectId],
          assigneeId: colleague,
        }),
      ),
    ).toBe(byAssignee.items.length);
    const byStatus = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        workStatuses: ["DONE", "CANCELED"],
        limit: 100,
      }),
    );
    expect(byStatus.items.map((item) => item.taskId)).toEqual([done, canceled]);
    const crossProject = await uow.run((tx) =>
      taskQuery.list(tx, { projectIds: [other.projectId], limit: 100 }),
    );
    expect(crossProject.items.map((item) => item.taskId)).toEqual([foreign]);
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, {
          projectIds: [scope.projectId, other.projectId],
        }),
      ),
    ).toBe(4);
  });

  /**
   * R-7 组卡事实字段回归（2026-09-22）：`listByIds` 不显式选择 due_at 时
   * 聚合组列表分支的 dueAt 会是 undefined，响应契约校验直接 500；时间列在
   * 驱动层以文本返回，读取边界必须还原为 Date。
   */
  test("listByIds 还原截止时间为 Date 并透传优先级", async () => {
    const scope = await newProject();
    const dueAt = "2026-10-02 05:33:00+08";
    const withDue = await newTask(scope, { dueAt, priority: "URGENT" });
    const withoutDue = await newTask(scope);
    const rows = await uow.run((tx) =>
      taskQuery.listByIds(tx, [scope.projectId], [withDue, withoutDue]),
    );
    expect(rows.map((row) => row.taskId)).toEqual([withDue, withoutDue]);
    expect(rows[0]?.dueAt).toBeInstanceOf(Date);
    expect(rows[0]?.dueAt?.toISOString()).toBe(new Date(dueAt).toISOString());
    expect(rows[0]?.priority).toBe("URGENT");
    expect(rows[1]?.dueAt).toBeNull();
  });

  test("effectiveOnly drops invalid and canceled tasks", async () => {
    const scope = await newProject();
    const featureId = await newFeature(scope, scope.moduleId, "影响功能");
    const active = await newTask(scope);
    const canceled = await newTask(scope, { workStatus: "CANCELED" });
    const invalid = await newTask(scope, { lifecycleStatus: "INVALID" });
    const featureScoped = await newTask(scope, { featureId });
    const all = await uow.run((tx) =>
      taskQuery.list(tx, { projectIds: [scope.projectId], limit: 100 }),
    );
    expect(all.items).toHaveLength(4);
    const effective = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        effectiveOnly: true,
        limit: 100,
      }),
    );
    const effectiveIds = effective.items.map((item) => item.taskId);
    expect(effectiveIds.sort((left, right) => left - right)).toEqual(
      [active, featureScoped].sort((left, right) => left - right),
    );
    expect(effectiveIds).not.toContain(canceled);
    expect(effectiveIds).not.toContain(invalid);
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, {
          projectIds: [scope.projectId],
          effectiveOnly: true,
        }),
      ),
    ).toBe(effective.items.length);
    const byScope = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        scopeTypes: ["FEATURE"],
        limit: 100,
      }),
    );
    expect(byScope.items.map((item) => item.taskId)).toEqual([featureScoped]);
    expect(byScope.items[0]).toMatchObject({ featureId, scopeType: "FEATURE" });
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, {
          projectIds: [scope.projectId],
          scopeTypes: ["MODULE"],
        }),
      ),
    ).toBe(3);
  });

  test("task pagination walks every row exactly once", async () => {
    const scope = await newProject();
    const created = [
      await newTask(scope),
      await newTask(scope),
      await newTask(scope),
      await newTask(scope),
      await newTask(scope),
    ];
    const first = await uow.run((tx) =>
      taskQuery.list(tx, { projectIds: [scope.projectId], limit: 2 }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        limit: 2,
        after: first.next!,
      }),
    );
    expect(second.items).toHaveLength(2);
    expect(second.hasMore).toBe(true);
    const third = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        limit: 2,
        after: second.next!,
      }),
    );
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    expect(third.next).toBeNull();
    const seen = [...first.items, ...second.items, ...third.items].map(
      (item) => item.taskId,
    );
    // 同状态、同优先级、无截止的并列任务按 id 升序，即创建顺序。
    expect(seen).toEqual(created);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("excludedTaskIds filter before pagination and inside count", async () => {
    const scope = await newProject();
    const first = await newTask(scope);
    const second = await newTask(scope);
    const third = await newTask(scope);
    const fourth = await newTask(scope);
    const fifth = await newTask(scope);
    const excluded = [fifth, fourth];
    const page = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        excludedTaskIds: excluded,
        limit: 2,
      }),
    );
    expect(page.items.map((item) => item.taskId)).toEqual([first, second]);
    expect(page.hasMore).toBe(true);
    const next = await uow.run((tx) =>
      taskQuery.list(tx, {
        projectIds: [scope.projectId],
        excludedTaskIds: excluded,
        limit: 2,
        after: page.next!,
      }),
    );
    expect(next.items.map((item) => item.taskId)).toEqual([third]);
    expect(next.hasMore).toBe(false);
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, {
          projectIds: [scope.projectId],
          excludedTaskIds: excluded,
        }),
      ),
    ).toBe(3);
    expect(
      await uow.run((tx) =>
        taskQuery.count(tx, {
          projectIds: [scope.projectId],
          excludedTaskIds: [fifth],
        }),
      ),
    ).toBe(4);
  });

  test("task list validation rejects unbounded filters before SQL", async () => {
    const { calls, tx } = captureTransaction();
    await expect(
      taskQuery.list(tx, { projectIds: [1], limit: 0 }),
    ).rejects.toMatchObject({
      name: "TaskListInputError",
      reason: "invalid-limit",
    });
    await expect(
      taskQuery.list(tx, { projectIds: [1], limit: 1.5 }),
    ).rejects.toBeInstanceOf(TaskListInputError);
    await expect(
      taskQuery.list(tx, {
        projectIds: [1],
        limit: 20,
        excludedTaskIds: Array.from(
          { length: TASK_EXCLUDED_IDS_MAX + 1 },
          () => 1,
        ),
      }),
    ).rejects.toMatchObject({ reason: "invalid-excluded-task-ids" });
    await expect(
      taskQuery.list(tx, { projectIds: [1], limit: 20, excludedTaskIds: [0] }),
    ).rejects.toMatchObject({ reason: "invalid-excluded-task-ids" });
    await expect(
      taskQuery.count(tx, {
        projectIds: [1],
        excludedTaskIds: Array.from(
          { length: TASK_EXCLUDED_IDS_MAX + 1 },
          () => 1,
        ),
      }),
    ).rejects.toMatchObject({ reason: "invalid-excluded-task-ids" });
    expect(calls).toEqual([]);
    await expect(
      taskQuery.count(tx, {
        projectIds: [],
        excludedTaskIds: Array.from({ length: TASK_EXCLUDED_IDS_MAX }, () => 1),
      }),
    ).resolves.toBe(0);
    expect(calls).toEqual([]);
  });

  test("empty authorized project scope short-circuits without SQL", async () => {
    const { calls, tx } = captureTransaction();
    await expect(
      taskQuery.list(tx, { projectIds: [], limit: 20 }),
    ).resolves.toEqual({ items: [], next: null, hasMore: false });
    await expect(taskQuery.count(tx, { projectIds: [] })).resolves.toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("MyTaskQueryPort.list", () => {
  test("hasPublishedRecord filters before pagination and scopes to projects", async () => {
    const scope = await newProject();
    const olderPublished = await newTask(scope);
    await newPublishedRecord(scope, { taskId: olderPublished });
    const newerPublished = await newTask(scope);
    await newPublishedRecord(scope, { taskId: newerPublished });
    const newestWithoutRecord = await newTask(scope);
    const all = await uow.run((tx) =>
      myTasks.list(tx, { projectIds: [scope.projectId], limit: 100 }),
    );
    expect(all.items.map((item) => item.taskId)).toEqual([
      olderPublished,
      newerPublished,
      newestWithoutRecord,
    ]);
    const withoutRecord = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        hasPublishedRecord: false,
        limit: 1,
      }),
    );
    expect(withoutRecord.items.map((item) => item.taskId)).toEqual([
      newestWithoutRecord,
    ]);
    expect(withoutRecord.hasMore).toBe(false);
    const withRecord = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        hasPublishedRecord: true,
        limit: 1,
      }),
    );
    expect(withRecord.items.map((item) => item.taskId)).toEqual([
      olderPublished,
    ]);
    expect(withRecord.hasMore).toBe(true);
    const nextPage = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        hasPublishedRecord: true,
        limit: 1,
        after: withRecord.next!,
      }),
    );
    expect(nextPage.items.map((item) => item.taskId)).toEqual([newerPublished]);
    expect(nextPage.hasMore).toBe(false);
    const other = await newProject();
    const foreign = await newTask(other);
    const scoped = await uow.run((tx) =>
      myTasks.list(tx, { projectIds: [other.projectId], limit: 100 }),
    );
    expect(scoped.items.map((item) => item.taskId)).toEqual([foreign]);
    const excluded = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        excludedTaskIds: [newestWithoutRecord],
        limit: 100,
      }),
    );
    expect(excluded.items.map((item) => item.taskId)).toEqual([
      olderPublished,
      newerPublished,
    ]);
    const byAssignee = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        assigneeId: scope.userId,
        limit: 100,
      }),
    );
    expect(byAssignee.items).toHaveLength(3);
  });

  test("creatorId 归属过滤与 assigneeId 正交且先过滤后分页（F-32「我创建的」）", async () => {
    const scope = await newProject();
    const teammateUserId = await createUser(client.sql);
    await addMember(scope.projectId, teammateUserId);

    const createdAndAssigned = await newTask(scope);
    const createdForTeammate = await newTask(scope, {
      assigneeIds: [teammateUserId],
    });
    const teammateCreatedForMe = await newTask(scope, {
      actorUserId: teammateUserId,
      assigneeIds: [scope.userId],
    });

    const byAssignee = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        assigneeId: scope.userId,
        limit: 100,
      }),
    );
    expect(byAssignee.items.map((item) => item.taskId)).toEqual([
      createdAndAssigned,
      teammateCreatedForMe,
    ]);

    const byCreator = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        creatorId: scope.userId,
        limit: 100,
      }),
    );
    expect(byCreator.items.map((item) => item.taskId)).toEqual([
      createdAndAssigned,
      createdForTeammate,
    ]);
    expect(
      byCreator.items.every((item) => item.creatorId === scope.userId),
    ).toBe(true);

    const firstPage = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        creatorId: scope.userId,
        limit: 1,
      }),
    );
    expect(firstPage.items.map((item) => item.taskId)).toEqual([
      createdAndAssigned,
    ]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [scope.projectId],
        creatorId: scope.userId,
        limit: 1,
        after: firstPage.next!,
      }),
    );
    expect(secondPage.items.map((item) => item.taskId)).toEqual([
      createdForTeammate,
    ]);
    expect(secondPage.hasMore).toBe(false);

    const foreign = await newProject();
    await newTask(foreign);
    const scoped = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [foreign.projectId, scope.projectId],
        creatorId: foreign.userId,
        limit: 100,
      }),
    );
    expect(scoped.items.map((item) => item.taskId)).toHaveLength(1);
    expect(scoped.items[0]?.projectId).toBe(foreign.projectId);
  });

  test("my task list short-circuits and validates like the task port", async () => {
    const { calls, tx } = captureTransaction();
    await expect(
      myTasks.list(tx, { projectIds: [], limit: 20 }),
    ).resolves.toEqual({ items: [], next: null, hasMore: false });
    await expect(
      myTasks.list(tx, { projectIds: [1], limit: 0 }),
    ).rejects.toBeInstanceOf(TaskListInputError);
    await expect(
      myTasks.list(tx, {
        projectIds: [1],
        limit: 20,
        excludedTaskIds: Array.from(
          { length: TASK_EXCLUDED_IDS_MAX + 1 },
          () => 1,
        ),
      }),
    ).rejects.toMatchObject({ reason: "invalid-excluded-task-ids" });
    expect(calls).toEqual([]);
  });
});

describe("ChangeRecordReadPort", () => {
  test("published counts and recent list hide drafts and voids", async () => {
    const scope = await newProject();
    const other = await newProject();
    const featureId = await newFeature(scope, scope.moduleId, "支付功能");
    const featureRecord = await newPublishedRecord(scope, { featureId });
    const moduleRecord = await newPublishedRecord(scope, {});
    await newDraftRecord(scope);
    const voided = await newPublishedRecord(scope, { status: "VOID" });
    await newPublishedRecord(other, {});
    expect(
      await uow.run((tx) =>
        records.countPublished(tx, { projectId: scope.projectId }),
      ),
    ).toBe(2);
    expect(
      await uow.run((tx) =>
        records.countPublished(tx, { projectId: scope.projectId, featureId }),
      ),
    ).toBe(1);
    expect(
      await uow.run((tx) =>
        records.countPublished(tx, {
          projectId: scope.projectId,
          scopeType: "MODULE",
        }),
      ),
    ).toBe(1);
    expect(
      await uow.run((tx) =>
        records.countPublished(tx, {
          projectId: scope.projectId,
          moduleId: other.moduleId,
        }),
      ),
    ).toBe(0);
    expect(
      await uow.run((tx) =>
        records.countPublished(tx, { projectId: other.projectId }),
      ),
    ).toBe(1);
    const recent = await uow.run((tx) =>
      records.listRecentPublished(tx, {
        projectId: scope.projectId,
        limit: 10,
      }),
    );
    expect(recent.map((item) => item.recordId)).toEqual([
      moduleRecord,
      featureRecord,
    ]);
    expect(recent.map((item) => item.recordId)).not.toContain(voided);
    expect(recent[0]).toMatchObject({
      projectId: scope.projectId,
      featureId: null,
      featureName: null,
      currentVersion: 1,
    });
    expect(recent[0]?.publishedAt).toBeInstanceOf(Date);
    expect(recent[1]).toMatchObject({ featureId, featureName: "支付功能" });
    expect(recent[1]?.code).toContain("-CR-");
    expect(recent.length).toBe(
      await uow.run((tx) =>
        records.countPublished(tx, { projectId: scope.projectId }),
      ),
    );
    const limited = await uow.run((tx) =>
      records.listRecentPublished(tx, { projectId: scope.projectId, limit: 1 }),
    );
    expect(limited.map((item) => item.recordId)).toEqual([moduleRecord]);
    await expect(
      uow.run((tx) =>
        records.listRecentPublished(tx, {
          projectId: scope.projectId,
          limit: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(ChangeRecordReadInputError);
    await expect(
      uow.run((tx) =>
        records.listRecentPublished(tx, {
          projectId: scope.projectId,
          limit: 101,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-limit" });
  });

  test("active leftovers use the newest snapshot of published records only", async () => {
    const scope = await newProject();
    const featureId = await newFeature(scope, scope.moduleId, "遗留功能");
    const record = await newPublishedRecord(scope, { featureId });
    await newRecordVersion(scope, record, 2);
    const activeLeftover = await newLeftover(scope, record, {
      contents: ["第一版遗留内容", "第二版遗留内容"],
    });
    const resolvedLeftover = await newLeftover(scope, record, {
      status: "RESOLVED",
      contents: ["已解决内容"],
    });
    const draftRecord = await newDraftRecord(scope);
    const draftLeftover = await newLeftover(scope, draftRecord, {
      contents: ["草稿记录内容"],
    });
    const voidRecord = await newPublishedRecord(scope, { status: "VOID" });
    const voidLeftover = await newLeftover(scope, voidRecord, {
      contents: ["作废记录内容"],
    });
    const other = await newProject();
    const otherRecord = await newPublishedRecord(other, {});
    const otherLeftover = await newLeftover(other, otherRecord, {
      contents: ["其他项目内容"],
    });
    const leftovers = await uow.run((tx) =>
      records.listActiveLeftovers(tx, {
        projectId: scope.projectId,
        limit: 10,
      }),
    );
    const ids = leftovers
      .map((item) => item.leftoverItemId)
      .sort((left, right) => left - right);
    expect(ids).toEqual([activeLeftover]);
    expect(ids).not.toContain(voidLeftover);
    expect(ids).not.toContain(resolvedLeftover);
    expect(ids).not.toContain(draftLeftover);
    expect(ids).not.toContain(otherLeftover);
    const active = leftovers.find(
      (item) => item.leftoverItemId === activeLeftover,
    );
    expect(active).toMatchObject({
      recordId: record,
      projectId: scope.projectId,
      content: "第二版遗留内容",
    });
    expect(active?.recordCode).toContain("-CR-");
    const featureScoped = await uow.run((tx) =>
      records.listActiveLeftovers(tx, {
        projectId: scope.projectId,
        featureId,
        limit: 10,
      }),
    );
    expect(featureScoped.map((item) => item.leftoverItemId)).toEqual([
      activeLeftover,
    ]);
    const moduleScoped = await uow.run((tx) =>
      records.listActiveLeftovers(tx, {
        projectId: scope.projectId,
        scopeType: "MODULE",
        limit: 10,
      }),
    );
    expect(moduleScoped).toEqual([]);
    const capped = await uow.run((tx) =>
      records.listActiveLeftovers(tx, {
        projectId: scope.projectId,
        limit: 1,
      }),
    );
    expect(capped).toHaveLength(1);
  });

  test("published record counts map tasks to PUBLISHED counts and scope by project", async () => {
    const scope = await newProject();
    const other = await newProject();
    const published = await newTask(scope);
    await newPublishedRecord(scope, { taskId: published });
    const second = await newPublishedRecord(scope, { taskId: published });
    await newRecordVersion(scope, second, 2);
    const voided = await newTask(scope);
    await newPublishedRecord(scope, { taskId: voided, status: "VOID" });
    const draftOnly = await newTask(scope);
    await newDraftRecord(scope, { taskId: draftOnly });
    const noRecord = await newTask(scope);
    const foreign = await newTask(other);
    await newPublishedRecord(other, { taskId: foreign });
    const candidates = [published, voided, draftOnly, noRecord, foreign];
    const bothProjects = await uow.run((tx) =>
      records.countPublishedByTask(
        tx,
        [scope.projectId, other.projectId],
        candidates,
      ),
    );
    expect(bothProjects).toEqual(
      [
        { taskId: published, count: 2 },
        { taskId: foreign, count: 1 },
      ].sort((left, right) => left.taskId - right.taskId),
    );
    expect(
      await uow.run((tx) =>
        records.countPublishedByTask(tx, [scope.projectId], candidates),
      ),
    ).toEqual([{ taskId: published, count: 2 }]);
    expect(
      await uow.run((tx) =>
        records.countPublishedByTask(
          tx,
          [scope.projectId],
          [voided, draftOnly, noRecord],
        ),
      ),
    ).toEqual([]);
  });

  test("leftover source marks only tasks that have leftover_task_links rows", async () => {
    const scope = await newProject();
    const other = await newProject();
    const converted = await newTask(scope);
    const record = await newPublishedRecord(scope, { taskId: converted });
    const leftover = await newLeftover(scope, record, {
      status: "CONVERTED",
      contents: ["已转换遗留内容"],
    });
    await uow.run(
      (tx) =>
        tx.sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by) VALUES (${leftover}, ${converted}, ${scope.projectId}, ${scope.userId})`,
    );
    const plain = await newTask(scope);
    const foreign = await newTask(other);
    const foreignRecord = await newPublishedRecord(other, { taskId: foreign });
    const foreignLeftover = await newLeftover(other, foreignRecord, {
      status: "CONVERTED",
      contents: ["其他项目遗留内容"],
    });
    await uow.run(
      (tx) =>
        tx.sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by) VALUES (${foreignLeftover}, ${foreign}, ${other.projectId}, ${other.userId})`,
    );
    const candidates = [converted, plain, foreign];
    expect(
      await uow.run((tx) =>
        records.listLeftoverSourceTaskIds(
          tx,
          [scope.projectId, other.projectId],
          candidates,
        ),
      ),
    ).toEqual([converted, foreign].sort((left, right) => left - right));
    // projectIds 收窄后其他项目的链接行不返回（不泄露存在性）。
    expect(
      await uow.run((tx) =>
        records.listLeftoverSourceTaskIds(tx, [scope.projectId], candidates),
      ),
    ).toEqual([converted]);
    expect(
      await uow.run((tx) =>
        records.listLeftoverSourceTaskIds(tx, [scope.projectId], [plain]),
      ),
    ).toEqual([]);
  });

  test("record read validation rejects unbounded task sets before SQL", async () => {
    const { calls, tx } = captureTransaction();
    await expect(
      records.countPublishedByTask(
        tx,
        [1],
        Array.from({ length: CHANGE_RECORD_TASK_IDS_MAX + 1 }, () => 1),
      ),
    ).rejects.toMatchObject({
      name: "ChangeRecordReadInputError",
      reason: "invalid-task-ids",
    });
    await expect(
      records.listLeftoverSourceTaskIds(
        tx,
        [1],
        Array.from({ length: CHANGE_RECORD_TASK_IDS_MAX + 1 }, () => 1),
      ),
    ).rejects.toMatchObject({
      name: "ChangeRecordReadInputError",
      reason: "invalid-task-ids",
    });
    await expect(
      records.countPublishedByTask(tx, [1], [0]),
    ).rejects.toMatchObject({ reason: "invalid-task-ids" });
    await expect(
      records.listRecentPublished(tx, { projectId: 1, limit: -1 }),
    ).rejects.toBeInstanceOf(ChangeRecordReadInputError);
    await expect(
      records.listActiveLeftovers(tx, { projectId: 1, limit: 101 }),
    ).rejects.toBeInstanceOf(ChangeRecordReadInputError);
    expect(calls).toEqual([]);
    await expect(records.countPublishedByTask(tx, [], [1])).resolves.toEqual(
      [],
    );
    await expect(records.countPublishedByTask(tx, [1], [])).resolves.toEqual(
      [],
    );
    await expect(
      records.listLeftoverSourceTaskIds(tx, [], [1]),
    ).resolves.toEqual([]);
    await expect(
      records.listLeftoverSourceTaskIds(tx, [1], []),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("读端口查询计划（A 裁决 §6 冲突 B 的 EXPLAIN 上限依据）", () => {
  test("端口过滤列由既有 btree 索引覆盖，不需要新增迁移", async () => {
    const rows = await client.sql.unsafe<
      { indexname: string; indexdef: string }[]
    >(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'app' AND ((tablename = 'tasks' AND indexname IN ('tasks_project_status_idx', 'tasks_creator_status_idx')) OR (tablename = 'task_assignees' AND indexname = 'task_assignees_user_idx')) ORDER BY indexname",
    );
    const projectIndex = rows.find(
      (row) => row.indexname === "tasks_project_status_idx",
    );
    const assigneeIndex = rows.find(
      (row) => row.indexname === "task_assignees_user_idx",
    );
    const creatorIndex = rows.find(
      (row) => row.indexname === "tasks_creator_status_idx",
    );
    expect(projectIndex?.indexdef).toContain(
      "(project_id, lifecycle_status, work_status, id)",
    );
    expect(assigneeIndex?.indexdef).toContain("(user_id, task_id)");
    expect(creatorIndex?.indexdef).toContain("(creator_id, work_status, id)");
  });

  test("四种端口形状都命中预期索引且不回退为 Seq Scan", async () => {
    const scope = await newProject();
    const bulk = await newProject();
    await newTaskBatch(bulk, 200, 400);
    const mine = await newTask(scope, { assigneeIds: [scope.userId] });
    const listCall = captureTransaction();
    await taskQuery.list(listCall.tx, {
      projectIds: [scope.projectId],
      limit: 21,
    });
    const countCall = captureTransaction();
    await taskQuery.count(countCall.tx, {
      projectIds: [scope.projectId, bulk.projectId],
      effectiveOnly: true,
    });
    const assigneeCall = captureTransaction();
    await taskQuery.list(assigneeCall.tx, {
      projectIds: [scope.projectId, bulk.projectId],
      assigneeId: scope.userId,
      limit: 21,
    });
    const excludedIds: number[] = [];
    for (let offset = 0; offset < TASK_EXCLUDED_IDS_MAX; offset += 1) {
      excludedIds.push(mine + offset);
    }
    expect(excludedIds).toHaveLength(TASK_EXCLUDED_IDS_MAX);
    const excludedCall = captureTransaction();
    await taskQuery.list(excludedCall.tx, {
      projectIds: [scope.projectId, bulk.projectId],
      excludedTaskIds: excludedIds,
      limit: 21,
    });

    const listPlan = await explain(listCall.calls[0]!);
    const countPlan = await explain(countCall.calls[0]!);
    const assigneePlan = await explain(assigneeCall.calls[0]!);
    const excludedPlan = await explain(excludedCall.calls[0]!);

    expect(listPlan).toContain("tasks_project_status_idx");
    // 负责人已迁到 app.task_assignees（ADR-040）：EXISTS 子查询应命中关联表索引，tasks 上不再有负责人索引
    expect(assigneePlan).toMatch(/task_assignees_user_idx|task_assignees_pkey/);
    for (const plan of [listPlan, countPlan, assigneePlan, excludedPlan]) {
      expect(plan).toMatch(/Index Only Scan|Index Scan|Bitmap Heap Scan/);
      expect(plan).not.toMatch(/Seq Scan on tasks/);
    }
    expect(excludedPlan).toContain("<> ALL");
  });

  test("creator 归属过滤命中 tasks_creator_status_idx 且不回退为 Seq Scan", async () => {
    const bulk = await newProject();
    const teammateUserId = await createUser(client.sql);
    await addMember(bulk.projectId, teammateUserId);
    await newTaskBatch(bulk, 200, 600);
    const createdByTeammate = await newTask(bulk, {
      actorUserId: teammateUserId,
    });

    const creatorCall = captureTransaction();
    await myTasks.list(creatorCall.tx, {
      projectIds: [bulk.projectId],
      creatorId: teammateUserId,
      limit: 21,
    });
    const creatorPlan = await explain(creatorCall.calls[0]!);
    expect(creatorPlan).toContain("tasks_creator_status_idx");
    expect(creatorPlan).toMatch(/Index Only Scan|Index Scan|Bitmap Heap Scan/);
    expect(creatorPlan).not.toMatch(/Seq Scan on tasks/);

    const rows = await uow.run((tx) =>
      myTasks.list(tx, {
        projectIds: [bulk.projectId],
        creatorId: teammateUserId,
        limit: 21,
      }),
    );
    expect(rows.items.map((item) => item.taskId)).toEqual([createdByTeammate]);
  });

  test("记录维度计数与先过滤后分页命中 change_records 索引且不回落 Seq Scan", async () => {
    const indexes = await client.sql.unsafe<
      { indexname: string; indexdef: string }[]
    >(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename = 'change_records' AND indexname IN ('change_records_project_task_idx', 'change_records_project_status_idx') ORDER BY indexname",
    );
    expect(
      indexes.find((row) => row.indexname === "change_records_project_task_idx")
        ?.indexdef,
    ).toContain("(project_id, task_id, id)");
    expect(
      indexes.find(
        (row) => row.indexname === "change_records_project_status_idx",
      )?.indexdef,
    ).toContain("(project_id, status, id)");
    const scope = await newProject();
    const filtered = await newTask(scope);
    await newPublishedRecord(scope, { taskId: filtered });
    const listCall = captureTransaction();
    await myTasks.list(listCall.tx, {
      projectIds: [scope.projectId],
      hasPublishedRecord: true,
      limit: 21,
    });
    const countCall = captureTransaction();
    await records.countPublishedByTask(
      countCall.tx,
      [scope.projectId],
      [filtered],
    );
    const listPlan = await explain(listCall.calls[0]!);
    const countPlan = await explain(countCall.calls[0]!);
    expect(listPlan).toContain("Limit");
    expect(listPlan).not.toMatch(/Seq Scan on tasks/);
    for (const plan of [listPlan, countPlan]) {
      // 裁决修订 D-1 / §11.6：EXPLAIN (ANALYZE, BUFFERS) 实测输出（actual time），
      // 证明计数只对本页 taskIds 补齐、未改变分页 SQL 的先过滤后分页性质。
      expect(plan).toContain("actual time");
      expect(plan).not.toMatch(/Seq Scan on change_records/);
      // B-3b 迁移 0008 新增 change_records_status_published_idx 后，规划器可在等价
      // 索引间改选，也会随统计信息把子计划从 `Index Scan using <idx>` 换成
      // `Bitmap Index Scan on <idx>`（Windows 本机与 Linux CI 实测各走一种）；
      // 这里只要求命中 change_records 索引且不回落 Seq Scan，不绑定具体索引名
      // 与访问方式。
      expect(plan).toMatch(
        /(?:Index (?:Only )?Scan using|Bitmap Index Scan on) change_records_/,
      );
    }
  });
});

describe("任务列表统一排序（ADR-037）", () => {
  /** 按 Asia/Shanghai 日历日取两个边界：已逾期（今天 00:00 之前）与今/明日截止（今天 00:00 之后）。 */
  async function dayBounds(): Promise<{
    readonly overdue: string;
    readonly today: string;
  }> {
    const [row] = await client.sql<{ overdue: string; today: string }[]>`
      SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' - interval '90 minutes')::text AS overdue,
             (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' + interval '12 hours')::text AS today
    `;
    if (!row) throw new Error("day bounds query returned no row");
    return row;
  }

  /**
   * 每个状态分组造齐 4 个紧急桶 + 2 条完全并列的行（2026-09-22 起逾期退到标记紧急之后一档）：
   * 标记紧急 → 已逾期 → 今/明日截止 → 其余。遗留问题来源不在紧急桶里，它是优先级之后的
   * 独立一级（2026-09-24 产品定案「遗留问题只会在同优先级里面高一点」）。
   * leftover_task_links 的 leftover_item_id 是主键且 task_id 唯一，因此每条遗留问题来源任务各配一个遗留项。
   */
  async function seedOrderingMatrix(
    scope: ProjectScope,
    bounds: { readonly overdue: string; readonly today: string },
  ) {
    const recordId = await newPublishedRecord(scope);
    const build = async (workStatus: "TODO" | "DONE" | "CANCELED") => {
      const overdue = await newTask(scope, {
        dueAt: bounds.overdue,
        title: "已逾期",
        workStatus,
      });
      const leftover = await newTask(scope, {
        title: "遗留问题来源",
        workStatus,
      });
      const urgent = await newTask(scope, {
        priority: "URGENT",
        title: "标记紧急",
        workStatus,
      });
      const dueSoon = await newTask(scope, {
        dueAt: bounds.today,
        title: "今日截止",
        workStatus,
      });
      const other = await newTask(scope, { title: "其余", workStatus });
      const tieA = await newTask(scope, { title: "并列甲", workStatus });
      const tieB = await newTask(scope, { title: "并列乙", workStatus });
      const leftoverId = await newLeftover(scope, recordId, {
        contents: ["排序夹具遗留问题"],
      });
      await client.sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by)
        VALUES (${leftoverId}, ${leftover}, ${scope.projectId}, ${scope.userId})`;
      return { dueSoon, leftover, other, overdue, tieA, tieB, urgent };
    };
    return {
      canceled: await build("CANCELED"),
      done: await build("DONE"),
      recordId,
      todo: await build("TODO"),
    };
  }

  test("状态分组 / 完成时间 / 紧急桶的组合按口径排序，且两个任务端口同序", async () => {
    const scope = await newProject();
    const bounds = await dayBounds();
    const matrix = await seedOrderingMatrix(scope, bounds);
    const { canceled, done, todo } = matrix;
    /**
     * 同优先级 / 跨优先级的对照夹具（ADR-037 §6；2026-09-24 定案「遗留问题只会在同优先级里面高一点」）：
     * 高优先级无遗留问题与普通优先级无遗留问题都在最后创建，ID 比遗留问题来源任务大。
     * 若有人把遗留问题来源重新并回紧急桶（v6 口径），普通优先级的 leftover 会压到高优先级的
     * highPlain 之前，下面的期望顺序立即失败——这就是这条口径的回归网。
     */
    const highPlain = await newTask(scope, {
      priority: "HIGH",
      title: "高优先级无遗留",
    });
    const normalPlain = await newTask(scope, { title: "同优先级无遗留" });

    const mine = await uow.run((tx) =>
      myTasks.list(tx, { projectIds: [scope.projectId], limit: 100 }),
    );
    const ids = mine.items.map((item) => item.taskId);
    expect(ids).toEqual([
      // 未完成：紧急桶 0 → 1 → 2 → 3（标记紧急 → 已逾期 → 今/明日截止 → 其余），
      // 同桶内先比较优先级，再比较「遗留问题来源」这一独立一级，最后才看截止与 ID：
      // 高优先级无遗留的 highPlain 因此排在普通优先级 + 遗留问题来源的 leftover 之前
      // （优先级更高的任务不会被遗留问题来源越过），而 leftover 又排在同为普通优先级、
      // 无遗留问题的 other / tieA / tieB / normalPlain 之前（同优先级内提前）。
      todo.urgent,
      todo.overdue,
      todo.dueSoon,
      highPlain,
      todo.leftover,
      todo.other,
      todo.tieA,
      todo.tieB,
      normalPlain,
      // 已完成按完成时间倒序（2026-09-22 产品口径「这个排序按照完成时间，越晚越排前面」）：
      // 优先级 / 截止 / 紧急桶都退出这一组。夹具按 已逾期 → 遗留问题来源 → 标记紧急 →
      // 今日截止 → 其余 → 并列甲 → 并列乙 的顺序创建，每条各起一个事务、completed_at 随
      // 创建顺序严格递增（下面的 doneStamps 断言先固化这个前提），因此期望顺序是创建顺序的
      // 完全倒序——URGENT 的「标记紧急」反而靠后，证明已完成组不再按优先级排。
      done.tieB,
      done.tieA,
      done.other,
      done.dueSoon,
      done.urgent,
      done.leftover,
      done.overdue,
      // 已取消不参与紧急桶、完成时间与遗留问题来源（后两者对非未完成恒等）：
      // URGENT 优先，其后按截止时间升序、无截止最后。
      canceled.urgent,
      canceled.overdue,
      canceled.dueSoon,
      canceled.leftover,
      canceled.other,
      canceled.tieA,
      canceled.tieB,
    ]);
    /**
     * 前置断言：已完成夹具的 completed_at 必须随创建顺序严格递增，上面的倒序期望才成立
     * （每条夹具各起一个事务，事务 now() 就是完成时间）。
     */
    const createdOrder = [
      done.overdue,
      done.leftover,
      done.urgent,
      done.dueSoon,
      done.other,
      done.tieA,
      done.tieB,
    ];
    const stampRows = await uow.run(
      (tx) =>
        tx.sql<{ taskId: number; completedAt: Date | string }[]>`
        SELECT id AS "taskId", completed_at AS "completedAt"
          FROM app.tasks
         WHERE id = ANY(${createdOrder}::integer[])
      `,
    );
    const stamps = createdOrder.map((taskId) => {
      const row = stampRows.find((candidate) => candidate.taskId === taskId);
      if (row === undefined)
        throw new Error(`missing stamp for task ${taskId}`);
      return new Date(row.completedAt).getTime();
    });
    expect(stamps).toEqual([...stamps].sort((left, right) => left - right));
    expect(new Set(stamps).size).toBe(stamps.length);

    // 遗留问题来源标记确实来自链接，而不是标题或优先级。
    const linked = await client.sql<{ taskId: number }[]>`
      SELECT task_id AS "taskId" FROM app.leftover_task_links WHERE project_id = ${scope.projectId}
    `;
    expect(linked.map((row) => row.taskId).sort((a, b) => a - b)).toEqual(
      [todo.leftover, done.leftover, canceled.leftover].sort((a, b) => a - b),
    );

    // 任务列表端口（TaskQueryPort.list）必须共用同一排序键。
    const listed = await uow.run((tx) =>
      taskQuery.list(tx, { projectIds: [scope.projectId], limit: 100 }),
    );
    expect(listed.items.map((item) => item.taskId)).toEqual(ids);
  });

  test("多列 keyset 分页跨页不漏不重（含无截止与完全并列的行）", async () => {
    const scope = await newProject();
    const bounds = await dayBounds();
    // 造数据的顺序即期望的返回顺序：紧急桶现在是
    // 标记紧急(0) → 已逾期(1) → 今/明日截止(2) → 其余(3)，
    // 因此「标记紧急」要排在「已逾期」之前（2026-09-22 逾期退到标记紧急之后一档），
    // 「今/明日截止」落在它们之后；未完成里的遗留问题来源是优先级之后的独立一级
    // （2026-09-24 定案），这里放在「其余」之前、与其余任务同优先级，用于覆盖新增一级的
    // keyset 比较；最后再补一条高优先级无遗留任务，防止遗留问题来源越级提前。
    const created = [
      await newTask(scope, { priority: "URGENT" }),
      await newTask(scope, { dueAt: bounds.overdue }),
      await newTask(scope, { dueAt: bounds.today }),
      await newTask(scope, { priority: "HIGH" }),
    ];
    // 遗留问题来源：与后面 5 条同为普通优先级、无截止，靠独立一级排到它们之前。
    const keysetRecordId = await newPublishedRecord(scope);
    const keysetLeftoverId = await newLeftover(scope, keysetRecordId, {
      contents: ["分页夹具遗留问题"],
    });
    const leftover = await newTask(scope, { title: "遗留问题来源" });
    await client.sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by)
      VALUES (${keysetLeftoverId}, ${leftover}, ${scope.projectId}, ${scope.userId})`;
    created.push(leftover);
    for (let index = 0; index < 5; index += 1) {
      created.push(await newTask(scope));
    }
    const unpaged = await uow.run((tx) =>
      myTasks.list(tx, { projectIds: [scope.projectId], limit: 100 }),
    );
    expect(unpaged.items.map((item) => item.taskId)).toEqual(created);

    const seen: number[] = [];
    let after: TaskListSortKey | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await uow.run((tx) =>
        myTasks.list(tx, {
          projectIds: [scope.projectId],
          limit: 2,
          ...(after === null ? {} : { after }),
        }),
      );
      seen.push(...result.items.map((item) => item.taskId));
      if (result.next === null) {
        break;
      }
      after = result.next;
    }
    expect(seen).toEqual(created);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
