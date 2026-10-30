import { describe, expect, it } from "vitest";
import { moduleTaskEditRequestSchema } from "../src/contracts/tasks.zod.js";
import { moduleTaskRoutes } from "../src/task-routes.js";

describe("ADR-109 module task contract", () => {
  it("only registers direct module task routes", () => {
    expect(moduleTaskRoutes.map((route) => route.operationId)).toEqual([
      "listModuleTasks",
      "listModuleTaskAssignees",
      "getModuleTask",
      "createModuleTask",
      "updateModuleTask",
      "transitionModuleTask",
      "getModuleTaskStatusHistory",
      "deleteModuleTask",
    ]);
  });

  it("accepts editable task fields and rejects removed feature fields", () => {
    const input = {
      title: "公共支付",
      description: "",
      priority: "NORMAL",
      assigneeIds: [1],
      dueAt: null,
    };
    expect(moduleTaskEditRequestSchema.parse(input)).toEqual(input);
    for (const field of [
      "featureId",
      "scopeType",
      "impactFeatureIds",
      "projectId",
      "workStatus",
    ]) {
      expect(
        moduleTaskEditRequestSchema.safeParse({ ...input, [field]: 1 }).success,
      ).toBe(false);
    }
  });
});
