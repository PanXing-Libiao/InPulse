import { describe, expect, it } from "vitest";
import { taskEditRequestSchema } from "../src/contracts/tasks.zod.js";
import { taskRoutes } from "../src/task-routes.js";

describe("F-14 task input", () => {
  it("registers task routes and requires explicit replay/version/lock policies for writes", () => {
    expect(taskRoutes.map((route) => route.operationId)).toEqual([
      "listModuleTasks",
      "listModuleTaskAssignees",
      "getModuleTask",
      "createModuleTask",
      "updateModuleTask",
      "transitionModuleTask",
      "getModuleTaskStatusHistory",
      "deleteModuleTask",
    ]);
    for (const route of taskRoutes) {
      if (route.method === "GET") expect(route.idempotencyPolicy).toBe("none");
      else {
        expect(route.csrfPolicy).toBe("required");
        expect(route.idempotencyPolicy).toBe("idempotencyRequired");
        expect(route.replayAuthorizationPolicy).not.toBe("none");
        if (route.operationId === "updateModuleTask")
          expect(route.behaviorHeaders).toEqual(["If-Match"]);
      }
    }
  });
  it("requires a selected assignee and rejects identity/status injection", () => {
    const valid = {
      title: " 修复支付 ",
      description: "",
      priority: "NORMAL",
      assigneeIds: [1],
      dueAt: null,
    };
    expect(taskEditRequestSchema.parse(valid).title).toBe("修复支付");
    for (const invalid of [
      { ...valid, assigneeIds: [] },
      { ...valid, assigneeIds: [0] },
      { ...valid, title: " " },
      { ...valid, title: "x".repeat(501) },
      { ...valid, description: "x".repeat(50001) },
      { ...valid, priority: "INVALID" },
      { ...valid, dueAt: "tomorrow" },
      ...["code", "projectId", "creatorId", "workStatus", "rowVersion"].map(
        (key) => ({ ...valid, [key]: 1 }),
      ),
    ])
      expect(taskEditRequestSchema.safeParse(invalid).success).toBe(false);
  });
});
