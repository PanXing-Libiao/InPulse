import { describe, expect, it, vi } from "vitest";

import type { ProjectItem } from "@inpulse/api-contract";
import type { UserReadPort, UserRefItem } from "../src/auth/user-read.port.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { UnitOfWork } from "../src/database/unit-of-work.js";
import {
  AggregateReadCursorError,
  type AggregateReadCursorService,
} from "../src/modules/aggregate-read/aggregate-read-cursor.js";
import { AggregateReadError } from "../src/modules/aggregate-read/aggregate-read.errors.js";
import { MyTasksQueryService } from "../src/modules/aggregate-read/my-tasks-query.service.js";
import { ProjectOverviewQueryService } from "../src/modules/aggregate-read/project-overview-query.service.js";
import { TaskGroupMembershipQueryService } from "../src/modules/aggregate-read/task-group-membership-query.service.js";
import { TaskGroupQueryService } from "../src/modules/aggregate-read/task-group-query.service.js";
import type {
  ChangeRecordReadPort,
  MyTaskLeftoverEntry,
  MyTaskListPage,
  MyTaskListRow,
  MyTaskQueryPort,
  MyTaskStatsResult,
  TaskGroupRecordPage,
} from "../src/modules/change-records/index.js";
import type { ExternalLinksQueryPort } from "../src/modules/external-links/index.js";
import type { ModuleReadPort } from "../src/modules/modules/index.js";
import type {
  ProjectAccessQueryPort,
  ProjectQueryPort,
} from "../src/modules/projects/index.js";
import type {
  TaskGroupActiveMemberRow,
  TaskGroupListPage,
  TaskGroupMembershipReadPort,
} from "../src/modules/task-groups/index.js";
import type {
  TaskGroupMemberRow,
  TaskGroupReadPort,
  TaskGroupReadRecord,
} from "../src/modules/task-groups/task-group-read.port.js";
import type {
  TaskQueryPort,
  TaskReadModel,
} from "../src/modules/tasks/index.js";

const baseTime = new Date("2026-09-09T02:00:00.000Z");

const unitOfWork = {
  run: async <T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> =>
    fn({} as TransactionContext),
} as unknown as UnitOfWork;

function cursorMock(
  options: {
    readonly decode?: () => number | null;
    readonly decodeKey?: () => {
      readonly afterId: number;
      readonly sortKey: string | null;
    } | null;
  } = {},
) {
  return {
    encode: vi.fn().mockReturnValue("cursor-next"),
    decode: vi.fn(options.decode ?? (() => null)),
    // ADR-037 / ADR-041：任务中心走 decodeKey，载荷必须带排序键（版本 7 为 8 段：
    // 版本|状态分组|完成时间|紧急桶|优先级|遗留问题来源|截止|任务ID）。测试用最小合法键。
    decodeKey: vi.fn(
      options.decodeKey ??
        (() => {
          const afterId = options.decode?.() ?? null;
          return afterId === null
            ? null
            : { afterId, sortKey: `7|0||3|2|1||${afterId}` };
        }),
    ),
  };
}

function groupFixture(
  overrides: Partial<TaskGroupReadRecord> = {},
): TaskGroupReadRecord {
  return {
    groupId: 11,
    projectId: 7,
    code: "SHOP-TG-1",
    name: "登出聚合",
    status: "ACTIVE",
    rowVersion: 3,
    createdAt: baseTime,
    closedAt: null,
    ...overrides,
  };
}

function memberFixture(
  overrides: Partial<TaskGroupMemberRow> = {},
): TaskGroupMemberRow {
  return {
    memberId: 1,
    taskId: 21,
    role: "MAIN",
    sourceKind: null,
    status: "ACTIVE",
    joinedAt: baseTime,
    detachedAt: null,
    detachReason: null,
    ...overrides,
  };
}

function activeMemberFixture(
  overrides: Partial<TaskGroupActiveMemberRow> = {},
): TaskGroupActiveMemberRow {
  return {
    memberId: 1,
    groupId: 11,
    taskId: 21,
    role: "MAIN",
    sourceKind: null,
    status: "ACTIVE",
    joinedAt: baseTime,
    detachedAt: null,
    detachReason: null,
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

function taskRowFixture(
  taskId: number,
  overrides: Partial<MyTaskListRow> = {},
): MyTaskListRow {
  return {
    taskId,
    projectId: 7,
    moduleId: 3,
    code: "SHOP-T-" + String(taskId),
    title: "任务 " + String(taskId),
    assigneeId: 5,
    assigneeIds: [5],
    workStatus: "TODO",
    lifecycleStatus: "ACTIVE",
    rowVersion: 1,
    createdAt: baseTime,
    updatedAt: baseTime,
    priority: "NORMAL",
    dueAt: null,
    completedAt: null,
    creatorId: 5,
    ...overrides,
  };
}

function projectFixture(
  id: number,
  name: string,
  status: ProjectItem["status"] = "ACTIVE",
): ProjectItem {
  return {
    id,
    code: "P" + String(id),
    name,
    description: "项目描述",
    status,
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

function taskGroupSetup(
  options: {
    readonly scopeProjectIds?: readonly number[];
    readonly group?: TaskGroupReadRecord;
    readonly members?: readonly TaskGroupMemberRow[];
    readonly tasks?: readonly TaskReadModel[];
    readonly counts?: readonly {
      readonly taskId: number;
      readonly count: number;
    }[];
    readonly page?: TaskGroupRecordPage;
    readonly projects?: readonly ProjectItem[];
    readonly decode?: () => number | null;
  } = {},
) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: false,
  });
  const findGroupById = vi.fn().mockResolvedValue(options.group);
  const listMembers = vi.fn().mockResolvedValue(options.members ?? []);
  const listByIds = vi.fn().mockResolvedValue(options.tasks ?? []);
  const countPublishedByTask = vi.fn().mockResolvedValue(options.counts ?? []);
  const listVisibleRecordsByTaskIds = vi
    .fn()
    .mockResolvedValue(
      options.page ?? { items: [], nextRecordId: null, hasMore: false },
    );
  const listChangeRecordLinks = vi.fn().mockResolvedValue([]);
  const projects = options.projects ?? [projectFixture(7, "商城系统")];
  const listProjects = vi.fn().mockResolvedValue(projects);
  // 状态过滤与项目名解析共用同一份夹具，忠实反映 PostgresProjectQueryPort。
  const listStatuses = vi
    .fn()
    .mockImplementation((projectIds: readonly number[]) =>
      Promise.resolve(
        projects
          .filter((project) => projectIds.includes(project.id))
          .map((project) => ({
            projectId: project.id,
            status: project.status,
          })),
      ),
    );
  const listUsers = vi
    .fn()
    .mockResolvedValue([{ userId: 5, name: "成员", avatarUrl: null }]);
  const cursor = cursorMock(
    options.decode === undefined ? {} : { decode: options.decode },
  );
  const service = new TaskGroupQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { findGroupById, listMembers } as unknown as TaskGroupReadPort,
    { list: listProjects, listStatuses } as unknown as ProjectQueryPort,
    { listByIds } as unknown as TaskQueryPort,
    {
      countPublishedByTask,
      listVisibleRecordsByTaskIds,
    } as unknown as ChangeRecordReadPort,
    { listByIds: listUsers } as unknown as UserReadPort,
    { listChangeRecordLinks } as unknown as ExternalLinksQueryPort,
    {
      listNames: vi
        .fn()
        .mockResolvedValue([{ moduleId: 3, projectId: 7, name: "模块" }]),
    } as unknown as ModuleReadPort,
    unitOfWork,
    cursor as unknown as AggregateReadCursorService,
  );
  return {
    service,
    cursor,
    findGroupById,
    listMembers,
    listByIds,
    countPublishedByTask,
    listVisibleRecordsByTaskIds,
    listChangeRecordLinks,
    listProjects,
    listStatuses,
  };
}

function taskGroupListSetup(
  options: {
    readonly scopeProjectIds?: readonly number[];
    readonly page?: TaskGroupListPage;
    readonly members?: readonly TaskGroupActiveMemberRow[];
    readonly tasks?: readonly TaskReadModel[];
    readonly users?: readonly UserRefItem[];
    readonly projects?: readonly ProjectItem[];
    readonly moduleNames?: readonly {
      readonly moduleId: number;
      readonly projectId: number;
      readonly name: string;
    }[];
    readonly publishedRecordCounts?: readonly {
      readonly taskId: number;
      readonly count: number;
    }[];
    readonly decode?: () => number | null;
  } = {},
) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: false,
  });
  const listGroups = vi
    .fn()
    .mockResolvedValue(
      options.page ?? { items: [], nextGroupId: null, hasMore: false },
    );
  const listActiveMembersForGroups = vi
    .fn()
    .mockResolvedValue(options.members ?? []);
  const listByIds = vi.fn().mockResolvedValue(options.tasks ?? []);
  const listUsers = vi
    .fn()
    .mockResolvedValue(
      options.users ?? [{ userId: 5, name: "成员", avatarUrl: null }],
    );
  const projects = options.projects ?? [projectFixture(7, "商城系统")];
  const listProjects = vi.fn().mockResolvedValue(projects);
  // 状态过滤与项目名解析共用同一份夹具，忠实反映 PostgresProjectQueryPort。
  const listStatuses = vi
    .fn()
    .mockImplementation((projectIds: readonly number[]) =>
      Promise.resolve(
        projects
          .filter((project) => projectIds.includes(project.id))
          .map((project) => ({
            projectId: project.id,
            status: project.status,
          })),
      ),
    );
  const listModuleNames = vi
    .fn()
    .mockResolvedValue(
      options.moduleNames ?? [{ moduleId: 3, projectId: 7, name: "模块" }],
    );
  const countPublishedByTask = vi
    .fn()
    .mockResolvedValue(options.publishedRecordCounts ?? []);
  const cursor = cursorMock(
    options.decode === undefined ? {} : { decode: options.decode },
  );
  const service = new TaskGroupQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    {
      listGroups,
      listActiveMembersForGroups,
    } as unknown as TaskGroupReadPort,
    { list: listProjects, listStatuses } as unknown as ProjectQueryPort,
    { listByIds } as unknown as TaskQueryPort,
    { countPublishedByTask } as unknown as ChangeRecordReadPort,
    { listByIds: listUsers } as unknown as UserReadPort,
    {} as unknown as ExternalLinksQueryPort,
    { listNames: listModuleNames } as unknown as ModuleReadPort,
    unitOfWork,
    cursor as unknown as AggregateReadCursorService,
  );
  return {
    service,
    listGroups,
    listActiveMembersForGroups,
    listByIds,
    listModuleNames,
    countPublishedByTask,
    listProjects,
    listStatuses,
    cursor,
  };
}

describe("TaskGroupQueryService.getTaskGroup", () => {
  it("聚合组不存在或不在授权范围内时统一 404 且不读取成员", async () => {
    const missing = taskGroupSetup();
    await expect(
      missing.service.getTaskGroup({ actorUserId: 5, groupId: 11 }),
    ).rejects.toMatchObject({ status: 404, code: "TASK_GROUP_NOT_FOUND" });
    expect(missing.listMembers).not.toHaveBeenCalled();

    const outOfScope = taskGroupSetup({
      group: groupFixture(),
      scopeProjectIds: [9],
    });
    await expect(
      outOfScope.service.getTaskGroup({ actorUserId: 5, groupId: 11 }),
    ).rejects.toBeInstanceOf(AggregateReadError);
    expect(outOfScope.listMembers).not.toHaveBeenCalled();
  });

  it("成员排序固定为主任务在前、来源任务按 joinedAt 与 taskId 升序", async () => {
    const setup = taskGroupSetup({
      group: groupFixture(),
      members: [
        memberFixture({
          memberId: 4,
          taskId: 24,
          role: "SOURCE",
          sourceKind: "ACTIVE",
          status: "DETACHED",
          joinedAt: new Date(baseTime.getTime() + 3000),
          detachedAt: new Date(baseTime.getTime() + 4000),
          detachReason: "拆分原因",
        }),
        memberFixture({
          memberId: 3,
          taskId: 23,
          role: "SOURCE",
          sourceKind: "ACTIVE",
          joinedAt: new Date(baseTime.getTime() + 2000),
        }),
        memberFixture({
          memberId: 2,
          taskId: 22,
          role: "SOURCE",
          sourceKind: "ACTIVE",
          joinedAt: new Date(baseTime.getTime() + 2000),
        }),
        memberFixture({ joinedAt: baseTime }),
      ],
      tasks: [
        taskFixture(21),
        taskFixture(22),
        taskFixture(23),
        taskFixture(24),
      ],
      counts: [{ taskId: 21, count: 2 }],
    });

    const result = await setup.service.getTaskGroup({
      actorUserId: 5,
      groupId: 11,
    });

    expect(result.group).toEqual({
      groupId: 11,
      projectId: 7,
      code: "SHOP-TG-1",
      name: "登出聚合",
      status: "ACTIVE",
      createdAt: baseTime.toISOString(),
      closedAt: null,
      rowVersion: 3,
    });
    expect(result.members.map((item) => item.taskId)).toEqual([21, 22, 23, 24]);
    expect(result.members[0]).toMatchObject({
      taskId: 21,
      role: "MAIN",
      sourceKind: null,
      memberStatus: "ACTIVE",
      publishedRecordCount: 2,
      priority: "NORMAL",
      assignee: { userId: 5, name: "成员", avatarUrl: null },
      joinedAt: baseTime.toISOString(),
      detachedAt: null,
    });
    expect(result.members[1]!.role).toBe("SOURCE");
    expect(result.members[1]!.publishedRecordCount).toBe(0);
    expect(result.members[3]).toMatchObject({
      taskId: 24,
      memberStatus: "DETACHED",
      detachReason: "拆分原因",
    });
    expect(result.members[3]!.detachedAt).toBe(
      new Date(baseTime.getTime() + 4000).toISOString(),
    );
  });

  it("成员任务或负责人缺失时以 500 失败而不是静默丢行", async () => {
    const setup = taskGroupSetup({
      group: groupFixture(),
      members: [memberFixture({ taskId: 99 })],
      tasks: [],
    });
    await expect(
      setup.service.getTaskGroup({ actorUserId: 5, groupId: 11 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });
  });
});
describe("TaskGroupQueryService.listTaskGroupRecords", () => {
  it("记录列表按成员任务过滤，游标绑定组与成员筛选", async () => {
    const setup = taskGroupSetup({
      group: groupFixture(),
      members: [
        memberFixture({ memberId: 1, taskId: 21 }),
        memberFixture({
          memberId: 2,
          taskId: 22,
          role: "SOURCE",
          sourceKind: "ACTIVE",
        }),
      ],
      tasks: [taskFixture(21), taskFixture(22)],
      page: {
        items: [
          {
            recordId: 501,
            code: "SHOP-CR-1",
            title: "记录一",
            status: "PUBLISHED",
            taskId: 21,
            publishedAt: baseTime,
          },
          {
            recordId: 500,
            code: "SHOP-CR-2",
            title: "记录二",
            status: "VOID",
            taskId: 22,
            publishedAt: baseTime,
          },
        ],
        nextRecordId: 500,
        hasMore: true,
      },
    });

    const result = await setup.service.listTaskGroupRecords({
      actorUserId: 5,
      groupId: 11,
      limit: 2,
    });

    expect(result.items.map((item) => item.sourceLabel)).toEqual([
      "主任务",
      "SHOP-T-22",
    ]);
    expect(result.items[0]).toMatchObject({
      recordId: 501,
      recordStatus: "PUBLISHED",
      taskId: 21,
      externalLinks: [],
      publishedAt: baseTime.toISOString(),
    });
    expect(result.items[1]!.recordStatus).toBe("VOID");
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("cursor-next");
    expect(setup.listVisibleRecordsByTaskIds).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: 7, taskIds: [21, 22], limit: 2 },
    );
    expect(setup.cursor.encode).toHaveBeenCalledWith({
      actorUserId: 5,
      namespace: "TASK_GROUP_RECORDS",
      filterKey: "TASK_GROUP_RECORDS:11:all",
      afterId: 500,
    });
  });

  it("memberTaskId 不在组内时返回空页且不报 404", async () => {
    const setup = taskGroupSetup({
      group: groupFixture(),
      members: [memberFixture({ taskId: 21 })],
    });
    const result = await setup.service.listTaskGroupRecords({
      actorUserId: 5,
      groupId: 11,
      memberTaskId: 999,
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(setup.listVisibleRecordsByTaskIds).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: 7, taskIds: [], limit: 20 },
    );
    expect(setup.cursor.decode).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        actorUserId: 5,
        namespace: "TASK_GROUP_RECORDS",
        filterKey: "TASK_GROUP_RECORDS:11:999",
      }),
    );
  });

  it("越权时统一 404，非法游标映射 422", async () => {
    const outOfScope = taskGroupSetup({
      group: groupFixture(),
      scopeProjectIds: [9],
    });
    await expect(
      outOfScope.service.listTaskGroupRecords({ actorUserId: 5, groupId: 11 }),
    ).rejects.toMatchObject({ status: 404, code: "TASK_GROUP_NOT_FOUND" });
    expect(outOfScope.listVisibleRecordsByTaskIds).not.toHaveBeenCalled();

    const badCursor = taskGroupSetup({
      group: groupFixture(),
      decode: () => {
        throw new AggregateReadCursorError("signature", "bad");
      },
    });
    await expect(
      badCursor.service.listTaskGroupRecords({ actorUserId: 5, groupId: 11 }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
  });
});

describe("TaskGroupQueryService.listTaskGroups", () => {
  it("维护中项目不再产出聚合组卡片：聚合组查询收到剔除后的项目集合", async () => {
    const setup = taskGroupListSetup({
      scopeProjectIds: [7, 9, 11],
      projects: [
        projectFixture(7, "商城系统"),
        projectFixture(9, "维护项目", "MAINTENANCE"),
        projectFixture(11, "未开始项目", "NOT_STARTED"),
      ],
    });
    await setup.service.listTaskGroups({ actorUserId: 5 });
    expect(setup.listGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [7, 11] }),
    );
    expect(setup.listStatuses).toHaveBeenCalledWith([7, 9, 11]);
  });

  it("授权范围内全部维护中时返回空列表，聚合组查询按空集合短路", async () => {
    const setup = taskGroupListSetup({
      scopeProjectIds: [9],
      projects: [projectFixture(9, "维护项目", "MAINTENANCE")],
    });
    const page = await setup.service.listTaskGroups({ actorUserId: 5 });
    expect(page).toMatchObject({ items: [], hasMore: false });
    expect(setup.listGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [] }),
    );
    expect(setup.listProjects).toHaveBeenCalledWith([]);
  });

  it("组列表映射主任务与分支排序，并签发下一页游标", async () => {
    const setup = taskGroupListSetup({
      page: {
        items: [
          groupFixture({ groupId: 12, code: "SHOP-TG-2", name: "登录聚合" }),
          groupFixture({
            groupId: 11,
            code: "SHOP-TG-1",
            name: "登出聚合",
            status: "CLOSED",
            closedAt: baseTime,
          }),
        ],
        nextGroupId: 11,
        hasMore: true,
      },
      members: [
        activeMemberFixture({
          memberId: 3,
          groupId: 12,
          taskId: 24,
          role: "SOURCE",
          sourceKind: "ACTIVE",
          joinedAt: new Date(baseTime.getTime() + 1000),
        }),
        activeMemberFixture({ memberId: 1, groupId: 12, taskId: 22 }),
        activeMemberFixture({
          memberId: 2,
          groupId: 12,
          taskId: 23,
          role: "SOURCE",
          sourceKind: "HISTORICAL",
        }),
      ],
      tasks: [
        taskFixture(22, {
          workStatus: "TODO",
          priority: "HIGH",
          dueAt: new Date("2026-09-20T02:00:00.000Z"),
        }),
        taskFixture(23, {
          workStatus: "DONE",
          priority: "URGENT",
          dueAt: new Date("2026-09-11T02:00:00.000Z"),
        }),
        taskFixture(24, {
          workStatus: "CANCELED",
          assigneeId: 6,
          priority: "NORMAL",
        }),
      ],
      moduleNames: [{ moduleId: 3, projectId: 7, name: "订单" }],
      publishedRecordCounts: [
        { taskId: 22, count: 3 },
        { taskId: 23, count: 2 },
      ],
      users: [
        { userId: 5, name: "成员", avatarUrl: null },
        {
          userId: 6,
          name: "另一成员",
          avatarUrl: "https://example.com/a.png",
        },
      ],
    });

    const result = await setup.service.listTaskGroups({
      actorUserId: 5,
      limit: 2,
    });

    expect(setup.listGroups).toHaveBeenCalledWith(expect.anything(), {
      actorUserId: 5,
      projectIds: [7],
      limit: 2,
    });
    expect(setup.listActiveMembersForGroups).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [12, 11],
    );
    expect(result.items.map((item) => item.groupId)).toEqual([12, 11]);
    const group = result.items[0]!;
    expect(group).toMatchObject({
      code: "SHOP-TG-2",
      name: "登录聚合",
      projectName: "商城系统",
      status: "ACTIVE",
      mainTask: {
        taskId: 22,
        code: "SHOP-T-22",
        projectId: 7,
        moduleId: 3,
      },
    });
    expect(
      group.branches.map((branch) => [
        branch.taskId,
        branch.role,
        branch.sourceKind,
        branch.workStatus,
        branch.priority,
        branch.moduleId,
        branch.moduleName,
        branch.dueAt,
        branch.publishedRecordCount,
      ]),
    ).toEqual([
      [
        22,
        "MAIN",
        null,
        "TODO",
        "HIGH",
        3,
        "订单",
        "2026-09-20T02:00:00.000Z",
        3,
      ],
      [
        23,
        "SOURCE",
        "HISTORICAL",
        "DONE",
        "URGENT",
        3,
        "订单",
        "2026-09-11T02:00:00.000Z",
        2,
      ],
      [24, "SOURCE", "ACTIVE", "CANCELED", "NORMAL", 3, "订单", null, 0],
    ]);
    // 列表行的「归属 / 截止 / 迭代」三列只靠本页事实字段：模块名按本页 ID 批量取、
    // 记录数按本页 taskIds 批量取，不拉全组或全项目的数据。
    expect(setup.listModuleNames).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [7],
      moduleIds: [3],
    });
    expect(setup.countPublishedByTask).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [24, 22, 23],
    );
    expect(group.branches[2]!.assignee).toEqual({
      userId: 6,
      name: "另一成员",
      avatarUrl: "https://example.com/a.png",
    });
    expect(result.items[1]).toMatchObject({
      groupId: 11,
      status: "CLOSED",
      mainTask: null,
      branches: [],
    });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("cursor-next");
    expect(setup.cursor.encode).toHaveBeenCalledWith({
      actorUserId: 5,
      namespace: "TASK_GROUPS",
      filterKey: JSON.stringify([null]),
      afterId: 11,
    });
  });

  it("越权 projectId 收敛为空页且端口收到空 projectIds", async () => {
    const setup = taskGroupListSetup({ scopeProjectIds: [7] });
    const result = await setup.service.listTaskGroups({
      actorUserId: 5,
      projectId: 999,
    });
    expect(result).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(setup.listGroups).toHaveBeenCalledWith(expect.anything(), {
      actorUserId: 5,
      projectIds: [],
      limit: 20,
    });
    expect(setup.listProjects).toHaveBeenCalledWith([]);
    expect(setup.cursor.decode).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        actorUserId: 5,
        namespace: "TASK_GROUPS",
        filterKey: JSON.stringify([999]),
      }),
    );
  });

  it("组缺少项目或分支负责人缺失时以 500 失败而不是静默丢行", async () => {
    const missingProject = taskGroupListSetup({
      page: {
        items: [groupFixture()],
        nextGroupId: null,
        hasMore: false,
      },
      projects: [],
    });
    await expect(
      missingProject.service.listTaskGroups({ actorUserId: 5 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });

    const missingAssignee = taskGroupListSetup({
      page: {
        items: [groupFixture()],
        nextGroupId: null,
        hasMore: false,
      },
      members: [activeMemberFixture()],
      tasks: [taskFixture(21, { assigneeId: 999 })],
      users: [{ userId: 5, name: "成员", avatarUrl: null }],
    });
    await expect(
      missingAssignee.service.listTaskGroups({ actorUserId: 5 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });

    // 归属列读模块名：模块查不到时不能静默留空，否则列表会把缺失读成「无归属」。
    const missingModule = taskGroupListSetup({
      page: {
        items: [groupFixture()],
        nextGroupId: null,
        hasMore: false,
      },
      members: [activeMemberFixture()],
      tasks: [taskFixture(21)],
      users: [{ userId: 5, name: "成员", avatarUrl: null }],
      moduleNames: [],
    });
    await expect(
      missingModule.service.listTaskGroups({ actorUserId: 5 }),
    ).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });
  });

  it("非法游标映射为 422 INVALID_CURSOR", async () => {
    const setup = taskGroupListSetup({
      decode: () => {
        throw new AggregateReadCursorError("signature", "bad");
      },
    });
    await expect(
      setup.service.listTaskGroups({ actorUserId: 5 }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
  });
});

type OverviewRecentRecord = Awaited<
  ReturnType<ChangeRecordReadPort["listRecentPublished"]>
>[number];

type OverviewLeftover = Awaited<
  ReturnType<ChangeRecordReadPort["listActiveLeftovers"]>
>[number];

function overviewSetup(
  options: {
    readonly scopeProjectIds?: readonly number[];
    readonly project?: ProjectItem;
    readonly excludedTaskIds?: readonly number[];
    readonly recentRecords?: readonly OverviewRecentRecord[];
    readonly leftovers?: readonly OverviewLeftover[];
  } = {},
) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: false,
  });
  const find = vi
    .fn()
    .mockResolvedValue(options.project ?? projectFixture(7, "商城系统"));
  const modulesCount = vi.fn().mockResolvedValue(2);
  const tasksCount = vi.fn().mockResolvedValue(3);
  const countPublished = vi.fn().mockResolvedValue(4);
  const listRecentPublished = vi
    .fn()
    .mockResolvedValue(options.recentRecords ?? []);
  const listActiveLeftovers = vi
    .fn()
    .mockResolvedValue(options.leftovers ?? []);
  const countActiveLeftovers = vi.fn().mockResolvedValue(2);
  const listHistoricalSourceTaskIds = vi
    .fn()
    .mockResolvedValue(options.excludedTaskIds ?? [90]);
  const service = new ProjectOverviewQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { find } as unknown as ProjectQueryPort,
    { count: modulesCount } as unknown as ModuleReadPort,
    { count: tasksCount } as unknown as TaskQueryPort,
    {
      countPublished,
      listRecentPublished,
      listActiveLeftovers,
      countActiveLeftovers,
    } as unknown as ChangeRecordReadPort,
    { listHistoricalSourceTaskIds } as unknown as TaskGroupMembershipReadPort,
    unitOfWork,
  );
  return {
    service,
    find,
    modulesCount,
    tasksCount,
    countPublished,
    listRecentPublished,
    listActiveLeftovers,
    countActiveLeftovers,
    listHistoricalSourceTaskIds,
  };
}

describe("ProjectOverviewQueryService.getOverview", () => {
  it("非成员或项目缺失统一 404，且不读取任何统计", async () => {
    const outOfScope = overviewSetup({ scopeProjectIds: [9] });
    await expect(
      outOfScope.service.getOverview({ actorUserId: 5, projectId: 7 }),
    ).rejects.toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    expect(outOfScope.find).not.toHaveBeenCalled();
    expect(outOfScope.modulesCount).not.toHaveBeenCalled();

    const missing = overviewSetup();
    missing.find.mockResolvedValue(undefined);
    await expect(
      missing.service.getOverview({ actorUserId: 5, projectId: 7 }),
    ).rejects.toBeInstanceOf(AggregateReadError);
    expect(missing.modulesCount).not.toHaveBeenCalled();
  });

  it("统计口径与默认列表条数按服务端固定默认值", async () => {
    const publishedAt = new Date("2026-09-09T03:00:00.000Z");
    const createdAt = new Date("2026-09-09T04:00:00.000Z");
    const setup = overviewSetup({
      excludedTaskIds: [90],
      recentRecords: [
        {
          recordId: 41,
          projectId: 7,
          moduleId: 3,
          code: "SHOP-CR-41",
          title: "迭代",
          currentVersion: 2,
          publishedAt,
        },
      ],
      leftovers: [
        {
          leftoverItemId: 9,
          recordId: 41,
          recordCode: "SHOP-CR-41",
          recordTitle: "迭代记录标题",
          projectId: 7,
          content: "遗留",
          createdAt,
        },
      ],
    });

    const result = await setup.service.getOverview({
      actorUserId: 5,
      projectId: 7,
    });

    expect(result.project).toEqual({
      projectId: 7,
      name: "商城系统",
      status: "ACTIVE",
    });
    expect(result.memberCount).toBe(2);
    expect(result.stats).toEqual({
      activeModuleCount: 2,
      openTaskCount: 3,
      publishedRecordCount: 4,
    });
    expect(result.recentRecords).toEqual([
      {
        recordId: 41,
        code: "SHOP-CR-41",
        title: "迭代",
        moduleId: 3,
        publishedAt: publishedAt.toISOString(),
      },
    ]);
    expect(result.activeLeftoverTotal).toBe(2);
    expect(result.activeLeftovers).toEqual([
      {
        leftoverItemId: 9,
        recordId: 41,
        recordCode: "SHOP-CR-41",
        recordTitle: "迭代记录标题",
        content: "遗留",
        createdAt: createdAt.toISOString(),
      },
    ]);
    // ADR-044：模块已无归档态，投影计数只按 projectId。
    expect(setup.modulesCount).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
    });
    expect(setup.tasksCount).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [7],
      workStatuses: ["TODO"],
      effectiveOnly: true,
      excludedTaskIds: [90],
    });
    expect(setup.countPublished).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
    });
    expect(setup.listRecentPublished).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
      limit: 3,
    });
    expect(setup.listActiveLeftovers).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
      limit: 2,
    });
    expect(setup.countActiveLeftovers).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
    });
  });

  it("显式列表条数直接透传", async () => {
    const setup = overviewSetup();
    await setup.service.getOverview({
      actorUserId: 5,
      projectId: 7,
      recentRecordLimit: 10,
      activeLeftoverLimit: 1,
    });
    expect(setup.listRecentPublished).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
      limit: 10,
    });
    expect(setup.listActiveLeftovers).toHaveBeenCalledWith(expect.anything(), {
      projectId: 7,
      limit: 1,
    });
  });
});
function myTasksSetup(
  options: {
    readonly isSystemAdmin?: boolean;
    readonly scopeProjectIds?: readonly number[];
    readonly page?: MyTaskListPage;
    readonly stats?: MyTaskStatsResult;
    readonly leftover?: MyTaskLeftoverEntry;
    readonly linkCounts?: readonly {
      readonly taskId: number;
      readonly count: number;
    }[];
    readonly decode?: () => number | null;
    readonly projects?: readonly ProjectItem[];
    readonly moduleNames?: readonly {
      readonly moduleId: number;
      readonly projectId: number;
      readonly name: string;
    }[];
    readonly publishedRecordCounts?: readonly {
      readonly taskId: number;
      readonly count: number;
    }[];
    readonly groupRoles?: readonly {
      readonly taskId: number;
      readonly groupId: number;
      readonly role: "MAIN" | "SOURCE";
    }[];
    readonly leftoverSourceTaskIds?: readonly number[];
    /** 负责人解析的目标用户；多负责人用例需要把它扩到两人以上（ADR-040）。 */
    readonly users?: readonly UserRefItem[];
  } = {},
) {
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: options.scopeProjectIds ?? [7],
    isSystemAdmin: options.isSystemAdmin ?? false,
  });
  const listPage = vi
    .fn()
    .mockResolvedValue(
      options.page ?? { items: [], next: null, hasMore: false },
    );
  const projects = options.projects ?? [projectFixture(7, "商城系统")];
  const listProjects = vi.fn().mockResolvedValue(projects);
  // 状态过滤与项目名解析共用同一份夹具，忠实反映 PostgresProjectQueryPort。
  const listStatuses = vi
    .fn()
    .mockImplementation((projectIds: readonly number[]) =>
      Promise.resolve(
        projects
          .filter((project) => projectIds.includes(project.id))
          .map((project) => ({
            projectId: project.id,
            status: project.status,
          })),
      ),
    );
  const listModuleNames = vi
    .fn()
    .mockResolvedValue(
      options.moduleNames ?? [{ moduleId: 3, projectId: 7, name: "模块" }],
    );
  const countPublishedByTask = vi
    .fn()
    .mockResolvedValue(
      options.publishedRecordCounts ?? [{ taskId: 501, count: 2 }],
    );
  const listLeftoverSourceTaskIds = vi
    .fn()
    .mockResolvedValue(options.leftoverSourceTaskIds ?? []);
  const listHistoricalSourceTaskIds = vi.fn().mockResolvedValue([90]);
  const listGroupRoles = vi.fn().mockResolvedValue(options.groupRoles ?? []);
  const countTaskLinks = vi
    .fn()
    .mockResolvedValue(options.linkCounts ?? [{ taskId: 501, count: 3 }]);
  const stats = vi.fn().mockResolvedValue(
    options.stats ?? {
      todayTodo: 3,
      todayTodoBreakdown: {
        overdue: 2,
        leftover: 1,
        urgent: 1,
        dueWithinDays: 1,
      },
      myOpen: 4,
      completed: 3,
      created: 6,
    },
  );
  const leftoverEntry = vi.fn().mockResolvedValue(
    options.leftover ?? {
      count: 2,
      sample: {
        recordCode: "SHOP-CR-41",
        contentPrefix: "最新遗留内容",
        truncated: false,
      },
    },
  );
  const listUsers = vi
    .fn()
    .mockResolvedValue(
      options.users ?? [{ userId: 5, name: "成员", avatarUrl: null }],
    );
  const cursor = cursorMock(
    options.decode === undefined ? {} : { decode: options.decode },
  );
  const service = new MyTasksQueryService(
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { list: listProjects, listStatuses } as unknown as ProjectQueryPort,
    { list: listPage, stats, leftoverEntry } as unknown as MyTaskQueryPort,
    { listNames: listModuleNames } as unknown as ModuleReadPort,
    {
      countPublishedByTask,
      listLeftoverSourceTaskIds,
    } as unknown as ChangeRecordReadPort,
    { countTaskLinks } as unknown as ExternalLinksQueryPort,
    {
      listHistoricalSourceTaskIds,
      listGroupRoles,
    } as unknown as TaskGroupMembershipReadPort,
    { listByIds: listUsers } as unknown as UserReadPort,
    unitOfWork,
    cursor as unknown as AggregateReadCursorService,
  );
  return {
    service,
    cursor,
    listPage,
    countPublishedByTask,
    listLeftoverSourceTaskIds,
    listProjects,
    listHistoricalSourceTaskIds,
    listGroupRoles,
    countTaskLinks,
    stats,
    leftoverEntry,
    listStatuses,
  };
}

describe("MyTasksQueryService.list", () => {
  it("维护中项目不产出任务卡片：分页、统计与遗留入口共用剔除后的集合", async () => {
    const setup = myTasksSetup({
      scopeProjectIds: [7, 9, 11],
      projects: [
        projectFixture(7, "商城系统"),
        projectFixture(9, "维护项目", "MAINTENANCE"),
        projectFixture(11, "未开始项目", "NOT_STARTED"),
      ],
    });
    await setup.service.list({ actorUserId: 5 });
    expect(setup.listPage.mock.calls[0]![1]).toMatchObject({
      projectIds: [7, 11],
    });
    expect(setup.stats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [7, 11] }),
    );
    expect(setup.leftoverEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [7, 11] }),
    );
    expect(setup.listStatuses).toHaveBeenCalledWith([7, 9, 11]);
  });

  it("授权范围内全部维护中时返回空页，统计与遗留入口按空集合收敛", async () => {
    const setup = myTasksSetup({
      scopeProjectIds: [9],
      projects: [projectFixture(9, "维护项目", "MAINTENANCE")],
    });
    const page = await setup.service.list({ actorUserId: 5, projectId: 9 });
    expect(page).toMatchObject({ items: [], hasMore: false });
    expect(setup.listPage.mock.calls[0]![1]).toMatchObject({
      projectIds: [],
    });
    expect(setup.stats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [] }),
    );
    expect(setup.leftoverEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [] }),
    );
  });

  it("项目范围去除个人过滤，仍在授权项目和逾期条件内分页", async () => {
    const setup = myTasksSetup({ scopeProjectIds: [7, 9] });
    await setup.service.list({
      actorUserId: 5,
      scope: "project",
      projectId: 9,
      overdue: true,
    });
    const input = setup.listPage.mock.calls[0]![1];
    expect(input.projectIds).toEqual([9]);
    expect(input.overdue).toBe(true);
    expect(input).not.toHaveProperty("assigneeId");
    expect(input).not.toHaveProperty("creatorId");
    expect(setup.stats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assigneeId: 5 }),
    );
  });
  it("普通成员不能查询管理员全部任务；管理员仍使用服务端项目集合", async () => {
    const denied = myTasksSetup();
    await expect(
      denied.service.list({ actorUserId: 5, scope: "all" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.listPage).not.toHaveBeenCalled();
    const admin = myTasksSetup({
      isSystemAdmin: true,
      scopeProjectIds: [7, 9],
    });
    await admin.service.list({ actorUserId: 5, scope: "all" });
    expect(admin.listPage.mock.calls[0]![1].projectIds).toEqual([7, 9]);
    expect(admin.listPage.mock.calls[0]![1]).not.toHaveProperty("assigneeId");
  });
  it("未选择项目时返回明确参数错误", async () => {
    const setup = myTasksSetup();
    await expect(
      setup.service.list({ actorUserId: 5, scope: "project" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(setup.listPage).not.toHaveBeenCalled();
  });

  it("越权 projectId 收敛为空页而不是 404", async () => {
    const setup = myTasksSetup({ scopeProjectIds: [7] });
    const result = await setup.service.list({ actorUserId: 5, projectId: 9 });
    expect(result).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
      stats: {
        todayTodo: 3,
        todayTodoBreakdown: {
          overdue: 2,
          leftover: 1,
          urgent: 1,
          dueWithinDays: 1,
        },
        myOpen: 4,
        completed: 3,
        created: 6,
      },
      leftoverCount: 2,
      leftoverSample: { recordCode: "SHOP-CR-41", summary: "最新遗留内容" },
    });
    expect(setup.listPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [] }),
    );
    expect(setup.stats).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [],
      assigneeId: 5,
      excludedTaskIds: [90],
    });
  });

  it("筛选进入端口与游标 filterKey，includeCanceled 并入 CANCELED", async () => {
    const setup = myTasksSetup({ scopeProjectIds: [7, 9] });
    await setup.service.list({
      actorUserId: 5,
      projectId: 9,
      workStatus: "TODO",
      hasPublishedRecord: false,
      priority: "HIGH",
      includeCanceled: true,
      limit: 5,
    });
    // ADR-037：任务中心改用 decodeKey，并要求载荷带排序键。
    expect(setup.cursor.decodeKey).toHaveBeenCalledWith(undefined, {
      actorUserId: 5,
      namespace: "MY_TASKS",
      filterKey: JSON.stringify(["ASSIGNEE", 9, "TODO", false, "HIGH", true]),
      requireSortKey: true,
    });
    expect(setup.listPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectIds: [9],
        assigneeId: 5,
        limit: 5,
        excludedTaskIds: [90],
        workStatuses: ["TODO", "CANCELED"],
        hasPublishedRecord: false,
        priority: "HIGH",
      }),
    );
    expect(setup.listPage.mock.calls[0]?.[1]).not.toHaveProperty("creatorId");
  });

  it("todayTodo 进入端口与游标 filterKey（今日待办卡片）", async () => {
    const setup = myTasksSetup({ scopeProjectIds: [7, 9] });
    await setup.service.list({ actorUserId: 5, todayTodo: true });
    expect(setup.cursor.decodeKey).toHaveBeenCalledWith(undefined, {
      actorUserId: 5,
      namespace: "MY_TASKS",
      filterKey: JSON.stringify([
        "mine",
        false,
        true,
        "ASSIGNEE",
        null,
        null,
        null,
        null,
        null,
      ]),
      requireSortKey: true,
    });
    expect(setup.listPage.mock.calls[0]?.[1]).toMatchObject({
      projectIds: [7, 9],
      assigneeId: 5,
      todayTodo: true,
    });
  });
  it("ownership=CREATOR 只在当前用户身份内改走 creatorId，并绑定游标签名", async () => {
    const setup = myTasksSetup({ scopeProjectIds: [7, 9] });
    await setup.service.list({
      actorUserId: 5,
      projectId: 9,
      ownership: "CREATOR",
    });
    expect(setup.cursor.decodeKey).toHaveBeenCalledWith(undefined, {
      actorUserId: 5,
      namespace: "MY_TASKS",
      filterKey: JSON.stringify(["CREATOR", 9, null, null, null, null]),
      requireSortKey: true,
    });
    const pageInput = setup.listPage.mock.calls[0]?.[1];
    expect(pageInput).toMatchObject({ projectIds: [9], creatorId: 5 });
    expect(pageInput).not.toHaveProperty("assigneeId");
    // 统计与遗留问题样本口径只描述「我负责的」，不随 ownership 变化。
    expect(setup.stats).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [9],
      assigneeId: 5,
      excludedTaskIds: [90],
    });
  });

  it("includeCanceled 在 workStatus 缺省时不产生额外过滤", async () => {
    const setup = myTasksSetup();
    await setup.service.list({ actorUserId: 5, includeCanceled: true });
    expect(setup.listPage.mock.calls[0]?.[1]).not.toHaveProperty(
      "workStatuses",
    );
  });

  it("条目映射 groupRole 与 hasPublishedRecord 并签发下一页游标", async () => {
    const setup = myTasksSetup({
      page: {
        items: [taskRowFixture(502), taskRowFixture(501)],
        next: {
          statusGroup: 0,
          completedAt: null,
          urgency: 3,
          priority: 2,
          leftover: 1,
          dueAt: null,
          taskId: 501,
        },
        hasMore: true,
      },
      publishedRecordCounts: [{ taskId: 501, count: 2 }],
      groupRoles: [{ taskId: 501, groupId: 11, role: "MAIN" }],
      leftoverSourceTaskIds: [502],
    });

    const result = await setup.service.list({ actorUserId: 5 });

    expect(result.items[0]).toMatchObject({
      taskId: 502,
      projectName: "商城系统",
      moduleName: "模块",
      priority: "NORMAL",
      dueAt: null,
      completedAt: null,
      creatorId: 5,
      githubLinkCount: 0,
      hasPublishedRecord: false,
      groupRole: null,
      groupId: null,
      hasLeftoverSource: true,
      updatedAt: baseTime.toISOString(),
    });
    expect(result.items[1]).toMatchObject({
      taskId: 501,
      hasPublishedRecord: true,
      githubLinkCount: 3,
      groupRole: "MAIN",
      groupId: 11,
      hasLeftoverSource: false,
    });
    expect(setup.countPublishedByTask).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [502, 501],
    );
    expect(setup.listLeftoverSourceTaskIds).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [502, 501],
    );
    expect(result.stats).toEqual({
      todayTodo: 3,
      todayTodoBreakdown: {
        overdue: 2,
        leftover: 1,
        urgent: 1,
        dueWithinDays: 1,
      },
      myOpen: 4,
      completed: 3,
      created: 6,
    });
    expect(result.leftoverCount).toBe(2);
    expect(result.leftoverSample).toEqual({
      recordCode: "SHOP-CR-41",
      summary: "最新遗留内容",
    });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("cursor-next");
    expect(setup.cursor.encode).toHaveBeenCalledWith({
      actorUserId: 5,
      namespace: "MY_TASKS",
      filterKey: JSON.stringify(["ASSIGNEE", null, null, null, null, null]),
      afterId: 501,
      sortKey: "7|0||3|2|1||501",
    });
  });

  it("非法游标映射为 422 INVALID_CURSOR", async () => {
    const setup = myTasksSetup({
      decode: () => {
        throw new AggregateReadCursorError("expired", "gone");
      },
    });
    await expect(setup.service.list({ actorUserId: 5 })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_CURSOR",
    });
  });

  it("截止与完成时间按 ISO 返回，统计与遗留样例按基准集合透传并截断", async () => {
    const dueAt = new Date("2026-09-10T04:00:00.000Z");
    const completedAt = new Date("2026-09-08T04:00:00.000Z");
    const setup = myTasksSetup({
      page: {
        items: [
          taskRowFixture(501, {
            workStatus: "DONE",
            dueAt,
            completedAt,
          }),
        ],
        next: null,
        hasMore: false,
      },
      stats: {
        todayTodo: 3,
        todayTodoBreakdown: {
          overdue: 2,
          leftover: 1,
          urgent: 1,
          dueWithinDays: 1,
        },
        myOpen: 0,
        completed: 1,
        created: 2,
      },
      leftover: {
        count: 1,
        sample: {
          recordCode: "SHOP-CR-41",
          contentPrefix: "遗留内容".repeat(50),
          truncated: true,
        },
      },
    });
    const result = await setup.service.list({ actorUserId: 5 });
    expect(result.items[0]).toMatchObject({
      workStatus: "DONE",
      dueAt: dueAt.toISOString(),
      completedAt: completedAt.toISOString(),
    });
    expect(result.stats).toEqual({
      todayTodo: 3,
      todayTodoBreakdown: {
        overdue: 2,
        leftover: 1,
        urgent: 1,
        dueWithinDays: 1,
      },
      myOpen: 0,
      completed: 1,
      created: 2,
    });
    expect(result.leftoverCount).toBe(1);
    expect(result.leftoverSample).toEqual({
      recordCode: "SHOP-CR-41",
      summary: "遗留内容".repeat(50) + "…",
    });
    expect(setup.stats).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [7],
      assigneeId: 5,
      excludedTaskIds: [90],
    });
    expect(setup.leftoverEntry).toHaveBeenCalledWith(expect.anything(), {
      projectIds: [7],
      assigneeId: 5,
      excludedTaskIds: [90],
    });
    expect(setup.countTaskLinks).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [501],
    );
  });

  it("条目返回全部负责人，标量 assignee 取集合首位（ADR-040）", async () => {
    const setup = myTasksSetup({
      users: [
        { userId: 5, name: "成员", avatarUrl: null },
        { userId: 6, name: "协作者", avatarUrl: null },
      ],
      page: {
        items: [taskRowFixture(501, { assigneeId: 5, assigneeIds: [5, 6] })],
        next: null,
        hasMore: false,
      },
    });
    const result = await setup.service.list({ actorUserId: 5 });
    expect(result.items[0]?.assignees).toEqual([
      { userId: 5, name: "成员", avatarUrl: null },
      { userId: 6, name: "协作者", avatarUrl: null },
    ]);
    expect(result.items[0]?.assignee).toEqual({
      userId: 5,
      name: "成员",
      avatarUrl: null,
    });
  });

  it("条目缺少项目或模块时以 500 失败而不是静默丢行", async () => {
    const setup = myTasksSetup({
      page: {
        items: [taskRowFixture(501)],
        next: null,
        hasMore: false,
      },
      projects: [],
    });
    await expect(setup.service.list({ actorUserId: 5 })).rejects.toMatchObject({
      status: 500,
      code: "AGGREGATE_READ_INCONSISTENT",
    });
  });
});

describe("TaskGroupMembershipQueryService.list", () => {
  function membershipSetup(
    options: {
      readonly scopeProjectIds?: readonly number[];
      readonly authorizedTaskIds?: readonly number[];
      readonly roles?: readonly {
        readonly taskId: number;
        readonly groupId: number;
        readonly role: "MAIN" | "SOURCE";
      }[];
      readonly counts?: readonly {
        readonly taskId: number;
        readonly count: number;
      }[];
      readonly leftoverSourceTaskIds?: readonly number[];
    } = {},
  ) {
    const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
      actorUserId: 5,
      projectIds: options.scopeProjectIds ?? [7],
      isSystemAdmin: false,
    });
    const listByIds = vi
      .fn()
      .mockResolvedValue(
        (options.authorizedTaskIds ?? []).map((taskId) => ({ taskId })),
      );
    const listGroupRoles = vi.fn().mockResolvedValue(options.roles ?? []);
    const countPublishedByTask = vi
      .fn()
      .mockResolvedValue(options.counts ?? []);
    const listLeftoverSourceTaskIds = vi
      .fn()
      .mockResolvedValue(options.leftoverSourceTaskIds ?? []);
    const service = new TaskGroupMembershipQueryService(
      { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
      { listByIds } as unknown as TaskQueryPort,
      { listGroupRoles } as unknown as TaskGroupMembershipReadPort,
      {
        countPublishedByTask,
        listLeftoverSourceTaskIds,
      } as unknown as ChangeRecordReadPort,
      unitOfWork,
    );
    return {
      service,
      getAuthorizedSearchScope,
      listByIds,
      listGroupRoles,
      countPublishedByTask,
      listLeftoverSourceTaskIds,
    };
  }

  it("覆盖每个有权 taskId：未入组返回 null，计数与遗留来源标记按映射补齐", async () => {
    const setup = membershipSetup({
      authorizedTaskIds: [21, 22, 23],
      roles: [
        { taskId: 22, groupId: 12, role: "SOURCE" },
        { taskId: 21, groupId: 11, role: "MAIN" },
      ],
      counts: [
        { taskId: 21, count: 2 },
        { taskId: 22, count: 1 },
      ],
      leftoverSourceTaskIds: [22],
    });
    const result = await setup.service.list({
      actorUserId: 5,
      taskIds: [23, 22, 21],
    });
    expect(result).toEqual({
      items: [
        {
          taskId: 21,
          groupId: 11,
          groupRole: "MAIN",
          publishedRecordCount: 2,
          hasLeftoverSource: false,
        },
        {
          taskId: 22,
          groupId: 12,
          groupRole: "SOURCE",
          publishedRecordCount: 1,
          hasLeftoverSource: true,
        },
        {
          taskId: 23,
          groupId: null,
          groupRole: null,
          publishedRecordCount: 0,
          hasLeftoverSource: false,
        },
      ],
    });
    expect(setup.listGroupRoles).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [21, 22, 23],
    );
    expect(setup.countPublishedByTask).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [21, 22, 23],
    );
    expect(setup.listLeftoverSourceTaskIds).toHaveBeenCalledWith(
      expect.anything(),
      [7],
      [21, 22, 23],
    );
  });

  it("无权或不存在任务不出现", async () => {
    const setup = membershipSetup({ authorizedTaskIds: [21] });
    const result = await setup.service.list({
      actorUserId: 5,
      taskIds: [21, 999],
    });
    expect(result).toEqual({
      items: [
        {
          taskId: 21,
          groupId: null,
          groupRole: null,
          publishedRecordCount: 0,
          hasLeftoverSource: false,
        },
      ],
    });
  });

  it("无授权项目时返回空结果且不发出后续 SQL", async () => {
    const setup = membershipSetup({ scopeProjectIds: [] });
    const result = await setup.service.list({
      actorUserId: 5,
      taskIds: [999],
    });
    expect(result).toEqual({ items: [] });
    expect(setup.listByIds).toHaveBeenCalledWith(expect.anything(), [], [999]);
    expect(setup.listGroupRoles).not.toHaveBeenCalled();
    expect(setup.countPublishedByTask).not.toHaveBeenCalled();
    expect(setup.listLeftoverSourceTaskIds).not.toHaveBeenCalled();
  });
});
