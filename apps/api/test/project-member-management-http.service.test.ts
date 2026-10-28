import { describe, expect, it, vi } from "vitest";

import type { SessionAuthService } from "../src/auth/session-auth.service.js";
import type { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import type { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type {
  IdempotencyHttpCommand,
  IdempotencyHttpService,
} from "../src/idempotency/http-service.js";
import { ProjectMemberManagementHttpService } from "../src/modules/projects/project-member-management-http.service.js";
import type { ProjectMemberManagementService } from "../src/modules/projects/project-member-management.service.js";

const tx = {} as TransactionContext;
const actor = { userId: 1 };
const member = {
  membershipId: 10,
  projectId: 7,
  userId: 5,
  name: "张三",
  avatarUrl: null,
  status: "ACTIVE" as const,
  role: "MEMBER" as const,
  joinedAt: "2026-09-09T00:00:00.000Z",
  removedAt: null,
};

function validRequest() {
  return {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      cookie: "__Host-session=x",
      "x-csrf-token": "x".repeat(43),
      "idempotency-key": "f05-key",
      "content-type": "application/json",
    },
    params: { projectId: "7", userId: "5" },
    query: {},
    body: { reassignments: [] },
  };
}

function setup() {
  const resolveActorInTransaction = vi.fn().mockResolvedValue(actor);
  const mutationVerify = vi.fn().mockResolvedValue(actor);
  const run = vi.fn(async (cb: (tx: TransactionContext) => Promise<unknown>) =>
    cb(tx),
  );
  let command: IdempotencyHttpCommand | undefined;
  const idempotencyRun = vi.fn(async (input: IdempotencyHttpCommand) => {
    command = input;
    const resolved =
      typeof input.actorId === "number"
        ? input.actorId
        : await input.actorId(tx);
    return input.execute(tx, resolved);
  });
  const members = {
    listMembers: vi.fn().mockResolvedValue({ items: [member] }),
    listUnfinishedTasks: vi.fn().mockResolvedValue({ items: [] }),
    addMember: vi.fn().mockResolvedValue({
      responseStatus: 200,
      responseSchemaRef: "AddProjectMemberResponse",
      responseHasBody: true,
      responseBody: { member },
      replayAuthContext: { projectId: 7, memberUserId: 5 },
    }),
    removeMember: vi.fn().mockResolvedValue({
      responseStatus: 200,
      responseSchemaRef: "RemoveProjectMemberResponse",
      responseHasBody: true,
      responseBody: {
        member: {
          ...member,
          status: "REMOVED",
          removedAt: "2026-09-09T01:00:00.000Z",
        },
        reassignedTaskIds: [],
        unfinishedTaskCount: 0,
      },
      replayAuthContext: { projectId: 7, memberUserId: 5 },
    }),
    setRole: vi.fn().mockResolvedValue({
      responseStatus: 200,
      responseSchemaRef: "SetProjectMemberRoleResponse",
      responseHasBody: true,
      responseBody: { member: { ...member, role: "LEADER" } },
      replayAuthContext: { projectId: 7, memberUserId: 5 },
    }),
    replayAuthorizer: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ProjectMemberManagementHttpService(
    {
      resolveActorInTransaction,
    } as unknown as SessionAuthService,
    { verify: mutationVerify } as unknown as AuthenticatedMutationService,
    { run } as unknown as PostgresUnitOfWork,
    members as unknown as ProjectMemberManagementService,
    { run: idempotencyRun } as unknown as IdempotencyHttpService,
  );
  return {
    service,
    resolveActorInTransaction,
    mutationVerify,
    members,
    command: () => command!,
  };
}

describe("ProjectMemberManagementHttpService", () => {
  it("reads member lists and unfinished tasks inside the same transaction", async () => {
    const s = setup();
    const listRequest = { ...validRequest(), params: { projectId: "7" } };
    const list = await s.service.handle("listProjectMembers", listRequest);
    expect(list.status).toBe(200);
    expect(s.resolveActorInTransaction).toHaveBeenCalledWith(
      tx,
      "__Host-session=x",
    );
    expect(s.members.listMembers).toHaveBeenCalledWith(tx, 7, 1);

    const tasksRequest = validRequest();
    const tasks = await s.service.handle(
      "listProjectMemberUnfinishedTasks",
      tasksRequest,
    );
    expect(tasks.status).toBe(200);
    expect(s.members.listUnfinishedTasks).toHaveBeenCalledWith(tx, 7, 5, 1);
  });

  it("calls the idempotent add command with the resolved admin actor", async () => {
    const s = setup();
    const result = await s.service.handle("addProjectMember", {
      ...validRequest(),
      params: { projectId: "7" },
      body: { userId: 5 },
    });
    expect(result.status).toBe(200);
    expect(s.command().operationId).toBe("addProjectMember");
    expect(s.mutationVerify).toHaveBeenCalled();
    expect(s.members.addMember).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorId: 1, userId: 5 }),
    );
  });

  it("re-validates session, CSRF and manage role before replay", async () => {
    const s = setup();
    await s.service.handle("removeProjectMember", validRequest());
    const authorizer = s.command().replayAuthorizer!;
    await authorizer(
      { replayAuthContext: { projectId: 7, memberUserId: 5 } } as never,
      tx,
    );
    expect(s.mutationVerify).toHaveBeenCalledWith(tx, validRequest().headers);
    expect(s.members.replayAuthorizer).toHaveBeenCalledWith(
      tx,
      1,
      {
        projectId: 7,
        memberUserId: 5,
      },
      "projectMemberManage",
    );
  });

  it("routes setProjectMemberRole through the idempotent role command", async () => {
    const s = setup();
    const result = await s.service.handle("setProjectMemberRole", {
      ...validRequest(),
      body: { role: "LEADER" },
    });
    expect(result.status).toBe(200);
    expect(s.command().operationId).toBe("setProjectMemberRole");
    expect(s.members.setRole).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: 1,
        projectId: 7,
        userId: 5,
        role: "LEADER",
      }),
    );
    // 幂等摘要 body 必须携带角色字段，防止不同角色复用同一 Key。
    expect(s.command().request.body).toEqual({ role: "LEADER" });
  });

  it("rejects a removed PROJECT_ADMIN role body (ADR-039) with 422", async () => {
    const s = setup();
    const result = await s.service.handle("setProjectMemberRole", {
      ...validRequest(),
      body: { role: "PROJECT_ADMIN" },
    });
    expect(result.status).toBe(422);
    expect(s.members.setRole).not.toHaveBeenCalled();
  });

  it("rejects an invalid role body with 422 before any command runs", async () => {
    const s = setup();
    const result = await s.service.handle("setProjectMemberRole", {
      ...validRequest(),
      body: { role: "SUPERUSER" },
    });
    expect(result.status).toBe(422);
    expect(s.members.setRole).not.toHaveBeenCalled();
  });

  it("rejects write requests without JSON content type", async () => {
    const s = setup();
    const result = await s.service.handle("addProjectMember", {
      ...validRequest(),
      headers: {
        ...validRequest().headers,
        "content-type": "text/plain",
      },
      params: { projectId: "7" },
      body: { userId: 5 },
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: "PROJECT_MEMBER_CONTENT_TYPE_INVALID",
    });
    expect(s.members.addMember).not.toHaveBeenCalled();
  });

  it("maps auth failure and unknown errors to safe error envelopes", async () => {
    const s = setup();
    s.mutationVerify.mockResolvedValueOnce(undefined);
    const noSession = await s.service.handle("addProjectMember", {
      ...validRequest(),
      params: { projectId: "7" },
      body: { userId: 5 },
    });
    expect(noSession.status).toBe(401);
    expect(noSession.body).toMatchObject({
      code: "PROJECT_MEMBER_SESSION_REQUIRED",
    });

    s.members.addMember.mockRejectedValueOnce(
      new Error("project_members secret detail"),
    );
    const unknown = await s.service.handle("addProjectMember", {
      ...validRequest(),
      params: { projectId: "7" },
      body: { userId: 5 },
    });
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(unknown)).not.toContain("secret");
  });
});
