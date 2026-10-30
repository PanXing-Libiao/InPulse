import { describe, expect, it } from "vitest";

import {
  myRecordDraftListQuerySchema,
  myRecordDraftPageSchema,
  recordFeedItemSchema,
  recordFeedPageSchema,
  recordFeedQueryRequestSchema,
} from "../src/contracts/record-feed.zod.js";
import { routeRegistry } from "../src/route-registry.js";
import { schemaRegistry } from "../src/schema-registry.js";

const publishedRecord = {
  id: 41,
  projectId: 7,
  moduleId: 9,
  taskId: null,
  handlerId: 3,
  authorId: 3,
  status: "PUBLISHED",
  code: "POCC1-CR-1",
  currentVersion: 1,
  publishedAt: "2026-09-12T01:02:03.000000Z",
  rowVersion: 2,
  createdAt: "2026-09-12T01:02:00.000000Z",
  updatedAt: "2026-09-12T01:02:03.000000Z",
  title: "跨项目记录",
  contextProblem: "问题",
  changeSolution: "方案",
  resultVerification: "验证",
  remainingIssues: [],
  leftovers: [],
};

const feedItem = {
  record: publishedRecord,
  projectName: "InPulse 项目一号",
  moduleName: "支付模块",
  author: { userId: 3, name: "张三", avatarUrl: null },
};

describe("B-3b 跨项目记录读契约", () => {
  it("清单查询只接受 projectId / status / source / q / cursor / limit，且 q 长度受限", () => {
    const schema = recordFeedQueryRequestSchema;
    expect(
      schema.safeParse({ projectId: "7", status: "ALL", source: "SOURCE" })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ status: "DRAFT" }).success).toBe(false);
    expect(schema.safeParse({ source: "GROUP" }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    // 下限放宽到 1（单字可搜）后，单字合法、只有空串与超长被拒。
    expect(schema.safeParse({ q: "甲" }).success).toBe(true);
    expect(schema.safeParse({ q: "" }).success).toBe(false);
    expect(schema.safeParse({ q: "甲".repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ cursor: "a".repeat(513) }).success).toBe(false);
    for (const field of ["projectIds", "authorId", "includeVoid", "ownerId"])
      expect(schema.safeParse({ [field]: 1 }).success).toBe(false);
  });

  it("清单条目保持 ReadableRecord 形状并强制名称回填", () => {
    const schema = recordFeedItemSchema;
    expect(schema.safeParse(feedItem).success).toBe(true);
    for (const field of ["projectName", "moduleName", "author"])
      expect(
        schema.safeParse({ ...feedItem, [field]: undefined }).success,
      ).toBe(false);
    expect(
      schema.safeParse({ page: feedItem, projectName: "x", moduleName: "y" })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...feedItem,
        record: { ...publishedRecord, status: "DRAFT" },
      }).success,
    ).toBe(false);
    const page = recordFeedPageSchema;
    expect(
      page.safeParse({ items: [], nextCursor: null, hasMore: false }).success,
    ).toBe(true);
    expect(
      page.safeParse({
        items: [feedItem],
        nextCursor: "token",
        hasMore: true,
      }).success,
    ).toBe(true);
    expect(
      page.safeParse({ items: [feedItem], nextCursor: null, hasMore: "yes" })
        .success,
    ).toBe(false);
  });

  it("我的草稿查询只有 cursor / limit，页面条目自带名称回填", () => {
    expect(
      myRecordDraftListQuerySchema.safeParse({ limit: "20" }).success,
    ).toBe(true);
    for (const field of ["authorId", "projectId", "projectIds", "status", "q"])
      expect(
        myRecordDraftListQuerySchema.safeParse({ [field]: 1 }).success,
      ).toBe(false);
    expect(
      myRecordDraftPageSchema.safeParse({
        items: [],
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  it("Schema Registry 与 Route Registry 已登记两条只读路由", () => {
    expect(schemaRegistry.RecordFeedQueryRequest).toBeDefined();
    expect(schemaRegistry.RecordFeedPage).toBeDefined();
    expect(schemaRegistry.MyRecordDraftListQuery).toBeDefined();
    expect(schemaRegistry.MyRecordDraftPage).toBeDefined();

    const feed = routeRegistry.find(
      (route) => route.operationId === "listRecordFeed",
    );
    expect(feed).toBeDefined();
    expect(feed?.method).toBe("GET");
    expect(feed?.path).toBe("/change-records");
    expect(feed?.request.query).toBe("RecordFeedQueryRequest");
    expect(Object.keys(feed?.responses ?? {}).sort()).toEqual([
      "200",
      "401",
      "422",
      "500",
    ]);
    expect(feed?.authPolicy).toBe("session");
    expect(feed?.csrfPolicy).toBe("none");
    expect(feed?.idempotencyPolicy).toBe("none");

    const drafts = routeRegistry.find(
      (route) => route.operationId === "listMyRecordDrafts",
    );
    expect(drafts).toBeDefined();
    expect(drafts?.method).toBe("GET");
    expect(drafts?.path).toBe("/me/record-drafts");
    expect(drafts?.request.query).toBe("MyRecordDraftListQuery");
    expect(Object.keys(drafts?.responses ?? {}).sort()).toEqual([
      "200",
      "401",
      "422",
      "500",
    ]);
    expect(drafts?.authPolicy).toBe("session");
    expect(drafts?.idempotencyPolicy).toBe("none");
  });
});
