import { describe, expect, it } from "vitest";
import type { SearchItem } from "@generated/api";
import { searchResultPath } from "./search-destination";

function item(overrides: Partial<SearchItem>): SearchItem {
  return {
    projectId: 7,
    entityType: "PROJECT",
    entityId: 1,
    moduleId: null,
    recordId: null,
    title: "标题",
    summary: "摘要",
    ...overrides,
  };
}

describe("searchResultPath", () => {
  it("maps each entity type to its own page", () => {
    expect(searchResultPath(item({ entityType: "PROJECT" }))).toBe(
      "/projects/7/modules",
    );
    expect(searchResultPath(item({ entityType: "MODULE", entityId: 11 }))).toBe(
      "/projects/7/modules/11/tasks",
    );
    // 任务回到所在模块的任务页，并带 ?taskId= 深链
    expect(
      searchResultPath(
        item({ entityType: "TASK", entityId: 13, moduleId: 11 }),
      ),
    ).toBe("/projects/7/modules/11/tasks?taskId=13");
    expect(
      searchResultPath(item({ entityType: "CHANGE_RECORD", entityId: 14 })),
    ).toBe("/records?view=published&projectId=7&publishedId=14");
    // 遗留问题本身没有档案页，落到所属记录
    expect(
      searchResultPath(
        item({ entityType: "LEFTOVER", entityId: 9, recordId: 14 }),
      ),
    ).toBe("/records?view=published&projectId=7&publishedId=14");
  });

  it("returns null when the server did not supply an openable page", () => {
    // 没有独立页面的类型
    expect(searchResultPath(item({ entityType: "EXTERNAL_LINK" }))).toBeNull();
    expect(searchResultPath(item({ entityType: "TASK_GROUP" }))).toBeNull();
    // 历史投影行可能缺少上级归属，宁可不可点也不拼出指向错误对象的链接
    expect(
      searchResultPath(item({ entityType: "TASK", entityId: 13 })),
    ).toBeNull();
    expect(
      searchResultPath(item({ entityType: "LEFTOVER", entityId: 9 })),
    ).toBeNull();
  });
});
