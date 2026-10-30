import { describe, expect, it } from "vitest";
import { DEFAULT_MY_TASK_FILTERS } from "./my-tasks-url";
import type { MyTaskFilters } from "./my-tasks-types";
import {
  clampMyTasksV1Limit,
  fromV1MyTaskItem,
  listMyTasksV1Gaps,
  MY_TASKS_V1_FILTER_SUPPORT,
  MY_TASKS_V1_LIMIT_DEFAULT,
  MY_TASKS_V1_LIMIT_MAX,
  MY_TASKS_V1_LOCAL_FILTER_SUPPORT,
  MY_TASKS_V1_MISSING_ITEM_FIELDS,
  MY_TASKS_V1_MISSING_RESPONSE_PARTS,
  MY_TASKS_V1_PATH,
  matchesMyTasksLocalFilters,
  toMyTasksV1Query,
  toMyTasksV1Ownership,
  toMyTasksV1WorkStatus,
} from "./my-tasks-v1-query";

function filters(overrides: Partial<MyTaskFilters> = {}): MyTaskFilters {
  return { ...DEFAULT_MY_TASK_FILTERS, ...overrides };
}

describe("my-tasks-v1-query", () => {
  it("keeps the frozen R-3 path and defaults", () => {
    expect(MY_TASKS_V1_PATH).toBe("/api/v1/me/tasks");
    // 默认筛选是「我负责的全部未完成」：工具栏只有工作状态两档，不再下发 todayTodo。
    expect(toMyTasksV1Query(filters())).toEqual({
      limit: 20,
      workStatus: "TODO",
    });
    expect(MY_TASKS_V1_LIMIT_DEFAULT).toBe(20);
    expect(MY_TASKS_V1_LIMIT_MAX).toBe(100);
  });

  it("maps the project scope onto projectId", () => {
    expect(
      toMyTasksV1Query(
        filters({
          scope: "project",
          projectId: 7,
          status: "all",
        }),
      ),
    ).toEqual({ limit: 20, projectId: 7 });
    expect(
      toMyTasksV1Query(filters({ scope: "project", projectId: null }))
        .projectId,
    ).toBeUndefined();
    // 项目筛选不再是 project 范围专属：个人范围 + 所选项目同样下发 projectId。
    expect(
      toMyTasksV1Query(filters({ scope: "mine", projectId: 7, status: "all" })),
    ).toEqual({ limit: 20, projectId: 7 });
    expect(
      toMyTasksV1Query(filters({ scope: "created", projectId: 7 })),
    ).toEqual({
      limit: 20,
      ownership: "CREATOR",
      projectId: 7,
      workStatus: "TODO",
    });
  });

  it("maps workStatus for open and done only", () => {
    expect(toMyTasksV1WorkStatus(filters({ status: "open" }))).toBe("TODO");
    expect(toMyTasksV1WorkStatus(filters({ status: "done" }))).toBe("DONE");
    expect(toMyTasksV1WorkStatus(filters({ status: "all" }))).toBeNull();
    expect(toMyTasksV1Query(filters({ status: "all" }))).toEqual({ limit: 20 });
    expect(toMyTasksV1Query(filters({ status: "done" })).workStatus).toBe(
      "DONE",
    );
    // 只有显式 todayTodo（URL ?today=1 的链路）才下发，缺省不下发。
    expect(toMyTasksV1Query(filters({ todayTodo: true })).todayTodo).toBe(true);
    expect(toMyTasksV1Query(filters()).todayTodo).toBeUndefined();
  });

  it("maps the record filter onto hasPublishedRecord", () => {
    expect(
      toMyTasksV1Query(filters({ hasRecord: "yes" })).hasPublishedRecord,
    ).toBe(true);
    expect(
      toMyTasksV1Query(filters({ hasRecord: "no" })).hasPublishedRecord,
    ).toBe(false);
    expect(toMyTasksV1Query(filters()).hasPublishedRecord).toBeUndefined();
  });

  it("maps the priority filter and the canceled union", () => {
    expect(toMyTasksV1Query(filters({ priority: "HIGH" })).priority).toBe(
      "HIGH",
    );
    expect(toMyTasksV1Query(filters()).priority).toBeUndefined();
    expect(
      toMyTasksV1Query(filters({ status: "open", includeCanceled: true }))
        .includeCanceled,
    ).toBe(true);
    expect(
      toMyTasksV1Query(filters({ status: "all", includeCanceled: true }))
        .includeCanceled,
    ).toBeUndefined();
    expect(toMyTasksV1Query(filters({ status: "open" })).includeCanceled).toBe(
      undefined,
    );
  });

  it("omits empty cursors and clamps out-of-range limits", () => {
    const allStatus = filters({ status: "all" });
    expect(toMyTasksV1Query(allStatus, { cursor: "" })).toEqual({ limit: 20 });
    expect(toMyTasksV1Query(allStatus, { cursor: null })).toEqual({
      limit: 20,
    });
    expect(toMyTasksV1Query(allStatus, { cursor: "abc" }).cursor).toBe("abc");
    expect(toMyTasksV1Query(filters(), { limit: 500 }).limit).toBe(100);
    expect(toMyTasksV1Query(filters(), { limit: 0 }).limit).toBe(20);
    expect(toMyTasksV1Query(filters(), { limit: 2.5 }).limit).toBe(20);
    expect(clampMyTasksV1Limit(1)).toBe(1);
  });

  it("reports every UI filter V1 cannot express", () => {
    expect(
      listMyTasksV1Gaps(
        filters({
          scope: "all",
          relation: "MAIN",
          hasGithub: "no",
          query: "登录",
        }),
      ),
    ).toEqual([
      "scope:all",
      "filter:relation",
      "filter:github",
      "filter:query",
    ]);
  });

  it("maps the created scope onto the ownership parameter and drops the gap", () => {
    expect(toMyTasksV1Ownership(filters({ scope: "created" }))).toBe("CREATOR");
    expect(toMyTasksV1Ownership(filters({ scope: "mine" }))).toBeNull();
    expect(toMyTasksV1Ownership(filters({ scope: "all" }))).toBeNull();
    expect(
      toMyTasksV1Query(filters({ scope: "created", status: "all" })),
    ).toEqual({ limit: 20, ownership: "CREATOR" });
    expect(toMyTasksV1Query(filters({ scope: "mine", status: "all" }))).toEqual(
      { limit: 20 },
    );
    expect(listMyTasksV1Gaps(filters({ scope: "created" }))).toEqual([]);
    expect(MY_TASKS_V1_FILTER_SUPPORT["scope:created"]).toBe(true);
  });

  it("no longer reports priority or the canceled union as gaps", () => {
    expect(
      listMyTasksV1Gaps(filters({ priority: "HIGH", includeCanceled: true })),
    ).toEqual([]);
    expect(
      listMyTasksV1Gaps(
        filters({ status: "all", priority: "NORMAL", includeCanceled: true }),
      ),
    ).toEqual([]);
  });

  it("returns no gaps for the six V1-expressible filters", () => {
    expect(
      listMyTasksV1Gaps(
        filters({
          scope: "project",
          projectId: 3,
          status: "open",
          hasRecord: "yes",
          priority: "URGENT",
          includeCanceled: true,
        }),
      ),
    ).toEqual([]);
  });

  it("no longer reports the project scope without a project id", () => {
    expect(
      listMyTasksV1Gaps(filters({ scope: "project", projectId: null })),
    ).toEqual([]);
  });

  it("only hard-gates the gaps the view cannot compute locally", () => {
    expect(MY_TASKS_V1_LOCAL_FILTER_SUPPORT["scope:created"]).toBe(false);
    expect(MY_TASKS_V1_LOCAL_FILTER_SUPPORT["scope:all"]).toBe(false);
    expect(MY_TASKS_V1_LOCAL_FILTER_SUPPORT["filter:relation"]).toBe(true);
    expect(MY_TASKS_V1_LOCAL_FILTER_SUPPORT["filter:github"]).toBe(true);
    expect(MY_TASKS_V1_LOCAL_FILTER_SUPPORT["filter:query"]).toBe(true);
  });

  it("narrows loaded pages by relation, github and keyword", () => {
    const item = fromV1MyTaskItem({
      taskId: 7,
      code: "T-007",
      title: "补齐恢复码入口",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 2,
      moduleName: "访问控制",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      assignee: { userId: 9, name: "张三", avatarUrl: null },
      assignees: [{ userId: 9, name: "张三", avatarUrl: null }],
      updatedAt: "2026-09-10T02:00:00.000Z",
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      priority: "NORMAL",
      dueAt: null,
      completedAt: null,
      creatorId: 9,
      githubLinkCount: 2,
      groupId: null,
      hasLeftoverSource: false,
    });
    const matches = (overrides: Partial<MyTaskFilters>): boolean =>
      matchesMyTasksLocalFilters(
        item,
        filters(overrides),
        MY_TASKS_V1_FILTER_SUPPORT,
      );
    expect(matches({ relation: "STANDALONE" })).toBe(true);
    expect(matches({ relation: "MAIN" })).toBe(false);
    expect(matches({ hasGithub: "yes" })).toBe(true);
    expect(matches({ hasGithub: "no" })).toBe(false);
    expect(matches({ query: "恢复码" })).toBe(true);
    expect(matches({ query: "访问控制" })).toBe(true);
    expect(matches({ query: "张三" })).toBe(true);
    expect(matches({ query: "不存在的词" })).toBe(false);
    expect(matches({ relation: "STANDALONE", query: "恢复码" })).toBe(true);
  });

  it("maps the frozen R-3 item and keeps contract gaps undefined", () => {
    const item = fromV1MyTaskItem({
      taskId: 7,
      code: "T-007",
      title: "补齐恢复码入口",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 2,
      moduleName: "访问控制",
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      assignee: { userId: 9, name: "张三", avatarUrl: null },
      assignees: [{ userId: 9, name: "张三", avatarUrl: null }],
      updatedAt: "2026-09-10T02:00:00.000Z",
      hasPublishedRecord: true,
      publishedRecordCount: 1,
      groupRole: "SOURCE",
      priority: "NORMAL",
      dueAt: null,
      completedAt: null,
      creatorId: 9,
      githubLinkCount: 0,
      groupId: null,
      hasLeftoverSource: true,
    });
    expect(item).toEqual({
      taskId: 7,
      code: "T-007",
      title: "补齐恢复码入口",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 2,
      moduleName: "访问控制",
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      assignee: { userId: 9, name: "张三", avatarUrl: null },
      assignees: [{ userId: 9, name: "张三", avatarUrl: null }],
      updatedAt: "2026-09-10T02:00:00.000Z",
      priority: "NORMAL",
      dueAt: null,
      completedAt: null,
      creatorId: 9,
      githubLinkCount: 0,
      hasPublishedRecord: true,
      publishedRecordCount: 1,
      groupRole: "SOURCE",
      groupId: null,
      hasLeftoverSource: true,
    });
    expect(item.description).toBeUndefined();
  });

  it("declares priority, the canceled union and the created scope as supported, the rest as gaps", () => {
    expect(MY_TASKS_V1_FILTER_SUPPORT).toEqual({
      "scope:created": true,
      "scope:all": false,
      "scope:project-without-id": true,
      "filter:priority": true,
      "filter:relation": false,
      "filter:github": false,
      "filter:query": false,
      "filter:canceled-with-open": true,
    });
  });

  it("keeps only description and scopeCounts as documented gaps", () => {
    expect(MY_TASKS_V1_MISSING_ITEM_FIELDS).toEqual(["description"]);
    expect(MY_TASKS_V1_MISSING_RESPONSE_PARTS).toEqual(["scopeCounts"]);
  });
});
