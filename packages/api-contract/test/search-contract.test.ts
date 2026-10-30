import { describe, expect, test } from "vitest";

import {
  SEARCH_CURSOR_MAX_LENGTH,
  SEARCH_PAGE_LIMIT_MAX,
  searchItemSchema,
  searchPageSchema,
  searchQueryRequestSchema,
} from "../src/contracts/search.zod.js";
import { routeRegistry } from "../src/route-registry.js";

const validItem = {
  projectId: 1,
  entityType: "TASK",
  entityId: 2,
  title: "实现搜索契约",
  summary: "契约纵切片",
  moduleId: null,
  recordId: null,
};

describe("SearchQueryRequest 契约", () => {
  test("接受必填 q 与可选 cursor/limit/includeVoid", () => {
    const parsed = searchQueryRequestSchema.safeParse({
      q: "ai",
      cursor: "1",
      limit: "25",
      includeVoid: "true",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      q: "ai",
      cursor: "1",
      limit: 25,
      includeVoid: true,
    });
  });

  test("缺省时只返回 q，保留服务端默认语义", () => {
    const parsed = searchQueryRequestSchema.parse({ q: "ai" });
    expect(parsed).toEqual({ q: "ai" });
  });

  test("拒绝空查询、越界 limit、无效游标和未登记字段", () => {
    const invalidValues = [
      { q: "" },
      { q: "ai", limit: 0 },
      { q: "ai", limit: SEARCH_PAGE_LIMIT_MAX + 1 },
      { q: "ai", cursor: "" },
      { q: "ai", cursor: "a".repeat(SEARCH_CURSOR_MAX_LENGTH + 1) },
      { q: "ai", includeVoid: "yes" },
      { q: "ai", projectId: 1 },
    ];

    for (const value of invalidValues) {
      expect(searchQueryRequestSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("SearchItem/SearchPage 契约", () => {
  test("getSearch 字段校验错误统一登记 422", () => {
    const route = routeRegistry.find(
      (entry) => entry.operationId === "getSearch",
    );
    const responses = route?.responses as Readonly<Record<string, unknown>>;
    expect(responses["422"]).toBeDefined();
    expect(responses["400"]).toBeUndefined();
  });

  test("SearchItem 保留 entityType 判别字段且不暴露内部 id", () => {
    expect(searchItemSchema.parse(validItem)).toEqual(validItem);
    expect(
      searchItemSchema.safeParse({ ...validItem, id: "projection-row" })
        .success,
    ).toBe(false);
  });

  test("SearchItem 的上级归属字段必填、可为 null", () => {
    const withParents = {
      ...validItem,
      moduleId: 3,
      recordId: 5,
    };
    expect(searchItemSchema.parse(withParents)).toEqual(withParents);

    for (const key of ["moduleId", "recordId"] as const) {
      const missing: Record<string, unknown> = { ...validItem };
      delete missing[key];
      expect(searchItemSchema.safeParse(missing).success).toBe(false);
      expect(
        searchItemSchema.safeParse({ ...validItem, [key]: 0 }).success,
      ).toBe(false);
    }
  });

  test("SearchPage 空列表与末页语义有效", () => {
    const page = {
      items: [validItem],
      nextCursor: null,
      hasMore: false,
    };
    expect(searchPageSchema.parse(page)).toEqual(page);
  });

  test("SearchPage 拒绝缺少 nextCursor 或 items 越界", () => {
    expect(
      searchPageSchema.safeParse({
        items: [validItem],
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(
      searchPageSchema.safeParse({
        items: Array.from(
          { length: SEARCH_PAGE_LIMIT_MAX + 1 },
          () => validItem,
        ),
        nextCursor: "foo",
        hasMore: true,
      }).success,
    ).toBe(false);
  });
});
