import { describe, expect, it } from "vitest";
import {
  routeRegistry,
  taskGroupItemSchema,
  taskGroupMergeReplayContextSchema,
  taskGroupMergeRequestSchema,
  taskGroupUnmergeReplayContextSchema,
  taskGroupUnmergeRequestSchema,
  taskGroupUnmergeResponseSchema,
} from "../src/index.js";
const merge = {
  sourceTaskId: 11,
  mainTaskId: 7,
  sourceKind: "HISTORICAL",
  mergeNote: null,
};
function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value))
    return value.length === 0
      ? [`${prefix}[]`]
      : leafPaths(value[0], `${prefix}[]`);
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
    );
  return [prefix];
}
const item = {
  id: 1,
  projectId: 3,
  code: "PAY-TG-1",
  name: "支付重试",
  status: "ACTIVE",
  createdBy: 7,
  rowVersion: 2,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:01.000Z",
  mainTaskId: 42,
  members: [
    {
      id: 1,
      taskId: 42,
      role: "MAIN",
      sourceKind: null,
      status: "ACTIVE",
      originalWorkStatus: null,
      originalAssigneeId: null,
      joinedAt: "2026-09-10T00:00:00.000Z",
    },
    {
      id: 2,
      taskId: 43,
      role: "SOURCE",
      sourceKind: "HISTORICAL",
      status: "ACTIVE",
      originalWorkStatus: "DONE",
      originalAssigneeId: 9,
      joinedAt: "2026-09-10T00:00:01.000Z",
    },
  ],
};
describe("F-23 任务合并契约", () => {
  it("只接受来源、主任务、分支类型与合并说明，其余字段由服务端推导", () => {
    expect(taskGroupMergeRequestSchema.parse(merge)).toEqual(merge);
    for (const field of [
      "projectId",
      "groupId",
      "code",
      "name",
      "status",
      "createdBy",
      "rowVersion",
      "originalWorkStatus",
      "originalAssigneeId",
      "members",
    ])
      expect(
        taskGroupMergeRequestSchema.safeParse({ ...merge, [field]: 1 }).success,
      ).toBe(false);
  });
  it("拒绝非法形状：非正/非整数 ID、未知或缺失分支类型、非文本说明", () => {
    for (const sourceTaskId of [0, -1, 1.5, 2147483648])
      expect(
        taskGroupMergeRequestSchema.safeParse({ ...merge, sourceTaskId })
          .success,
      ).toBe(false);
    expect(
      taskGroupMergeRequestSchema.safeParse({ ...merge, sourceKind: "BOTH" })
        .success,
    ).toBe(false);
    const withoutKind = { ...merge } as Record<string, unknown>;
    delete withoutKind["sourceKind"];
    expect(taskGroupMergeRequestSchema.safeParse(withoutKind).success).toBe(
      false,
    );
    expect(
      taskGroupMergeRequestSchema.safeParse({ ...merge, mergeNote: 1 }).success,
    ).toBe(false);
    expect(
      taskGroupMergeRequestSchema.parse({ ...merge, mergeNote: "  说明  " }),
    ).toMatchObject({ mergeNote: "说明" });
  });
  it("重放上下文必须至少含一个任务、去重并按任务 ID 升序", () => {
    expect(
      taskGroupMergeReplayContextSchema.parse({
        projectId: 3,
        groupId: 5,
        taskIds: [9, 4, 9, 4],
      }),
    ).toEqual({ projectId: 3, groupId: 5, taskIds: [4, 9] });
    expect(
      taskGroupMergeReplayContextSchema.safeParse({
        projectId: 3,
        groupId: 5,
        taskIds: [],
      }).success,
    ).toBe(false);
    expect(
      taskGroupMergeReplayContextSchema.safeParse({
        projectId: 3,
        groupId: 5,
        taskIds: [4],
        extra: 1,
      }).success,
    ).toBe(false);
  });
  it("结果 DTO 固定为 ACTIVE 聚合组并携带成员快照", () => {
    expect(taskGroupItemSchema.parse(item)).toEqual(item);
    expect(
      taskGroupItemSchema.safeParse({ ...item, status: "CLOSED" }).success,
    ).toBe(false);
    expect(
      taskGroupItemSchema.safeParse({ ...item, workStatus: "DONE" }).success,
    ).toBe(false);
    expect(
      taskGroupItemSchema.safeParse({
        ...item,
        members: [{ ...item.members[0], sourceKind: "HISTORICAL" }],
      }).success,
    ).toBe(true);
  });
  it("路由登记幂等、CSRF、锁序与可重放字段，且与结果 Schema 叶子字段精确一致", () => {
    const route = routeRegistry.find(
      (entry) => entry.operationId === "mergeTaskGroup",
    )!;
    expect(route).toMatchObject({
      method: "POST",
      path: "/task-groups/merge",
      authPolicy: "session",
      csrfPolicy: "required",
      idempotencyPolicy: "idempotencyRequired",
      idempotencyContractVersion: "1.0.0",
      versionPolicy: "none",
      auditAction: "task.merge",
      concurrencyPolicy: {
        rowVersion: "none",
        lockOrder: ["project", "module", "task", "taskGroup"],
      },
      request: {
        path: "none",
        query: "none",
        headers: "TaskGroupMergeHeaders",
      },
    });
    expect(route.responses["200"]).toBeDefined();
    expect(route.responses["409"]).toBeDefined();
    const replay = route.idempotencyReplayPolicy;
    if (replay === "none") throw new Error("mergeTaskGroup 必须登记重放策略");
    expect(replay.version).toBe("1.0.0");
    const success = replay.success["200"]!;
    if (!("body" in success)) throw new Error("200 必须登记可重放响应体");
    expect(success.body.responseSchemaRef).toBe("TaskGroupItem");
    expect([...success.body.safeBodyFieldPaths].sort()).toEqual(
      leafPaths(taskGroupItemSchema.parse(item)).sort(),
    );
    const authorization = route.replayAuthorizationPolicy;
    if (authorization === "none" || !("resources" in authorization))
      throw new Error("mergeTaskGroup 必须登记结果资源重放授权");
    expect(authorization.resources.contextSchemaRef).toBe(
      "TaskGroupMergeReplayContext",
    );
  });
});

const unmerge = { sourceTaskId: 43, unmergeReason: "根因已单独跟踪" };
const unmergeResponse = {
  group: {
    id: 5,
    projectId: 3,
    code: "PAY-TG-1",
    name: "支付重试",
    status: "CLOSED",
    createdBy: 7,
    rowVersion: 3,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:10:00.000Z",
    closedAt: "2026-09-10T00:10:00.000Z",
    mainTaskId: 42,
  },
  detachedMembers: [
    {
      id: 1,
      taskId: 42,
      role: "MAIN",
      sourceKind: null,
      originalWorkStatus: null,
      originalAssigneeId: null,
      joinedAt: "2026-09-10T00:00:00.000Z",
      detachedAt: "2026-09-10T00:10:00.000Z",
      detachReason: "根因已单独跟踪",
    },
    {
      id: 2,
      taskId: 43,
      role: "SOURCE",
      sourceKind: "HISTORICAL",
      originalWorkStatus: "DONE",
      originalAssigneeId: 9,
      joinedAt: "2026-09-10T00:00:01.000Z",
      detachedAt: "2026-09-10T00:10:00.000Z",
      detachReason: "根因已单独跟踪",
    },
  ],
};
describe("F-24 任务解除合并契约", () => {
  it("只接受来源任务与解除原因，原因可为空且去除首尾空白", () => {
    expect(taskGroupUnmergeRequestSchema.parse(unmerge)).toEqual(unmerge);
    expect(
      taskGroupUnmergeRequestSchema.parse({
        sourceTaskId: 43,
        unmergeReason: "  已单独跟踪  ",
      }),
    ).toEqual({ sourceTaskId: 43, unmergeReason: "已单独跟踪" });
    expect(
      taskGroupUnmergeRequestSchema.parse({
        sourceTaskId: 43,
        unmergeReason: null,
      }),
    ).toEqual({ sourceTaskId: 43, unmergeReason: null });
    for (const field of [
      "projectId",
      "groupId",
      "mainTaskId",
      "memberId",
      "detachedBy",
      "status",
    ])
      expect(
        taskGroupUnmergeRequestSchema.safeParse({ ...unmerge, [field]: 1 })
          .success,
      ).toBe(false);
    for (const sourceTaskId of [0, -1, 1.5, 2147483648])
      expect(
        taskGroupUnmergeRequestSchema.safeParse({ ...unmerge, sourceTaskId })
          .success,
      ).toBe(false);
    expect(
      taskGroupUnmergeRequestSchema.safeParse({ ...unmerge, unmergeReason: 1 })
        .success,
    ).toBe(false);
    expect(
      taskGroupUnmergeRequestSchema.safeParse({
        ...unmerge,
        unmergeReason: "x".repeat(10001),
      }).success,
    ).toBe(false);
  });
  it("结果 DTO 允许 CLOSED 组并携带解除时间与原因", () => {
    expect(taskGroupUnmergeResponseSchema.parse(unmergeResponse)).toEqual(
      unmergeResponse,
    );
    const activeGroup = {
      ...unmergeResponse,
      group: {
        ...unmergeResponse.group,
        status: "ACTIVE",
        closedAt: null,
      },
      detachedMembers: [unmergeResponse.detachedMembers[1]],
    };
    expect(taskGroupUnmergeResponseSchema.parse(activeGroup)).toEqual(
      activeGroup,
    );
    expect(
      taskGroupUnmergeResponseSchema.safeParse({
        ...unmergeResponse,
        detachedMembers: [],
      }).success,
    ).toBe(false);
    expect(
      taskGroupUnmergeResponseSchema.safeParse({
        ...unmergeResponse,
        detachedMembers: [
          ...unmergeResponse.detachedMembers,
          unmergeResponse.detachedMembers[1],
          unmergeResponse.detachedMembers[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      taskGroupUnmergeResponseSchema.safeParse({
        ...unmergeResponse,
        detachedMembers: [
          { ...unmergeResponse.detachedMembers[0], detachReason: "" },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskGroupUnmergeResponseSchema.safeParse({
        ...unmergeResponse,
        group: { ...unmergeResponse.group, closedAt: null },
      }).success,
    ).toBe(true);
  });
  it("重放上下文必须至少含一个任务、去重并按任务 ID 升序", () => {
    expect(
      taskGroupUnmergeReplayContextSchema.parse({
        projectId: 3,
        groupId: 5,
        taskIds: [43, 42, 43],
      }),
    ).toEqual({ projectId: 3, groupId: 5, taskIds: [42, 43] });
    expect(
      taskGroupUnmergeReplayContextSchema.safeParse({
        projectId: 3,
        groupId: 5,
        taskIds: [],
      }).success,
    ).toBe(false);
  });
  it("路由登记幂等、CSRF、锁序与可重放字段，且与结果 Schema 叶子字段精确一致", () => {
    const route = routeRegistry.find(
      (entry) => entry.operationId === "unmergeTaskGroup",
    )!;
    expect(route).toMatchObject({
      method: "POST",
      path: "/task-groups/unmerge",
      authPolicy: "session",
      csrfPolicy: "required",
      idempotencyPolicy: "idempotencyRequired",
      idempotencyContractVersion: "1.0.0",
      versionPolicy: "none",
      auditAction: "task.unmerge",
      concurrencyPolicy: {
        rowVersion: "none",
        lockOrder: ["project", "module", "task", "taskGroup"],
      },
      request: {
        path: "none",
        query: "none",
        headers: "TaskGroupUnmergeHeaders",
      },
    });
    expect(route.responses["200"]).toBeDefined();
    expect(route.responses["409"]).toBeDefined();
    const replay = route.idempotencyReplayPolicy;
    if (replay === "none") throw new Error("unmergeTaskGroup 必须登记重放策略");
    expect(replay.version).toBe("1.0.0");
    const success = replay.success["200"]!;
    if (!("body" in success)) throw new Error("200 必须登记可重放响应体");
    expect(success.body.responseSchemaRef).toBe("TaskGroupUnmergeResponse");
    expect([...success.body.safeBodyFieldPaths].sort()).toEqual(
      leafPaths(unmergeResponse).sort(),
    );
    const authorization = route.replayAuthorizationPolicy;
    if (authorization === "none" || !("resources" in authorization))
      throw new Error("unmergeTaskGroup 必须登记结果资源重放授权");
    expect(authorization.resources.contextSchemaRef).toBe(
      "TaskGroupUnmergeReplayContext",
    );
  });
});
