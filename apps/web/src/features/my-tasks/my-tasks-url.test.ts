import { describe, expect, it } from "vitest";
import {
  countActiveMyTaskFilters,
  DEFAULT_MY_TASK_FILTERS,
  readMyTaskAdvancedOpen,
  readMyTaskFilters,
  writeMyTaskFilters,
} from "./my-tasks-url";
import type { MyTaskFilters } from "./my-tasks-types";

describe("my-tasks-url", () => {
  it("reads default filters from an empty URL", () => {
    expect(readMyTaskFilters(new URLSearchParams())).toEqual(
      DEFAULT_MY_TASK_FILTERS,
    );
    expect(readMyTaskAdvancedOpen(new URLSearchParams())).toBe(false);
  });

  it("round-trips a fully specified filter set through the URL", () => {
    const filters: MyTaskFilters = {
      scope: "project",
      projectId: 7,
      status: "all",
      priority: "HIGH",
      relation: "MAIN",
      hasRecord: "no",
      hasGithub: "yes",
      includeCanceled: true,
      query: "登录",
      // 缺省口径即「全部未完成」（todayTodo=false）；只有显式 today=1 才收窄到今日待办。
      todayTodo: false,
      display: "list",
    };

    const params = writeMyTaskFilters(filters, { advancedOpen: true });
    expect(readMyTaskFilters(params, { isAdmin: true })).toEqual(filters);
    expect(readMyTaskAdvancedOpen(params)).toBe(true);
  });

  it("omits default values when writing the URL", () => {
    expect(writeMyTaskFilters(DEFAULT_MY_TASK_FILTERS).toString()).toBe("");
    expect(
      writeMyTaskFilters(DEFAULT_MY_TASK_FILTERS, {
        advancedOpen: false,
      }).toString(),
    ).toBe("");
  });

  it("narrows to the today todo view only when today=1 is present", () => {
    expect(readMyTaskFilters(new URLSearchParams()).todayTodo).toBe(false);
    expect(readMyTaskFilters(new URLSearchParams("today=1")).todayTodo).toBe(
      true,
    );
    // 只有显式收窄才写参数；缺省（全部未完成）不写，地址栏不出现 today=0 噪音。
    expect(
      writeMyTaskFilters({ ...DEFAULT_MY_TASK_FILTERS, todayTodo: true }).get(
        "today",
      ),
    ).toBe("1");
    expect(writeMyTaskFilters(DEFAULT_MY_TASK_FILTERS).get("today")).toBeNull();
  });

  it("writes and reads the project filter for every scope", () => {
    // 工具栏「项目」下拉是常驻条件：scope=mine / created 也会写入并读回 project。
    const params = writeMyTaskFilters({
      ...DEFAULT_MY_TASK_FILTERS,
      scope: "mine",
      projectId: 9,
    });
    expect(params.get("project")).toBe("9");
    expect(readMyTaskFilters(params).projectId).toBe(9);
    expect(
      writeMyTaskFilters({ ...DEFAULT_MY_TASK_FILTERS, projectId: null }).get(
        "project",
      ),
    ).toBeNull();
  });

  it("falls back to defaults for invalid values", () => {
    const params = new URLSearchParams(
      "scope=everything&project=0&status=nope&priority=MAYBE&relation=Y&record=maybe&github=maybe&canceled=1&view=grid",
    );
    expect(readMyTaskFilters(params)).toEqual({
      ...DEFAULT_MY_TASK_FILTERS,
      includeCanceled: true,
    });
  });

  it("rejects out-of-range project ids", () => {
    expect(
      readMyTaskFilters(new URLSearchParams("project=2147483648")).projectId,
    ).toBeNull();
    expect(
      readMyTaskFilters(new URLSearchParams("project=2147483647")).projectId,
    ).toBe(2147483647);
  });

  it("demotes the admin-only scope for non-admins", () => {
    const params = new URLSearchParams("scope=all");
    expect(readMyTaskFilters(params).scope).toBe("mine");
    expect(readMyTaskFilters(params, { isAdmin: true }).scope).toBe("all");
  });

  it("trims the query before persisting it", () => {
    expect(
      writeMyTaskFilters({ ...DEFAULT_MY_TASK_FILTERS, query: "  登录  " }).get(
        "q",
      ),
    ).toBe("登录");
    expect(
      writeMyTaskFilters({ ...DEFAULT_MY_TASK_FILTERS, query: "  " }).get("q"),
    ).toBeNull();
  });

  it("counts active filters without scope and display mode", () => {
    expect(countActiveMyTaskFilters(DEFAULT_MY_TASK_FILTERS)).toBe(0);
    expect(
      countActiveMyTaskFilters({
        ...DEFAULT_MY_TASK_FILTERS,
        scope: "project",
        display: "list",
        query: "  ",
      }),
    ).toBe(0);
    expect(
      countActiveMyTaskFilters({
        ...DEFAULT_MY_TASK_FILTERS,
        status: "done",
        priority: "URGENT",
        relation: "SOURCE",
        hasRecord: "yes",
        hasGithub: "no",
        includeCanceled: true,
        query: "登录",
      }),
    ).toBe(7);
  });
});

it("round-trips a project overdue drilldown without expanding its scope", () => {
  const filters = { ...DEFAULT_MY_TASK_FILTERS, projectId: 7, overdue: true };
  expect(readMyTaskFilters(writeMyTaskFilters(filters))).toEqual(filters);
});
