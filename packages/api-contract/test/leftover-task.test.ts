import { it, expect } from "vitest";
import {
  leftoverTaskRequestSchema,
  leftoverTaskPreviewQuerySchema,
} from "../src/contracts/leftover-task.zod.js";
const input = {
  leftoverItemId: 1,
  recordVersion: 2,
  expectedRowVersion: 3,
  leftoverExpectedRowVersion: 1,
  title: "跟进",
  assigneeIds: [5],
  priority: "NORMAL",
  dueAt: null,
};
it("requires stable item, current record and item versions", () => {
  expect(leftoverTaskRequestSchema.safeParse(input).success).toBe(true);
  for (const body of [
    { ...input, leftoverItemId: 0 },
    { ...input, recordVersion: 0 },
    { ...input, projectId: 10 },
    { ...input, workStatus: "DONE" },
    { ...input, assigneeIds: [] },
    { ...input, assigneeIds: [0] },
  ])
    expect(leftoverTaskRequestSchema.safeParse(body).success).toBe(false);
});
it("accepts the optional task description (2026-09-30) and still bounds it by 50000", () => {
  expect(leftoverTaskRequestSchema.safeParse(input).success).toBe(true);
  expect(
    leftoverTaskRequestSchema.safeParse({ ...input, description: "补充说明" })
      .success,
  ).toBe(true);
  expect(
    leftoverTaskRequestSchema.safeParse({ ...input, description: "" }).success,
  ).toBe(true);
  expect(
    leftoverTaskRequestSchema.safeParse({
      ...input,
      description: "x".repeat(50001),
    }).success,
  ).toBe(false);
});
it("preview query either names one leftover item or omits it for multi-entry records", () => {
  expect(leftoverTaskPreviewQuerySchema.parse({ leftoverItemId: "7" })).toEqual(
    { leftoverItemId: 7 },
  );
  expect(leftoverTaskPreviewQuerySchema.parse({})).toEqual({});
  for (const query of [
    { leftoverItemId: 0 },
    { leftoverItemId: "x" },
    { leftoverItemId: 1.5 },
    { leftoverItemId: null },
    { recordVersion: 1 },
  ])
    expect(leftoverTaskPreviewQuerySchema.safeParse(query).success).toBe(false);
});
