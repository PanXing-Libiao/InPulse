import { describe, expect, it } from "vitest";
import { schemaRegistry } from "../src/schema-registry.js";
const content = {
  title: "修订",
  contextProblem: "问题",
  changeSolution: "方案",
  resultVerification: "验证",
  remainingIssues: [],
  confirmLeftoverResolved: false,
};
const entries = (count: number, content = "遗留") =>
  Array.from({ length: count }, () => ({ content }));
it("limits entries and per-entry capacity without changing draft capacity, and rejects identity mutation", () => {
  const schema = schemaRegistry.PublishedRecordContent.schema;
  expect(
    schema.safeParse({
      ...content,
      remainingIssues: [{ content: "文".repeat(10000) }],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      ...content,
      remainingIssues: [{ content: "文".repeat(10001) }],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ ...content, remainingIssues: entries(50) }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ ...content, remainingIssues: entries(51) }).success,
  ).toBe(false);
  const { confirmLeftoverResolved, ...draft } = content;
  expect(
    schemaRegistry.RecordDraftContent.schema.safeParse({
      ...draft,
      remainingIssues: entries(50, "文".repeat(10000)),
    }).success,
  ).toBe(true);
  expect(
    schemaRegistry.RecordDraftContent.schema.safeParse({
      ...draft,
      remainingIssues: [{ content: "文".repeat(10001) }],
    }).success,
  ).toBe(false);
  expect(schema.safeParse(draft).success).toBe(false);
  for (const field of [
    "taskId",
    "projectId",
    "moduleId",
    "handlerId",
    "authorId",
    "status",
    "currentVersion",
    "leftovers",
  ])
    expect(schema.safeParse({ ...content, [field]: 1 }).success).toBe(false);
  expect(confirmLeftoverResolved).toBe(false);
});
it("requires both explicit version headers and a strictly empty publication body", () => {
  const headers = {
    "x-csrf-token": "a".repeat(43),
    "if-match": '"2"',
    "x-record-version": "1",
  };
  expect(
    schemaRegistry.PublishedRecordVersionHeaders.schema.safeParse(headers)
      .success,
  ).toBe(true);
  for (const name of ["if-match", "x-record-version"])
    expect(
      schemaRegistry.PublishedRecordVersionHeaders.schema.safeParse({
        ...headers,
        [name]: undefined,
      }).success,
    ).toBe(false);
  expect(schemaRegistry.PublishRecordRequest.schema.safeParse({}).success).toBe(
    true,
  );
  expect(
    schemaRegistry.PublishRecordRequest.schema.safeParse({ taskId: 1 }).success,
  ).toBe(false);
});
it("accepts one trimmed leftover entry per append request and keeps record version state server-owned", () => {
  const schema = schemaRegistry.AddRecordLeftoverRequest.schema;
  expect(schema.parse({ content: " 新发现的遗留 " })).toEqual({
    content: "新发现的遗留",
  });
  expect(schema.safeParse({ content: "文".repeat(10000) }).success).toBe(true);
  for (const body of [
    { content: "" },
    { content: "   " },
    { content: "文".repeat(10001) },
    { content: "待跟进", id: 3 },
    { content: "待跟进", confirmLeftoverResolved: true },
    { content: "待跟进", rowVersion: 2 },
    {},
  ])
    expect(schema.safeParse(body).success).toBe(false);
  const record = schemaRegistry.PublishedRecord.schema;
  expect(
    record.safeParse({
      id: 7,
      projectId: 1,
      moduleId: 2,
      taskId: null,
      handlerId: 3,
      authorId: 3,
      status: "PUBLISHED",
      code: "SHOP-CR-1",
      currentVersion: 2,
      publishedAt: "2026-09-10T00:00:00.000Z",
      rowVersion: 3,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      title: "修订",
      contextProblem: "问题",
      changeSolution: "方案",
      resultVerification: "验证",
      remainingIssues: [{ id: 9, content: "待跟进" }],
      leftovers: [
        {
          id: 9,
          content: "待跟进",
          status: "CONVERTED",
          rowVersion: 2,
          linkedTaskId: 11,
        },
      ],
    }).success,
  ).toBe(true);
});

describe("B-1 published record list pagination contract", () => {
  it("accepts status/cursor/limit and rejects unknown or out-of-range values", () => {
    const schema = schemaRegistry.RecordListQuery.schema;
    expect(schema.parse({ status: "VOID", limit: "20" })).toEqual({
      status: "VOID",
      limit: 20,
    });
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ cursor: "" }).success).toBe(false);
    expect(schema.safeParse({ q: "x" }).success).toBe(false);
  });
  it("keeps the items/nextCursor/hasMore envelope strict", () => {
    const page = schemaRegistry.ReadableRecordPage.schema;
    expect(
      page.safeParse({ items: [], nextCursor: "c.1", hasMore: true }).success,
    ).toBe(true);
    expect(page.safeParse({ items: [], hasMore: true }).success).toBe(false);
  });
});
