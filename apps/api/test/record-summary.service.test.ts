import { describe, expect, it, vi } from "vitest";

import type { UserReadPort, UserRefItem } from "../src/auth/user-read.port.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { UnitOfWork } from "../src/database/unit-of-work.js";
import { RecordSummaryQueryService } from "../src/modules/aggregate-read/record-summary-query.service.js";
import type {
  ChangeRecordReadPort,
  RecordSummaryLeftoverPage,
  RecordSummaryLeftoverRow,
  RecordSummaryRecordPage,
  RecordSummaryRecordRow,
} from "../src/modules/change-records/index.js";
import type { ModuleReadPort } from "../src/modules/modules/index.js";
import type {
  ProjectAccessQueryPort,
  ProjectQueryPort,
} from "../src/modules/projects/index.js";
import type {
  SummaryTaskPage,
  SummaryTaskRow,
  TaskQueryPort,
  TaskReadModel,
} from "../src/modules/tasks/index.js";

// F-33 迭代总结取数服务：授权收窄、缺口判定、截断降级与分节口径全部在单元层
// 用桩端口验证；SQL 与真实约束由 record-summary.integration.test.ts 覆盖。

const unitOfWork = {
  run: async <T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> =>
    fn({} as TransactionContext),
} as unknown as UnitOfWork;

const baseTime = new Date("2026-09-20T02:00:00.000Z");

function userFixture(userId: number, name: string): UserRefItem {
  return { userId, name, avatarUrl: null };
}

function recordFixture(
  overrides: Partial<RecordSummaryRecordRow> = {},
): RecordSummaryRecordRow {
  return {
    recordId: 100,
    recordCode: "SHOP-CR-100",
    projectId: 7,
    moduleId: 3,
    title: "登录页首屏优化",
    changeSolution: "改动方案",
    resultVerification: "首屏从 2s 降到 0.8s",
    authorId: 5,
    publishedAt: baseTime,
    taskId: 20,
    ...overrides,
  };
}

function taskFixture(overrides: Partial<SummaryTaskRow> = {}): SummaryTaskRow {
  return {
    taskId: 20,
    code: "SHOP-T-20",
    projectId: 7,
    moduleId: 3,
    title: "登录页首屏优化",
    completedAt: baseTime,
    assigneeId: 6,
    ...overrides,
  };
}

function leftoverFixture(
  overrides: Partial<RecordSummaryLeftoverRow> = {},
): RecordSummaryLeftoverRow {
  return {
    leftoverItemId: 900,
    recordId: 100,
    recordCode: "SHOP-CR-100",
    recordTitle: "登录页首屏优化",
    projectId: 7,
    authorId: 5,
    content: "移动端仍未覆盖",
    status: "ACTIVE",
    followupTaskId: null,
    publishedAt: baseTime,
    ...overrides,
  };
}

function setup(
  options: {
    readonly scopeProjectIds?: readonly number[];
    readonly records?: RecordSummaryRecordPage;
    readonly tasks?: SummaryTaskPage;
    readonly leftovers?: RecordSummaryLeftoverPage;
    readonly linkedTasks?: readonly TaskReadModel[];
    readonly moduleNames?: readonly {
      readonly moduleId: number;
      readonly projectId: number;
      readonly name: string;
    }[];
    readonly users?: readonly UserRefItem[];
    readonly projectNames?: readonly string[];
  } = {},
) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: false,
  });
  // 按传入的 projectIds 过滤，忠实反映 PostgresProjectQueryPort：只请求「命中页数据
  // 的项目」时不会带回授权范围内的其它项目，这正是窄区间 500 的触发条件。
  const projectNameById = new Map(
    (options.scopeProjectIds ?? [7]).map((id, index) => [
      id,
      (options.projectNames ?? ["商城系统"])[index] ?? `项目 ${String(id)}`,
    ]),
  );
  const listProjects = vi
    .fn()
    .mockImplementation(async (projectIds: readonly number[]) =>
      projectIds.map((id) => ({ id, name: projectNameById.get(id) as string })),
    );
  const listModuleNames = vi
    .fn()
    .mockResolvedValue(
      options.moduleNames ?? [{ moduleId: 3, projectId: 7, name: "登录模块" }],
    );
  const summaryRecords = vi.fn().mockResolvedValue(
    options.records ?? {
      items: [recordFixture()],
      total: 1,
      hasMore: false,
    },
  );
  const summaryLeftovers = vi.fn().mockResolvedValue(
    options.leftovers ?? {
      items: [],
      total: 0,
      closedTotal: 0,
      hasMore: false,
    },
  );
  const summaryCompletedTasks = vi.fn().mockResolvedValue(
    options.tasks ?? {
      items: [taskFixture()],
      total: 1,
      hasMore: false,
    },
  );
  const listByIds = vi.fn().mockResolvedValue(options.linkedTasks ?? []);
  const listUsers = vi
    .fn()
    .mockResolvedValue(
      options.users ?? [userFixture(5, "作者"), userFixture(6, "负责人")],
    );
  const service = new RecordSummaryQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { list: listProjects } as unknown as ProjectQueryPort,
    { listNames: listModuleNames } as unknown as ModuleReadPort,
    {
      summaryRecords,
      summaryLeftovers,
    } as unknown as ChangeRecordReadPort,
    {
      summaryCompletedTasks,
      listByIds,
    } as unknown as TaskQueryPort,
    { listByIds: listUsers } as unknown as UserReadPort,
    unitOfWork,
  );
  return {
    service,
    getAuthorizedSearchScope,
    summaryRecords,
    summaryLeftovers,
    summaryCompletedTasks,
    listProjects,
    listByIds,
    listUsers,
  };
}

const command = {
  actorUserId: 5,
  fromDate: "2026-01-01",
  toDate: "2026-12-31",
  groupBy: "PROJECT",
} as const;

describe("RecordSummaryQueryService.get", () => {
  it("按项目分组返回计数、要点与缺口，日期直接下发给端口", async () => {
    const setupResult = setup();
    const result = await setupResult.service.get({ ...command });

    expect(setupResult.summaryRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectIds: [7],
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
      }),
    );
    expect(result.range).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(result.totals).toMatchObject({
      projectCount: 1,
      moduleCount: 1,
      recordCount: 1,
      completedTaskCount: 1,
      missingRecordTaskCount: 0,
    });
    expect(result.sections).toEqual([
      {
        key: "7",
        projectId: 7,
        member: null,
        recordCount: 1,
        completedTaskCount: 1,
      },
    ]);
    expect(result.points[0]).toMatchObject({
      recordCode: "SHOP-CR-100",
      projectName: "商城系统",
      moduleName: "登录模块",
      detail: "首屏从 2s 降到 0.8s",
      author: { userId: 5, name: "作者" },
    });
    expect(result.gaps).toEqual([]);
  });

  it("范围内没有任何记录时，同模块下的已完成任务进入缺口", async () => {
    const setupResult = setup({
      records: { items: [], total: 0, hasMore: false },
    });
    const result = await setupResult.service.get({ ...command });

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      taskId: 20,
      taskCode: "SHOP-T-20",
      moduleName: "登录模块",
      assignee: { userId: 6, name: "负责人" },
    });
    expect(result.totals.missingRecordTaskCount).toBe(1);
  });

  it("模块级记录覆盖整个模块，该模块下的任务不算缺口", async () => {
    const setupResult = setup({
      records: {
        items: [
          recordFixture({
            recordId: 101,
            recordCode: "SHOP-CR-101",
          }),
        ],
        total: 1,
        hasMore: false,
      },
    });
    const result = await setupResult.service.get({ ...command });

    expect(result.gaps).toEqual([]);
  });

  it("记录被截断时不做缺口判定，只置 truncated", async () => {
    const setupResult = setup({
      records: { items: [recordFixture()], total: 5000, hasMore: true },
    });
    const result = await setupResult.service.get({ ...command });

    expect(result.truncated).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.totals.missingRecordTaskCount).toBe(0);
    expect(result.totals.recordCount).toBe(5000);
  });

  it("项目收窄后超出授权范围时返回空结果且不读任何数据", async () => {
    const setupResult = setup({
      scopeProjectIds: [9],
      projectNames: ["别的项目"],
    });
    const result = await setupResult.service.get({
      ...command,
      projectId: 7,
    });

    expect(result.totals.recordCount).toBe(0);
    expect(result.sections).toEqual([]);
    expect(result.scope.projectIds).toEqual([]);
    expect(setupResult.summaryRecords).not.toHaveBeenCalled();
    expect(setupResult.summaryCompletedTasks).not.toHaveBeenCalled();
  });

  it("按成员分组时记录归作者、任务归负责人，并按总量倒序", async () => {
    const setupResult = setup({
      tasks: {
        items: [
          taskFixture({ taskId: 21, code: "SHOP-T-21", assigneeId: 6 }),
          taskFixture({ taskId: 22, code: "SHOP-T-22", assigneeId: 6 }),
        ],
        total: 2,
        hasMore: false,
      },
    });
    const result = await setupResult.service.get({
      ...command,
      groupBy: "MEMBER",
    });

    expect(result.sections.map((section) => section.key)).toEqual(["6", "5"]);
    expect(result.sections[0]).toMatchObject({
      recordCount: 0,
      completedTaskCount: 2,
      member: { userId: 6, name: "负责人" },
    });
    expect(result.sections[1]).toMatchObject({
      recordCount: 1,
      completedTaskCount: 0,
      member: { userId: 5, name: "作者" },
    });
  });

  it("遗留问题与跟进任务编号一并回填，闭环数取服务端口径", async () => {
    const setupResult = setup({
      leftovers: {
        items: [
          leftoverFixture(),
          leftoverFixture({
            leftoverItemId: 901,
            status: "CONVERTED",
            followupTaskId: 30,
          }),
        ],
        total: 2,
        closedTotal: 1,
        hasMore: false,
      },
      linkedTasks: [
        { taskId: 20, code: "SHOP-T-20" } as unknown as TaskReadModel,
        { taskId: 30, code: "SHOP-T-30" } as unknown as TaskReadModel,
      ],
    });
    const result = await setupResult.service.get({ ...command });

    expect(result.totals.leftoverCount).toBe(2);
    expect(result.totals.closedLeftoverCount).toBe(1);
    expect(result.points[0]?.taskCode).toBe("SHOP-T-20");
    expect(result.leftovers[1]).toMatchObject({
      status: "CONVERTED",
      followupTaskId: 30,
      followupTaskCode: "SHOP-T-30",
    });
  });

  it("授权范围内某项目在区间内没有数据时，项目名仍按整个授权范围回填", async () => {
    // 回归：scope.projectNames 曾按「命中页数据的项目」取名，区间内既无记录也无已
    // 完成任务 / 遗留问题的授权项目会被判成 AGGREGATE_READ_INCONSISTENT——单日 /
    // 窄区间必现 500。
    const setupResult = setup({
      scopeProjectIds: [7, 8],
      projectNames: ["商城系统", "风控项目"],
    });
    const result = await setupResult.service.get({ ...command });

    expect(setupResult.listProjects).toHaveBeenCalledWith([7, 8]);
    expect(result.scope).toEqual({
      projectIds: [7, 8],
      projectNames: ["商城系统", "风控项目"],
      member: null,
    });
    // 项目 8 无数据：不进入分节，但整卡仍能取到名字而不是抛错。
    expect(result.sections.map((section) => section.projectId)).toEqual([7]);
  });

  it("授权范围在区间内完全无数据时返回空结果，且项目名依旧完整", async () => {
    const setupResult = setup({
      scopeProjectIds: [7, 8],
      projectNames: ["商城系统", "风控项目"],
      records: { items: [], total: 0, hasMore: false },
      tasks: { items: [], total: 0, hasMore: false },
    });
    const result = await setupResult.service.get({ ...command });

    expect(result.scope.projectNames).toEqual(["商城系统", "风控项目"]);
    expect(result.totals.recordCount).toBe(0);
    expect(result.sections).toEqual([]);
    expect(result.points).toEqual([]);
  });

  it("缺少项目或模块名称时按聚合读不一致失败，不返回残缺正文", async () => {
    const setupResult = setup({ moduleNames: [] });
    await expect(setupResult.service.get({ ...command })).rejects.toMatchObject(
      {
        status: 500,
        code: "AGGREGATE_READ_INCONSISTENT",
      },
    );
  });
});
