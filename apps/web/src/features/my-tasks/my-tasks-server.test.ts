import { describe, expect, it, vi } from "vitest";
import type { InpulseApiClient, MyTaskPage } from "@generated/api";
import { DEFAULT_MY_TASK_FILTERS } from "./my-tasks-url";
import {
  createMyTasksServerAdapter,
  MY_TASKS_SERVER_NOTICE,
} from "./my-tasks-server";
import { MY_TASKS_V1_FILTER_SUPPORT } from "./my-tasks-v1-query";

const page: MyTaskPage = {
  items: [
    {
      taskId: 41,
      code: "T-1041",
      title: "补齐聚合读游标过期用例",
      projectId: 7,
      projectName: "InPulse 平台",
      moduleId: 3,
      moduleName: "聚合读",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      assignee: { userId: 2, name: "开发者 C", avatarUrl: null },
      assignees: [{ userId: 2, name: "开发者 C", avatarUrl: null }],
      updatedAt: "2026-09-10T09:00:00.000Z",
      hasPublishedRecord: true,
      publishedRecordCount: 1,
      groupRole: "MAIN",
      priority: "NORMAL",
      dueAt: null,
      completedAt: null,
      creatorId: 2,
      githubLinkCount: 0,
      groupId: null,
      hasLeftoverSource: true,
    },
  ],
  nextCursor: "signed-cursor",
  hasMore: true,
  stats: {
    todayTodo: 1,
    todayTodoBreakdown: {
      overdue: 0,
      leftover: 1,
      urgent: 0,
      dueWithinDays: 1,
    },
    myOpen: 1,
    completed: 0,
    created: 2,
  },
  leftoverCount: 1,
  leftoverSample: { recordCode: "R-021", summary: "恢复码入口待补齐" },
};

describe("my tasks server adapter", () => {
  it("calls the generated client with the frozen R-3 query", async () => {
    const listTaskCenter = vi.fn().mockResolvedValue(page);
    const client = { listTaskCenter } as unknown as InpulseApiClient;
    const adapter = createMyTasksServerAdapter(client);

    expect(adapter.source).toBe("server");
    expect(adapter.notice).toBe(MY_TASKS_SERVER_NOTICE);

    const result = await adapter.fetchMyTasks({
      filters: DEFAULT_MY_TASK_FILTERS,
      viewerId: 2,
    });

    // 默认筛选是「我负责的全部未完成」：工具栏只有工作状态两档，不再下发 todayTodo。
    expect(listTaskCenter).toHaveBeenCalledWith({
      scope: "mine",
      limit: 20,
      workStatus: "TODO",
    });
    expect(result.items).toEqual([
      {
        taskId: 41,
        code: "T-1041",
        title: "补齐聚合读游标过期用例",
        projectId: 7,
        projectName: "InPulse 平台",
        moduleId: 3,
        moduleName: "聚合读",
        workStatus: "TODO",
        lifecycleStatus: "ACTIVE",
        updatedAt: "2026-09-10T09:00:00.000Z",
        assignee: { userId: 2, name: "开发者 C", avatarUrl: null },
        assignees: [{ userId: 2, name: "开发者 C", avatarUrl: null }],
        priority: "NORMAL",
        dueAt: null,
        completedAt: null,
        creatorId: 2,
        githubLinkCount: 0,
        hasPublishedRecord: true,
        publishedRecordCount: 1,
        groupRole: "MAIN",
        groupId: null,
        hasLeftoverSource: true,
      },
    ]);
    expect(result.nextCursor).toBe("signed-cursor");
    expect(result.hasMore).toBe(true);
  });

  it("passes priority and the canceled union to the generated client", async () => {
    const listTaskCenter = vi.fn().mockResolvedValue(page);
    const client = { listTaskCenter } as unknown as InpulseApiClient;
    const adapter = createMyTasksServerAdapter(client);

    await adapter.fetchMyTasks({
      filters: {
        ...DEFAULT_MY_TASK_FILTERS,
        status: "open",
        includeCanceled: true,
        priority: "HIGH",
      },
      viewerId: 2,
    });

    expect(listTaskCenter).toHaveBeenCalledWith({
      scope: "mine",
      limit: 20,
      workStatus: "TODO",
      priority: "HIGH",
      includeCanceled: true,
    });
  });

  it("passes ownership for the created scope and keeps stats mine-scoped", async () => {
    const listTaskCenter = vi.fn().mockResolvedValue(page);
    const client = { listTaskCenter } as unknown as InpulseApiClient;
    const adapter = createMyTasksServerAdapter(client);

    const result = await adapter.fetchMyTasks({
      filters: {
        ...DEFAULT_MY_TASK_FILTERS,
        scope: "created",
        status: "all",
      },
      viewerId: 2,
    });

    expect(listTaskCenter).toHaveBeenCalledWith({
      limit: 20,
      ownership: "CREATOR",
      scope: "created",
    });
    expect(result.items).toHaveLength(1);
  });

  it("wires stats and leftovers from the page while scopeCounts stays deferred", async () => {
    const listTaskCenter = vi.fn().mockResolvedValue(page);
    const client = { listTaskCenter } as unknown as InpulseApiClient;
    const adapter = createMyTasksServerAdapter(client);

    const result = await adapter.fetchMyTasks({
      filters: DEFAULT_MY_TASK_FILTERS,
      viewerId: 2,
    });

    expect(result.stats).toEqual(page.stats);
    expect(result.scopeCounts).toBeNull();
    expect(result.leftoverCount).toBe(1);
    expect(result.leftoverSample).toEqual({
      recordCode: "R-021",
      summary: "恢复码入口待补齐",
    });
    expect(result.filterSupport).toEqual({
      ...MY_TASKS_V1_FILTER_SUPPORT,
      "scope:all": true,
    });
    expect(result.filterSupport["filter:priority"]).toBe(true);
    expect(result.filterSupport["filter:canceled-with-open"]).toBe(true);
    expect(result.filterSupport["filter:query"]).toBe(false);
  });

  it("maps the R-7 task group page through the generated client", async () => {
    const listTaskGroups = vi.fn().mockResolvedValue({
      items: [
        {
          groupId: 501,
          projectId: 1,
          projectName: "InPulse 平台",
          code: "TG-001",
          name: "任务合并后来源分支历史保留",
          status: "ACTIVE",
          mainTask: {
            taskId: 102,
            code: "T-102",
            projectId: 1,
            moduleId: 12,
          },
          branches: [],
        },
      ],
      nextCursor: "group-cursor",
      hasMore: true,
    });
    const client = { listTaskGroups } as unknown as InpulseApiClient;
    const adapter = createMyTasksServerAdapter(client);

    const scoped = await adapter.fetchTaskGroups({
      projectId: 1,
      cursor: null,
    });
    expect(listTaskGroups).toHaveBeenCalledWith({
      limit: 20,
      projectId: 1,
    });
    expect(scoped.items).toHaveLength(1);
    expect(scoped.items[0]?.code).toBe("TG-001");
    expect(scoped.nextCursor).toBe("group-cursor");
    expect(scoped.hasMore).toBe(true);

    await adapter.fetchTaskGroups({ projectId: null, cursor: "group-cursor" });
    expect(listTaskGroups).toHaveBeenLastCalledWith({
      limit: 20,
      cursor: "group-cursor",
    });
  });

  it("keeps the notice explicit about the wired data and the remaining gaps", () => {
    expect(MY_TASKS_SERVER_NOTICE).toContain("工作状态");
    expect(MY_TASKS_SERVER_NOTICE).toContain("项目筛选");
    expect(MY_TASKS_SERVER_NOTICE).toContain("我创建的");
  });
});

it("preserves the selected project for a personal overdue drilldown", async () => {
  const listTaskCenter = vi.fn().mockResolvedValue({
    items: [],
    nextCursor: null,
    hasMore: false,
    stats: null,
    leftoverCount: 0,
    leftoverSample: null,
  });
  const adapter = createMyTasksServerAdapter({
    listTaskCenter,
  } as unknown as InpulseApiClient);
  await adapter.fetchMyTasks({
    filters: {
      ...DEFAULT_MY_TASK_FILTERS,
      scope: "mine",
      projectId: 1,
      overdue: true,
    },
    viewerId: 1,
  });
  expect(listTaskCenter).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 1, scope: "mine", overdue: true }),
  );
});
