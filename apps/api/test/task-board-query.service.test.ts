import { describe, expect, it, vi } from "vitest";

import type { ProjectItem } from "@inpulse/api-contract";
import type { UserReadPort, UserRefItem } from "../src/auth/user-read.port.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { UnitOfWork } from "../src/database/unit-of-work.js";
import { TaskBoardQueryService } from "../src/modules/aggregate-read/task-board-query.service.js";
import type { ChangeRecordReadPort } from "../src/modules/change-records/index.js";
import type { ModuleReadPort } from "../src/modules/modules/index.js";
import type {
  ProjectAccessQueryPort,
  ProjectQueryPort,
} from "../src/modules/projects/index.js";
import type { TaskGroupMembershipReadPort } from "../src/modules/task-groups/index.js";
import type {
  TaskBoardModuleStatsRow,
  TaskBoardStatsTotals,
  TaskBoardTaskRow,
  TaskQueryPort,
} from "../src/modules/tasks/index.js";

const unitOfWork = {
  run: async <T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> =>
    fn({} as TransactionContext),
} as unknown as UnitOfWork;

function projectFixture(id: number, name: string): ProjectItem {
  return {
    id,
    code: "P" + String(id),
    name,
    description: "项目描述",
    status: "ACTIVE",
    hasCompletedTask: true,
    rowVersion: 1,
    createdBy: 5,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    memberCount: 4,
    stats: {
      activeModuleCount: 2,
      openTaskCount: 2,
      completedTaskCount: 1,
    },
  };
}

function totalsFixture(
  overrides: Partial<TaskBoardStatsTotals> = {},
): TaskBoardStatsTotals {
  return {
    total: 3,
    done: 1,
    open: 2,
    canceled: 0,
    overdue: 1,
    dueToday: 1,
    completedThisWeek: 1,
    ...overrides,
  };
}

function rowFixture(
  taskId: number,
  overrides: Partial<TaskBoardTaskRow> = {},
): TaskBoardTaskRow {
  return {
    taskId,
    moduleId: 3,
    code: "SHOP-T-" + String(taskId),
    title: "任务 " + String(taskId),
    assigneeIds: [9],
    priority: "NORMAL",
    workStatus: "TODO",
    dueAt: new Date("2026-09-20T02:00:00.000Z"),
    completedAt: null,
    dueState: "SCHEDULED",
    ...overrides,
  };
}

function userFixture(userId: number, name: string): UserRefItem {
  return { userId, name, avatarUrl: null };
}

interface SetupOptions {
  readonly scopeProjectIds?: readonly number[];
  readonly project?: ProjectItem;
  readonly projectMissing?: boolean;
  readonly rows?: readonly TaskBoardTaskRow[];
  readonly truncated?: boolean;
  readonly totals?: TaskBoardStatsTotals;
  readonly moduleStats?: readonly TaskBoardModuleStatsRow[];
  readonly moduleNames?: readonly {
    readonly moduleId: number;
    readonly name: string;
  }[];
  readonly users?: readonly UserRefItem[];
  readonly publishedRecordCounts?: readonly {
    readonly taskId: number;
    readonly count: number;
  }[];
}

function boardSetup(options: SetupOptions = {}) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: false,
  });
  const find = vi
    .fn()
    .mockResolvedValue(
      options.projectMissing
        ? undefined
        : (options.project ?? projectFixture(7, "支付中心")),
    );
  const rows = options.rows ?? [rowFixture(21)];
  const listForBoard = vi.fn().mockResolvedValue({
    items: rows,
    truncated: options.truncated ?? false,
  });
  const moduleStats =
    options.moduleStats ??
    rows
      .map((row) => row.moduleId)
      .filter((moduleId, index, all) => all.indexOf(moduleId) === index)
      .map((moduleId) => ({ moduleId, ...totalsFixture() }));
  const boardStats = vi.fn().mockResolvedValue({
    totals: options.totals ?? totalsFixture(),
    modules: moduleStats,
  });
  const listModuleNames = vi.fn().mockResolvedValue(
    options.moduleNames ??
      [...new Set(rows.map((row) => row.moduleId))].map((moduleId) => ({
        moduleId,
        name: "模块 " + String(moduleId),
      })),
  );
  const countPublishedByTask = vi
    .fn()
    .mockResolvedValue(options.publishedRecordCounts ?? []);
  const listHistoricalSourceTaskIds = vi.fn().mockResolvedValue([90]);
  const listUsers = vi
    .fn()
    .mockResolvedValue(options.users ?? [userFixture(9, "张启明")]);

  const service = new TaskBoardQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { find } as unknown as ProjectQueryPort,
    { listForBoard, boardStats } as unknown as TaskQueryPort,
    { listNames: listModuleNames } as unknown as ModuleReadPort,
    { countPublishedByTask } as unknown as ChangeRecordReadPort,
    { listHistoricalSourceTaskIds } as unknown as TaskGroupMembershipReadPort,
    { listByIds: listUsers } as unknown as UserReadPort,
    unitOfWork,
  );

  return {
    service,
    getAuthorizedSearchScope,
    find,
    listForBoard,
    boardStats,
    listModuleNames,
    countPublishedByTask,
    listHistoricalSourceTaskIds,
    listUsers,
  };
}

describe("TaskBoardQueryService.getBoard", () => {
  it("非成员或项目缺失统一 404，且不读取任何看板数据", async () => {
    const outOfScope = boardSetup({ scopeProjectIds: [9] });
    await expect(
      outOfScope.service.getBoard({ actorUserId: 5, projectId: 7 }),
    ).rejects.toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    expect(outOfScope.find).not.toHaveBeenCalled();
    expect(outOfScope.listForBoard).not.toHaveBeenCalled();

    const missing = boardSetup({ projectMissing: true });
    await expect(
      missing.service.getBoard({ actorUserId: 5, projectId: 7 }),
    ).rejects.toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    expect(missing.listForBoard).not.toHaveBeenCalled();
  });

  it("排除历史来源分支并透传截断标记", async () => {
    const setup = boardSetup({ truncated: true });

    const result = await setup.service.getBoard({
      actorUserId: 5,
      projectId: 7,
    });

    expect(setup.listHistoricalSourceTaskIds).toHaveBeenCalledWith({}, [7]);
    expect(setup.listForBoard).toHaveBeenCalledWith(
      {},
      {
        projectId: 7,
        excludedTaskIds: [90],
      },
    );
    expect(setup.boardStats).toHaveBeenCalledWith(
      {},
      {
        projectId: 7,
        excludedTaskIds: [90],
      },
    );
    expect(result.truncated).toBe(true);
  });

  it("按模块组装泳道、卡片与项目级统计", async () => {
    const setup = boardSetup({
      rows: [
        rowFixture(21, { dueState: "OVERDUE" }),
        rowFixture(22, {
          workStatus: "DONE",
          completedAt: new Date("2026-09-17T02:00:00.000Z"),
          dueAt: null,
          dueState: "NONE",
        }),
        rowFixture(23, { moduleId: 4 }),
      ],
      totals: totalsFixture({ total: 39, done: 12, open: 27, canceled: 0 }),
      publishedRecordCounts: [{ taskId: 22, count: 2 }],
    });

    const result = await setup.service.getBoard({
      actorUserId: 5,
      projectId: 7,
    });

    expect(result.project).toEqual({
      projectId: 7,
      name: "支付中心",
      status: "ACTIVE",
    });
    expect(result.stats).toMatchObject({
      total: 39,
      done: 12,
      open: 27,
      completionRate: 31,
      memberCount: 4,
    });
    expect(result.modules.map((lane) => lane.moduleId)).toEqual([3, 4]);
    const [first, second] = result.modules;
    expect(first?.name).toBe("模块 3");
    expect(first?.tasks).toHaveLength(2);
    expect(first?.tasks[1]).toMatchObject({
      taskId: 22,
      workStatus: "DONE",
      dueState: "NONE",
      publishedRecordCount: 2,
      assignees: [{ userId: 9, name: "张启明", avatarUrl: null }],
    });
    expect(first?.tasks[1]?.completedAt).toBe("2026-09-17T02:00:00.000Z");
    expect(second?.tasks[0]).toMatchObject({
      taskId: 23,
    });
  });

  it("完成率分母为 0 时取 0，不产生除零结果", async () => {
    const setup = boardSetup({
      rows: [
        rowFixture(21, {
          workStatus: "CANCELED",
          dueAt: null,
          dueState: "NONE",
        }),
      ],
      totals: totalsFixture({ total: 1, done: 0, open: 0, canceled: 1 }),
      moduleStats: [
        {
          moduleId: 3,
          ...totalsFixture({ total: 1, done: 0, open: 0, canceled: 1 }),
        },
      ],
    });

    const result = await setup.service.getBoard({
      actorUserId: 5,
      projectId: 7,
    });

    expect(result.stats.completionRate).toBe(0);
    expect(result.modules[0]?.stats.completionRate).toBe(0);
  });

  it("泳道头像按出现顺序去重并截断到上限", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      rowFixture(100 + index, { assigneeIds: [1000 + index] }),
    );
    const setup = boardSetup({
      rows,
      users: rows.map((row) =>
        userFixture(row.assigneeIds[0]!, "成员" + String(row.assigneeIds[0])),
      ),
      moduleStats: [{ moduleId: 3, ...totalsFixture({ total: 30 }) }],
    });

    const result = await setup.service.getBoard({
      actorUserId: 5,
      projectId: 7,
    });

    expect(result.modules[0]?.assignees).toHaveLength(24);
    expect(result.modules[0]?.assignees[0]?.userId).toBe(1000);
    expect(result.modules[0]?.tasks).toHaveLength(30);
  });

  it("卡片列出全部负责人，泳道头像按 userId 去重", async () => {
    const setup = boardSetup({
      rows: [
        rowFixture(21, { assigneeIds: [9, 4] }),
        rowFixture(22, { assigneeIds: [4] }),
      ],
      users: [userFixture(9, "张启明"), userFixture(4, "林沐")],
      moduleStats: [{ moduleId: 3, ...totalsFixture({ total: 2 }) }],
    });

    const result = await setup.service.getBoard({
      actorUserId: 5,
      projectId: 7,
    });

    // ADR-040：卡片列出全部负责人，不再只取 min(user_id) 的单个负责人。
    expect(result.modules[0]?.tasks[0]?.assignees).toEqual([
      { userId: 9, name: "张启明", avatarUrl: null },
      { userId: 4, name: "林沐", avatarUrl: null },
    ]);
    expect(result.modules[0]?.tasks[1]?.assignees).toEqual([
      { userId: 4, name: "林沐", avatarUrl: null },
    ]);
    // 泳道头像组按卡片出现顺序去重，同一人不重复。
    expect(result.modules[0]?.assignees).toEqual([
      { userId: 9, name: "张启明", avatarUrl: null },
      { userId: 4, name: "林沐", avatarUrl: null },
    ]);
    // 用户解析一次批量覆盖全部去重后的负责人。
    expect(setup.listUsers).toHaveBeenCalledTimes(1);
    expect(setup.listUsers.mock.calls[0]![1]).toEqual([9, 4]);
  });

  it("任务缺少模块名时按聚合读不一致返回 500", async () => {
    const setup = boardSetup({ moduleNames: [] });

    await expect(
      setup.service.getBoard({ actorUserId: 5, projectId: 7 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });
  });

  it("任务负责人缺失时按聚合读不一致返回 500", async () => {
    const setup = boardSetup({ users: [] });

    await expect(
      setup.service.getBoard({ actorUserId: 5, projectId: 7 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });
  });
});
