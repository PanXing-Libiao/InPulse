import { describe, expect, it, vi } from "vitest";

import type { ProjectItem } from "@inpulse/api-contract";
import type { UserReadPort, UserRefItem } from "../src/auth/user-read.port.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { UnitOfWork } from "../src/database/unit-of-work.js";
import {
  AggregateReadCursorError,
  type AggregateReadCursorService,
} from "../src/modules/aggregate-read/aggregate-read-cursor.js";
import { LeftoverItemsQueryService } from "../src/modules/aggregate-read/leftover-items-query.service.js";
import type {
  ChangeRecordReadPort,
  LeftoverListPage,
  LeftoverListRow,
} from "../src/modules/change-records/index.js";
import type {
  ModuleNameItem,
  ModuleReadPort,
} from "../src/modules/modules/index.js";
import type {
  ProjectAccessQueryPort,
  ProjectQueryPort,
} from "../src/modules/projects/index.js";
import type {
  TaskQueryPort,
  TaskReadModel,
} from "../src/modules/tasks/index.js";

const baseTime = new Date("2026-09-11T02:00:00.000Z");

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
    memberCount: 2,
    stats: {
      activeModuleCount: 2,
      openTaskCount: 3,
      completedTaskCount: 1,
    },
  };
}

function leftoverRow(
  overrides: Partial<LeftoverListRow> = {},
): LeftoverListRow {
  return {
    leftoverItemId: 71,
    recordId: 501,
    recordCode: "SHOP-CR-201",
    recordTitle: "登录会话超时",
    projectId: 7,
    moduleId: 3,
    authorId: 5,
    publishedAt: baseTime,
    content: "会话 30 分钟后仍可继续操作",
    status: "ACTIVE",
    sourceTaskId: 21,
    followupTaskId: null,
    ...overrides,
  };
}

function taskFixture(
  taskId: number,
  overrides: Partial<TaskReadModel> = {},
): TaskReadModel {
  return {
    taskId,
    projectId: 7,
    moduleId: 3,
    code: "SHOP-T-" + String(taskId),
    title: "任务 " + String(taskId),
    creatorId: 5,
    assigneeId: 5,
    priority: "NORMAL",
    workStatus: "TODO",
    lifecycleStatus: "ACTIVE",
    dueAt: null,
    rowVersion: 1,
    ...overrides,
  };
}

function leftoverSetup(
  options: {
    readonly scopeProjectIds?: readonly number[];
    readonly page?: LeftoverListPage;
    readonly modules?: readonly ModuleNameItem[];
    readonly tasks?: readonly TaskReadModel[];
    readonly users?: readonly UserRefItem[];
    readonly projects?: readonly ProjectItem[];
    readonly decode?: () => number | null;
  } = {},
) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: false,
  });
  const listLeftovers = vi
    .fn()
    .mockResolvedValue(
      options.page ?? { items: [], nextLeftoverItemId: null, hasMore: false },
    );
  const listModuleNames = vi.fn().mockResolvedValue(options.modules ?? []);
  const listByIds = vi.fn().mockResolvedValue(options.tasks ?? []);
  const listUsers = vi
    .fn()
    .mockResolvedValue(
      options.users ?? [{ userId: 5, name: "张三", avatarUrl: null }],
    );
  const listProjects = vi
    .fn()
    .mockResolvedValue(options.projects ?? [projectFixture(7, "商城系统")]);
  const cursor = {
    encode: vi.fn().mockReturnValue("cursor-next"),
    decode: vi.fn(options.decode ?? (() => null)),
  };
  const service = new LeftoverItemsQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { list: listProjects } as unknown as ProjectQueryPort,
    { listNames: listModuleNames } as unknown as ModuleReadPort,
    { listLeftovers } as unknown as ChangeRecordReadPort,
    { listByIds } as unknown as TaskQueryPort,
    { listByIds: listUsers } as unknown as UserReadPort,
    unitOfWork,
    cursor as unknown as AggregateReadCursorService,
  );
  return {
    service,
    listLeftovers,
    listModuleNames,
    listByIds,
    listProjects,
    cursor,
  };
}

describe("LeftoverItemsQueryService.list", () => {
  it("按分桶查询并映射项目、模块、作者与任务引用", async () => {
    const setup = leftoverSetup({
      page: {
        items: [
          leftoverRow(),
          leftoverRow({
            leftoverItemId: 70,
            recordId: 500,
            recordCode: "SHOP-CR-202",
            recordTitle: "独立草稿遗留",
            status: "CONVERTED",
            sourceTaskId: null,
            followupTaskId: 22,
          }),
        ],
        nextLeftoverItemId: 70,
        hasMore: true,
      },
      modules: [{ moduleId: 3, projectId: 7, name: "登录模块" }],
      tasks: [taskFixture(21), taskFixture(22)],
    });

    const result = await setup.service.list({
      actorUserId: 5,
      bucket: "OPEN",
      limit: 1,
    });

    expect(setup.listLeftovers).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [7],
      limit: 1,
      bucket: "OPEN",
    });
    expect(setup.listModuleNames).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [7],
      moduleIds: [3],
    });
    expect(result.items[0]).toEqual({
      leftoverItemId: 71,
      recordId: 501,
      recordCode: "SHOP-CR-201",
      recordTitle: "登录会话超时",
      projectId: 7,
      projectName: "商城系统",
      moduleId: 3,
      moduleName: "登录模块",
      author: { userId: 5, name: "张三", avatarUrl: null },
      publishedAt: baseTime.toISOString(),
      content: "会话 30 分钟后仍可继续操作",
      status: "ACTIVE",
      sourceTask: {
        taskId: 21,
        code: "SHOP-T-21",
        projectId: 7,
        moduleId: 3,
      },
      followupTask: null,
    });
    expect(result.items[1]).toMatchObject({
      status: "CONVERTED",
      sourceTask: null,
      followupTask: {
        taskId: 22,
        code: "SHOP-T-22",
        projectId: 7,
        moduleId: 3,
      },
    });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("cursor-next");
    expect(setup.cursor.encode).toHaveBeenCalledWith({
      actorUserId: 5,
      namespace: "LEFTOVER_ITEMS",
      filterKey: JSON.stringify([null, "OPEN"]),
      afterId: 70,
    });
  });

  it("越权 projectId 收敛为空页且端口收到空 projectIds", async () => {
    const setup = leftoverSetup({ scopeProjectIds: [7] });
    const result = await setup.service.list({
      actorUserId: 5,
      projectId: 999,
      bucket: "CLOSED",
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(setup.listLeftovers).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [],
      limit: 20,
      bucket: "CLOSED",
    });
    expect(setup.cursor.decode).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        actorUserId: 5,
        namespace: "LEFTOVER_ITEMS",
        filterKey: JSON.stringify([999, "CLOSED"]),
      }),
    );
  });

  it("记录目录缺失时以 500 失败而不是静默丢行", async () => {
    const missingModule = leftoverSetup({
      page: {
        items: [leftoverRow()],
        nextLeftoverItemId: null,
        hasMore: false,
      },
    });
    await expect(
      missingModule.service.list({ actorUserId: 5 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });

    const missingAuthor = leftoverSetup({
      page: {
        items: [leftoverRow()],
        nextLeftoverItemId: null,
        hasMore: false,
      },
      modules: [{ moduleId: 3, projectId: 7, name: "登录模块" }],
      users: [],
    });
    await expect(
      missingAuthor.service.list({ actorUserId: 5 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });
  });

  it("非法游标映射为 422 INVALID_CURSOR", async () => {
    const setup = leftoverSetup({
      decode: () => {
        throw new AggregateReadCursorError("signature", "bad");
      },
    });
    await expect(setup.service.list({ actorUserId: 5 })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_CURSOR",
    });
  });
});
