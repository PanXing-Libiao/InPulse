import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Sql, TransactionSql } from "postgres";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import type { TransactionContext } from "../src/database/transaction-context.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import {
  PostgresTaskQueryPort,
  TASK_BOARD_TASKS_MAX,
} from "../src/modules/tasks/index.js";
import {
  connect,
  createProject,
  createUser,
  testUrls,
} from "./database.helpers.js";
import type { TestUrls } from "./database.helpers.js";

// R-8 项目任务看板只读端口验收（真实 PostgreSQL）：
// 1. dueState 与统计日界 / 周界由 SQL 按 Asia/Shanghai 与 now() 计算；
//    DONE / CANCELED / 未设截止时间一律 NONE（前端不得按客户端时钟重算）。
// 2. 列表顺序：逾期未完成 -> 其他未完成（先按优先级 紧急 -> 高 -> 普通 -> 低，
//    再按截止升序，NULL 最后）-> 已完成（完成时间倒序）-> 已取消；已完成与
//    已取消不参与优先级排序。
// 3. INVALID 不进看板（ADR-054：任务归档已下线，ARCHIVED 不可达）；
//    CANCELED 保留在列表与统计中（功能设计 29.1 / 29.2 口径）。
// 4. excludedTaskIds 在 LIMIT 之前过滤；超过 TASK_BOARD_TASKS_MAX 截断并置
//    truncated。
// 5. 统计与列表同一集合口径：项目级总计等于各模块分组之和，空项目为零值。
// 6. 跨项目隔离；两条看板查询都不回退 Seq Scan on tasks。
// 时间相关用例把夹具与读取放进同一事务：now() 在事务内固定，今日 / 明日边界
// 不随用例执行时刻漂移；事务结束回滚，不向库中留下看板夹具。

let client: DatabaseClient;
let bootstrap: Sql;
let uow: PostgresUnitOfWork;
const taskQuery = new PostgresTaskQueryPort();
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

type RawExecutor = Sql | TransactionSql;

const TODAY_WINDOW_END =
  "(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 day') AT TIME ZONE 'Asia/Shanghai'";

const WEEK_START =
  "date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'";

type DueSpec =
  "none" | "overdue" | "yesterdayEnd" | "today" | "tomorrowStart" | "future";

const DUE_EXPRESSION: Record<DueSpec, string> = {
  none: "NULL",
  overdue: "now() - interval '2 days'",
  yesterdayEnd:
    "(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '1 day') AT TIME ZONE 'Asia/Shanghai' + interval '23 hours 59 minutes 59 seconds'",
  // 严格落在 (now(), 明日 00:00 Asia/Shanghai) 内：当日剩余不足 1 小时时
  // 取剩余时间的一半，用例在任意时刻执行都命中 TODAY。
  today:
    "now() + LEAST((" + TODAY_WINDOW_END + ") - now(), interval '1 hour') / 2",
  tomorrowStart: TODAY_WINDOW_END,
  future: "now() + interval '10 days'",
};

interface BoardTaskOptions {
  readonly due?: DueSpec;
  readonly workStatus?: "TODO" | "DONE" | "CANCELED";
  readonly lifecycleStatus?: "ACTIVE" | "INVALID";
  readonly priority?: "NORMAL" | "HIGH" | "URGENT";
  readonly moduleId?: number;
  readonly title?: string;
  /** completed_at 的 SQL 表达式；缺省落在本周内且不晚于 now()。 */
  readonly completedAt?: string;
}

async function runRaw(
  executor: RawExecutor,
  statement: string,
  parameters: readonly unknown[],
): Promise<Array<Record<string, unknown>>> {
  const result = await (executor as Sql).unsafe(statement, [
    ...parameters,
  ] as never[]);
  return result as unknown as Array<Record<string, unknown>>;
}

function transactionContext(tx: TransactionSql): TransactionContext {
  return { db: {} as TransactionContext["db"], sql: tx };
}

async function newProject(): Promise<ProjectScope> {
  const userId = await createUser(client.sql);
  const project = await createProject(client.sql, userId);
  return { ...project, userId };
}

async function newModule(scope: ProjectScope, name: string): Promise<number> {
  const rows = await runRaw(
    client.sql,
    "INSERT INTO app.modules (project_id, name, created_by) VALUES ($1, $2, $3) RETURNING id",
    [scope.projectId, name, scope.userId],
  );
  const moduleId = rows[0]?.["id"];
  if (typeof moduleId !== "number") {
    throw new Error("module fixture insert returned no row");
  }
  return moduleId;
}

/** 与任务同一事务写入状态历史，满足 tasks_status_history_complete 延迟约束。 */
async function insertBoardTask(
  executor: RawExecutor,
  scope: ProjectScope,
  options: BoardTaskOptions = {},
): Promise<number> {
  sequence += 1;
  const workStatus = options.workStatus ?? "TODO";
  const completedAt =
    workStatus === "DONE"
      ? (options.completedAt ??
        "GREATEST(now() - interval '5 minutes', " + WEEK_START + ")")
      : "NULL";
  const statement =
    "INSERT INTO app.tasks (project_id, module_id, code, title, description, creator_id, priority, work_status, lifecycle_status, completed_at, due_at)" +
    " VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, " +
    completedAt +
    ", " +
    DUE_EXPRESSION[options.due ?? "none"] +
    ") RETURNING id";
  const inserted = await runRaw(executor, statement, [
    scope.projectId,
    options.moduleId ?? scope.moduleId,
    scope.code + "-T-" + String(sequence),
    options.title ?? "看板端口夹具任务",
    scope.userId,
    options.priority ?? "NORMAL",
    workStatus,
    options.lifecycleStatus ?? "ACTIVE",
  ]);
  const taskId = inserted[0]?.["id"];
  if (typeof taskId !== "number") {
    throw new Error("task fixture insert returned no row");
  }
  await runRaw(
    executor,
    "INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES ($1, $2, $3)",
    [taskId, scope.userId, scope.projectId],
  );
  await runRaw(
    executor,
    "INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, changed_by)" +
      " SELECT id, project_id, NULL, work_status, completed_at, $2 FROM app.tasks WHERE id = $1 AND project_id = $3",
    [taskId, scope.userId, scope.projectId],
  );
  return taskId;
}

/** 批量夹具：单事务内插入任务与状态历史，避免逐条提交拖慢用例。 */
async function insertBoardTaskBatch(
  executor: RawExecutor,
  scope: ProjectScope,
  count: number,
): Promise<{
  readonly count: number;
  readonly maxId: number;
  readonly minId: number;
}> {
  const statement =
    "WITH inserted AS (" +
    "INSERT INTO app.tasks (project_id, module_id, code, title, description, creator_id, priority, work_status, lifecycle_status)" +
    " SELECT $1, $2, $3 || n, '批量夹具任务 ' || n, '', $4, 'NORMAL', 'TODO', 'ACTIVE'" +
    " FROM generate_series(1, $5) AS n RETURNING id, project_id, work_status), " +
    "assignees AS (" +
    "INSERT INTO app.task_assignees (task_id, user_id, project_id)" +
    " SELECT id, $4, project_id FROM inserted), " +
    "history AS (" +
    "INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, changed_by)" +
    " SELECT id, project_id, NULL, work_status, NULL, $4 FROM inserted) " +
    "SELECT count(*)::integer AS total, min(id)::integer AS min_id, max(id)::integer AS max_id FROM inserted";
  const rows = await runRaw(executor, statement, [
    scope.projectId,
    scope.moduleId,
    scope.code + "-T-",
    scope.userId,
    count,
  ]);
  const row = rows[0];
  const total = row?.["total"];
  const minId = row?.["min_id"];
  const maxId = row?.["max_id"];
  if (
    typeof total !== "number" ||
    typeof minId !== "number" ||
    typeof maxId !== "number"
  ) {
    throw new Error("task batch fixture returned no row");
  }
  return { count: total, maxId, minId };
}

async function commitFixture(
  body: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  await client.sql.begin(async (tx) => {
    await body(tx);
  });
}

class FixtureRollback extends Error {
  constructor() {
    super("task board fixture rollback");
    this.name = "FixtureRollback";
  }
}

async function rollbackFixture(
  body: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await client.sql.begin(async (tx) => {
      await body(tx);
      throw new FixtureRollback();
    });
  } catch (error) {
    if (!(error instanceof FixtureRollback)) {
      throw error;
    }
  }
}

function captureTransaction(): { calls: SqlCall[]; tx: TransactionContext } {
  const calls: SqlCall[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) {
      text += "$" + (index + 1) + (strings[index + 1] ?? "");
    }
    calls.push({ text, values });
    return Promise.resolve([]);
  };
  const tx: TransactionContext = {
    db: {} as TransactionContext["db"],
    sql: sql as unknown as TransactionContext["sql"],
  };
  return { calls, tx };
}

async function explain(call: SqlCall): Promise<string> {
  // 计划断言依赖统计信息：夹具库会被反复增删，app_runtime 无 MAINTAIN 权限，
  // 这里用 bootstrap 连接刷新后再关闭顺序扫描，验证查询形状可被既有索引服务。
  await bootstrap.unsafe("ANALYZE app.tasks");
  return client.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = (await tx.unsafe("EXPLAIN (ANALYZE, BUFFERS) " + call.text, [
      ...call.values,
    ] as never[])) as unknown as Array<Record<string, string>>;
    return rows
      .map((row) => row["QUERY PLAN"] ?? JSON.stringify(row))
      .join(String.fromCharCode(10));
  });
}

beforeAll(async () => {
  const urls: TestUrls = testUrls();
  client = createDatabaseClient(urls.runtime, {
    applicationName: "inpulse-task-board-ports",
  });
  bootstrap = connect(urls.bootstrap, 2);
  const roles = await runRaw(client.sql, "SELECT current_user AS role", []);
  expect(roles[0]?.["role"]).toBe("app_runtime");
  uow = new PostgresUnitOfWork(client);
});

afterAll(async () => {
  await client?.close();
  await bootstrap?.end({ timeout: 5 });
});

describe("PostgresTaskQueryPort 看板读（R-8）", () => {
  test("dueState 按 Asia/Shanghai 日界分类，未完成按优先级与截止、已完成按完成时间排序", async () => {
    const scope = await newProject();
    await rollbackFixture(async (tx) => {
      const overdue = await insertBoardTask(tx, scope, {
        due: "overdue",
        title: "逾期普通任务",
      });
      const yesterdayEndHigh = await insertBoardTask(tx, scope, {
        due: "yesterdayEnd",
        priority: "HIGH",
        title: "昨日末尾高优任务",
      });
      const todayNormal = await insertBoardTask(tx, scope, {
        due: "today",
        priority: "NORMAL",
        title: "今日到期普通任务",
      });
      const tomorrowStart = await insertBoardTask(tx, scope, {
        due: "tomorrowStart",
        title: "明日零点任务",
      });
      const futureUrgent = await insertBoardTask(tx, scope, {
        due: "future",
        priority: "URGENT",
        title: "十日之后紧急任务",
      });
      const noDue = await insertBoardTask(tx, scope, { title: "未设截止任务" });
      const doneRecentNormal = await insertBoardTask(tx, scope, {
        due: "overdue",
        priority: "NORMAL",
        workStatus: "DONE",
        title: "最近完成的普通任务",
      });
      const doneOldUrgent = await insertBoardTask(tx, scope, {
        completedAt: "now() - interval '20 days'",
        priority: "URGENT",
        workStatus: "DONE",
        title: "较早完成的紧急任务",
      });
      const canceled = await insertBoardTask(tx, scope, {
        due: "overdue",
        workStatus: "CANCELED",
        title: "已取消任务",
      });

      const page = await taskQuery.listForBoard(transactionContext(tx), {
        projectId: scope.projectId,
      });
      expect(page.truncated).toBe(false);
      // 未完成桶内优先级压过截止时间：高优的昨日末尾任务在普通逾期任务之前、
      // 十日后到期的紧急任务在明日零点任务之前；同为普通档时按截止时间升序
      // （今日到期 → 明日零点 → 未设截止排最后）；已完成仍按完成时间倒序，
      // 新近完成的先于较早完成的。
      expect(page.items.map((row) => row.taskId)).toEqual([
        yesterdayEndHigh,
        overdue,
        futureUrgent,
        todayNormal,
        tomorrowStart,
        noDue,
        doneRecentNormal,
        doneOldUrgent,
        canceled,
      ]);
      const dueStateById = new Map(
        page.items.map((row) => [row.taskId, row.dueState] as const),
      );
      expect(dueStateById.get(overdue)).toBe("OVERDUE");
      expect(dueStateById.get(yesterdayEndHigh)).toBe("OVERDUE");
      expect(dueStateById.get(todayNormal)).toBe("TODAY");
      expect(dueStateById.get(tomorrowStart)).toBe("SCHEDULED");
      expect(dueStateById.get(futureUrgent)).toBe("SCHEDULED");
      expect(dueStateById.get(noDue)).toBe("NONE");
      expect(dueStateById.get(doneRecentNormal)).toBe("NONE");
      expect(dueStateById.get(doneOldUrgent)).toBe("NONE");
      expect(dueStateById.get(canceled)).toBe("NONE");
      const canceledRow = page.items.find((row) => row.taskId === canceled);
      expect(canceledRow?.completedAt).toBeNull();
      const doneRow = page.items.find((row) => row.taskId === doneRecentNormal);
      expect(doneRow?.completedAt).toBeInstanceOf(Date);
    });
  });

  test("卡片负责人为全部负责人的升序集合，不再只取最小 user_id", async () => {
    const scope = await newProject();
    const secondUserId = await createUser(client.sql);
    const thirdUserId = await createUser(client.sql);
    await runRaw(
      client.sql,
      "INSERT INTO app.project_members (project_id, user_id, role) VALUES ($1, $2, 'MEMBER'), ($1, $3, 'MEMBER')",
      [scope.projectId, secondUserId, thirdUserId],
    );
    await rollbackFixture(async (tx) => {
      const multi = await insertBoardTask(tx, scope, { title: "多负责人任务" });
      await runRaw(
        tx,
        "INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES ($1, $2, $3), ($1, $4, $3)",
        [multi, secondUserId, scope.projectId, thirdUserId],
      );
      const single = await insertBoardTask(tx, scope, {
        title: "单负责人任务",
      });

      const page = await taskQuery.listForBoard(transactionContext(tx), {
        projectId: scope.projectId,
      });

      // ADR-040：负责人是平权集合，端口按 user_id 升序返回全部成员。
      const expectedMulti = [scope.userId, secondUserId, thirdUserId].sort(
        (left, right) => left - right,
      );
      const multiRow = page.items.find((row) => row.taskId === multi);
      expect(multiRow?.assigneeIds).toEqual(expectedMulti);
      const singleRow = page.items.find((row) => row.taskId === single);
      expect(singleRow?.assigneeIds).toEqual([scope.userId]);
    });
  });

  test("统计与列表同一集合口径：项目级总计等于各模块之和，空项目为零值", async () => {
    const scope = await newProject();
    const secondModuleId = await newModule(scope, "第二模块");
    await newModule(scope, "空模块");
    await rollbackFixture(async (tx) => {
      await insertBoardTask(tx, scope, { due: "overdue" });
      await insertBoardTask(tx, scope, { due: "today" });
      await insertBoardTask(tx, scope, { workStatus: "DONE" });
      await insertBoardTask(tx, scope, {
        completedAt: "now() - interval '20 days'",
        workStatus: "DONE",
      });
      await insertBoardTask(tx, scope, { workStatus: "CANCELED" });
      await insertBoardTask(tx, scope, {
        due: "future",
        moduleId: secondModuleId,
      });

      const context = transactionContext(tx);
      const stats = await taskQuery.boardStats(context, {
        projectId: scope.projectId,
      });
      expect(stats.totals).toEqual({
        total: 6,
        done: 2,
        open: 3,
        canceled: 1,
        overdue: 1,
        dueToday: 1,
        completedThisWeek: 1,
      });
      // 没有任务的模块不产生分组行，空的第二个模块不在结果里。
      expect(
        stats.modules
          .map((row) => row.moduleId)
          .sort((left, right) => left - right),
      ).toEqual(
        [scope.moduleId, secondModuleId].sort((left, right) => left - right),
      );
      const summed = stats.modules.reduce(
        (accumulator, row) => ({
          total: accumulator.total + row.total,
          done: accumulator.done + row.done,
          open: accumulator.open + row.open,
          canceled: accumulator.canceled + row.canceled,
          overdue: accumulator.overdue + row.overdue,
          dueToday: accumulator.dueToday + row.dueToday,
          completedThisWeek:
            accumulator.completedThisWeek + row.completedThisWeek,
        }),
        {
          total: 0,
          done: 0,
          open: 0,
          canceled: 0,
          overdue: 0,
          dueToday: 0,
          completedThisWeek: 0,
        },
      );
      expect(summed).toEqual(stats.totals);
      const secondModuleStats = stats.modules.find(
        (row) => row.moduleId === secondModuleId,
      );
      expect(secondModuleStats).toMatchObject({
        total: 1,
        done: 0,
        open: 1,
        canceled: 0,
        overdue: 0,
        dueToday: 0,
        completedThisWeek: 0,
      });
      const page = await taskQuery.listForBoard(context, {
        projectId: scope.projectId,
      });
      expect(page.items).toHaveLength(stats.totals.total);
    });
    const empty = await newProject();
    const emptyStats = await uow.run((tx) =>
      taskQuery.boardStats(tx, { projectId: empty.projectId }),
    );
    expect(emptyStats.totals).toEqual({
      total: 0,
      done: 0,
      open: 0,
      canceled: 0,
      overdue: 0,
      dueToday: 0,
      completedThisWeek: 0,
    });
    expect(emptyStats.modules).toEqual([]);
  });

  test("INVALID 不进看板，CANCELED 保留在列表与统计", async () => {
    const scope = await newProject();
    let active = 0;
    let canceled = 0;
    await commitFixture(async (tx) => {
      active = await insertBoardTask(tx, scope, { due: "future" });
      await insertBoardTask(tx, scope, { lifecycleStatus: "INVALID" });
      canceled = await insertBoardTask(tx, scope, { workStatus: "CANCELED" });
    });

    const page = await uow.run((tx) =>
      taskQuery.listForBoard(tx, { projectId: scope.projectId }),
    );
    expect(page.truncated).toBe(false);
    expect(page.items.map((row) => row.taskId)).toEqual([active, canceled]);
    const stats = await uow.run((tx) =>
      taskQuery.boardStats(tx, { projectId: scope.projectId }),
    );
    expect(stats.totals).toEqual({
      total: 2,
      done: 0,
      open: 1,
      canceled: 1,
      overdue: 0,
      dueToday: 0,
      completedThisWeek: 0,
    });
    expect(stats.modules).toHaveLength(1);
  });

  test("超过 TASK_BOARD_TASKS_MAX 截断并标记，excludedTaskIds 在 LIMIT 之前过滤", async () => {
    const scope = await newProject();
    const insertedTotal = TASK_BOARD_TASKS_MAX + 1;
    let minId = 0;
    let maxId = 0;
    await commitFixture(async (tx) => {
      const batch = await insertBoardTaskBatch(tx, scope, insertedTotal);
      expect(batch.count).toBe(insertedTotal);
      minId = batch.minId;
      maxId = batch.maxId;
    });
    expect(maxId - minId + 1).toBe(insertedTotal);

    const full = await uow.run((tx) =>
      taskQuery.listForBoard(tx, { projectId: scope.projectId }),
    );
    expect(full.truncated).toBe(true);
    expect(full.items).toHaveLength(TASK_BOARD_TASKS_MAX);
    const visibleIds = full.items.map((row) => row.taskId);
    expect(visibleIds[0]).toBe(minId);
    expect(visibleIds[visibleIds.length - 1]).toBe(maxId - 1);
    const stats = await uow.run((tx) =>
      taskQuery.boardStats(tx, { projectId: scope.projectId }),
    );
    expect(stats.totals.total).toBe(insertedTotal);

    const remaining = await uow.run((tx) =>
      taskQuery.listForBoard(tx, {
        projectId: scope.projectId,
        excludedTaskIds: visibleIds,
      }),
    );
    expect(remaining.truncated).toBe(false);
    expect(remaining.items.map((row) => row.taskId)).toEqual([maxId]);
    const remainingStats = await uow.run((tx) =>
      taskQuery.boardStats(tx, {
        projectId: scope.projectId,
        excludedTaskIds: visibleIds,
      }),
    );
    expect(remainingStats.totals.total).toBe(1);
  });

  test("跨项目隔离：其他项目的任务不出现在列表与统计", async () => {
    const mine = await newProject();
    const other = await newProject();
    await commitFixture(async (tx) => {
      await insertBoardTask(tx, other, { due: "future" });
      await insertBoardTask(tx, other, { workStatus: "DONE" });
    });

    const page = await uow.run((tx) =>
      taskQuery.listForBoard(tx, { projectId: mine.projectId }),
    );
    expect(page).toEqual({ items: [], truncated: false });
    const stats = await uow.run((tx) =>
      taskQuery.boardStats(tx, { projectId: mine.projectId }),
    );
    expect(stats.totals.total).toBe(0);
    expect(stats.modules).toEqual([]);
  });

  test("看板列表与统计命中任务索引且不回退 Seq Scan", async () => {
    const scope = await newProject();
    await commitFixture(async (tx) => {
      await insertBoardTaskBatch(tx, scope, 200);
    });

    const listCapture = captureTransaction();
    await taskQuery.listForBoard(listCapture.tx, {
      projectId: scope.projectId,
    });
    const statsCapture = captureTransaction();
    await taskQuery.boardStats(statsCapture.tx, {
      projectId: scope.projectId,
    });
    expect(listCapture.calls).toHaveLength(1);
    expect(statsCapture.calls).toHaveLength(1);

    const listPlan = await explain(listCapture.calls[0] as SqlCall);
    const statsPlan = await explain(statsCapture.calls[0] as SqlCall);
    expect(listPlan).toMatch(/Index/i);
    expect(listPlan).not.toMatch(/Seq Scan on tasks/);
    expect(statsPlan).not.toMatch(/Seq Scan on tasks/);
  });
});
