import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { routeRegistry } from "../src/route-registry.js";
import { taskCompletionRequestSchema } from "../src/contracts/task-completion.zod.js";
const record = {
  title: "修复",
  contextProblem: "问题",
  changeSolution: "方案",
  resultVerification: "验证",
  remainingIssues: [],
};
it("versions the module task status operation while preserving its fingerprint history", () => {
  const history = JSON.parse(
    readFileSync(
      new URL("../generated/route-contract-fingerprints.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, { version: string }[]>;
  const route = routeRegistry.find(
    (route) => route.operationId === "transitionModuleTask",
  )!;
  expect(route.idempotencyContractVersion).toBe("6.0.0");
  expect(route.replayAuthorizationPolicy).toMatchObject({
    version: "2.0.0",
    resources: { contextSchemaRef: "TaskStatusCompatibilityReplayContext" },
  });
  expect(history.transitionModuleTask!.map((entry) => entry.version)).toEqual([
    "1.0.0",
    "2.0.0",
    "3.0.0",
    "4.0.0",
    "5.0.0",
    "6.0.0",
  ]);
});
it("accepts exactly one inline record or explicit draft reference, never both", () => {
  const base = { mode: "WITH_RECORD", expectedRowVersion: 2 };
  expect(
    taskCompletionRequestSchema.safeParse({ ...base, record }).success,
  ).toBe(true);
  expect(
    taskCompletionRequestSchema.safeParse({
      ...base,
      recordDraftId: 4,
      recordExpectedRowVersion: 1,
    }).success,
  ).toBe(true);
  for (const input of [
    base,
    { ...base, record, recordDraftId: 4, recordExpectedRowVersion: 1 },
    { ...base, recordDraftId: 4 },
    { ...base, record: { ...record, taskId: 5 } },
    {
      ...base,
      record: { ...record, remainingIssues: [{ content: "文".repeat(10001) }] },
    },
    {
      ...base,
      record: {
        ...record,
        remainingIssues: Array.from({ length: 51 }, (_value, index) => ({
          content: `第${index}条`,
        })),
      },
    },
  ])
    expect(taskCompletionRequestSchema.safeParse(input).success).toBe(false);
});
it("requires the F16 reason and note for no-change completion and rejects a hidden record", () => {
  const base = {
    mode: "WITHOUT_RECORD",
    expectedRowVersion: 1,
    completionReason: "测试验证",
    note: "",
  };
  expect(taskCompletionRequestSchema.safeParse(base).success).toBe(true);
  for (const input of [
    { ...base, record },
    { ...base, completionReason: "实际代码变化" },
    { ...base, expectedRowVersion: 0 },
    { ...base, authorId: 1 },
  ])
    expect(taskCompletionRequestSchema.safeParse(input).success).toBe(false);
});
