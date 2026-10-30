import { describe, expect, it } from "vitest";
import { MY_TASKS_MOCK_ADAPTER } from "./my-tasks-mock";
import { DEFAULT_MY_TASK_FILTERS } from "./my-tasks-url";
import {
  MY_TASKS_FULL_FILTER_SUPPORT,
  type MyTaskFilters,
  type MyTaskListItem,
} from "./my-tasks-types";

const fetchDefault = async (patch: Partial<MyTaskFilters> = {}) =>
  MY_TASKS_MOCK_ADAPTER.fetchMyTasks({
    filters: { ...DEFAULT_MY_TASK_FILTERS, ...patch },
    viewerId: 1,
  });

const codesOf = (items: readonly MyTaskListItem[]) =>
  items.map((item) => item.code);

describe("my-tasks mock adapter", () => {
  it("serves the demo dataset as a mock source", async () => {
    expect(MY_TASKS_MOCK_ADAPTER.source).toBe("mock");
    const result = await fetchDefault();
    expect(result.filterSupport).toEqual(MY_TASKS_FULL_FILTER_SUPPORT);
    expect(result.items.every((item) => item.workStatus === "TODO")).toBe(true);
    // 默认筛选是「我负责的全部未完成」：T-108（20 天后到期、非紧急、无遗留）也在缺省视图里，
    // 只有显式 todayTodo 才收窄到今日待办。
    expect(codesOf(result.items)).toEqual(["T-101", "T-102", "T-103", "T-108"]);
    expect(result.items.find((item) => item.code === "T-102")?.groupId).toBe(
      501,
    );
  });

  it("keeps done and canceled tasks out of the default view", async () => {
    const result = await fetchDefault();
    expect(codesOf(result.items)).not.toContain("T-104");
    expect(codesOf(result.items)).not.toContain("T-107");
  });

  it("only shows canceled tasks when the toggle and status all match", async () => {
    const withToggleOnly = await fetchDefault({ includeCanceled: true });
    expect(codesOf(withToggleOnly.items)).not.toContain("T-107");

    const statusAllOnly = await fetchDefault({ status: "all" });
    expect(codesOf(statusAllOnly.items)).not.toContain("T-107");

    const both = await fetchDefault({ status: "all", includeCanceled: true });
    const all = codesOf(both.items);
    expect(all).toContain("T-107");
    expect(all).toContain("T-104");
    expect(all.indexOf("T-107")).toBe(all.length - 1);
  });

  it("filters the created scope by creator instead of assignee", async () => {
    const result = await fetchDefault({ scope: "created" });
    expect(codesOf(result.items)).toEqual([
      "T-101",
      "T-102",
      "T-105",
      "T-103",
      "T-108",
    ]);
  });

  it("filters the project scope by project id", async () => {
    const result = await fetchDefault({ scope: "project", projectId: 2 });
    expect(codesOf(result.items)).toEqual(["T-105", "T-103"]);
  });

  it("orders the admin scope across all projects", async () => {
    const result = await fetchDefault({ scope: "all" });
    expect(codesOf(result.items)).toEqual([
      "T-101",
      "T-102",
      "T-105",
      "T-103",
      "T-110",
      "T-108",
    ]);
  });

  it("supports priority, relation, record and github filters", async () => {
    expect(codesOf((await fetchDefault({ priority: "URGENT" })).items)).toEqual(
      ["T-101"],
    );
    expect(codesOf((await fetchDefault({ relation: "MAIN" })).items)).toEqual([
      "T-102",
    ]);
    expect(codesOf((await fetchDefault({ hasRecord: "yes" })).items)).toEqual([
      "T-102",
    ]);
    expect(codesOf((await fetchDefault({ hasGithub: "yes" })).items)).toEqual([
      "T-101",
    ]);
  });

  it("matches the search term across code, title and belonging", async () => {
    expect(codesOf((await fetchDefault({ query: "恢复码" })).items)).toEqual([
      "T-101",
    ]);
    expect(
      codesOf((await fetchDefault({ query: "标题不存在的词" })).items),
    ).toEqual([]);
    // T-108（20 天后到期）在缺省「全部未完成」视图里；显式收窄到今日待办后不再命中。
    expect(codesOf((await fetchDefault({ query: "t-108" })).items)).toEqual([
      "T-108",
    ]);
    expect(
      codesOf((await fetchDefault({ query: "t-108", todayTodo: true })).items),
    ).toEqual([]);
  });

  it("computes date-independent stats and leftover facts for the scope", async () => {
    const result = await fetchDefault();
    const stats = result.stats;
    if (!stats) {
      throw new Error("mock adapter must return stats");
    }
    expect(stats.myOpen).toBe(4);
    // 今日待办（T-101 逾期+遗留+紧急、T-102 今天到期、T-103 5 天后到期）。
    expect(stats.todayTodo).toBe(3);
    expect(stats.todayTodoBreakdown).toEqual({
      overdue: 1,
      leftover: 1,
      urgent: 1,
      dueWithinDays: 2,
    });
    expect(stats.completed).toBe(3);
    // 我创建的按创建人维度统计，与当前 scope（负责）无关。
    expect(stats.created).toBe(8);
    expect(result.leftoverCount).toBe(3);
    expect(result.leftoverSample?.recordCode).toBe("R-021");
    expect(result.scopeCounts).toEqual({
      mine: 8,
      created: 9,
      project: 10,
      all: 10,
    });
  });

  it("serves the demo task group with main and source branches", async () => {
    const result = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    const [group] = result.items;
    if (group === undefined) {
      throw new Error("mock adapter must return one demo group");
    }
    expect(group.code).toBe("TG-001");
    expect(group.status).toBe("ACTIVE");
    expect(group.projectName).toBe("InPulse 平台");
    expect(group.mainTask?.taskId).toBe(102);
    expect(
      group.branches.map((branch) => [
        branch.taskCode,
        branch.role,
        branch.sourceKind,
        branch.workStatus,
        branch.priority,
      ]),
    ).toEqual([
      ["T-102", "MAIN", null, "TODO", "HIGH"],
      ["T-101", "SOURCE", "ACTIVE", "TODO", "URGENT"],
      ["T-104", "SOURCE", "HISTORICAL", "DONE", "NORMAL"],
      ["T-107", "SOURCE", "HISTORICAL", "CANCELED", "NORMAL"],
    ]);

    const otherProject = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: 2,
      cursor: null,
    });
    expect(otherProject.items).toEqual([]);
  });

  it("keeps the demo viewer until the server contract is frozen", async () => {
    const result = await MY_TASKS_MOCK_ADAPTER.fetchMyTasks({
      filters: DEFAULT_MY_TASK_FILTERS,
      viewerId: 999,
    });
    expect(codesOf(result.items)).toContain("T-101");
  });
});
