import { describe, expect, it } from "vitest";
import { schemaRegistry } from "../src/schema-registry.js";
import {
  recordDraftContentSchema,
  independentRecordDraftSchema,
} from "../src/contracts/record-drafts.zod.js";

const content = {
  title: " 支付重试验证 ",
  contextProblem: " 发现重复提交 ",
  changeSolution: "增加请求去重",
  resultVerification: "并发回归通过",
  remainingIssues: [],
};
describe("F-17 draft content", () => {
  it("lets the server derive the source title and rejects client-owned identity or state fields", () => {
    const schema = schemaRegistry.TaskRecordDraftRequest.schema;
    expect(schema.parse({ ...content, title: null }).title).toBeNull();
    for (const field of [
      "taskId",
      "projectId",
      "moduleId",
      "handlerId",
      "authorId",
      "status",
      "createdAt",
    ])
      expect(
        schema.safeParse({ ...content, title: null, [field]: 1 }).success,
      ).toBe(false);
    for (const field of [
      "contextProblem",
      "changeSolution",
      "resultVerification",
    ])
      expect(
        schema.safeParse({ ...content, title: null, [field]: " " }).success,
      ).toBe(false);
  });
  it("requires the three core sections and normalizes user content", () => {
    expect(recordDraftContentSchema.parse(content)).toMatchObject({
      title: "支付重试验证",
      contextProblem: "发现重复提交",
      remainingIssues: [],
    });
    for (const field of [
      "title",
      "contextProblem",
      "changeSolution",
      "resultVerification",
    ])
      expect(
        recordDraftContentSchema.safeParse({ ...content, [field]: "  " })
          .success,
      ).toBe(false);
    for (const field of [
      "taskId",
      "authorId",
      "handlerId",
      "status",
      "code",
      "currentVersion",
      "publishedAt",
    ])
      expect(
        recordDraftContentSchema.safeParse({ ...content, [field]: 1 }).success,
      ).toBe(false);
  });
  it("rejects client-owned module and removed feature scope fields", () => {
    expect(independentRecordDraftSchema.safeParse(content).success).toBe(true);
    for (const extra of [
      { moduleId: 2 },
      { scopeType: "MODULE" },
      { featureId: 2 },
      { impactFeatureIds: [3] },
    ]) {
      expect(
        independentRecordDraftSchema.safeParse({ ...content, ...extra })
          .success,
      ).toBe(false);
    }
  });
});

describe("B-1 draft list pagination contract", () => {
  it("coerces limit within 1..100 and only accepts the opaque cursor shape", () => {
    const schema = schemaRegistry.RecordDraftListQuery.schema;
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ limit: "20" })).toEqual({ limit: 20 });
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ cursor: "a".repeat(513) }).success).toBe(false);
    expect(schema.safeParse({ status: "PUBLISHED" }).success).toBe(false);
    const cursor = ["payload", "signature"].join(".");
    expect(schema.parse({ cursor })).toEqual({ cursor });
  });
  it("keeps the items/nextCursor/hasMore envelope strict", () => {
    const page = schemaRegistry.RecordDraftPage.schema;
    expect(
      page.safeParse({ items: [], nextCursor: null, hasMore: false }).success,
    ).toBe(true);
    expect(page.safeParse({ items: [], nextCursor: null }).success).toBe(false);
    expect(
      page.safeParse({
        items: [],
        nextCursor: null,
        hasMore: false,
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      page.safeParse({ items: [], nextCursor: "", hasMore: false }).success,
    ).toBe(false);
  });
});
