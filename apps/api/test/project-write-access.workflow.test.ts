import { describe, expect, test, vi } from "vitest";

import type { AuthenticatedSessionActor } from "../src/auth/session-auth.service.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type {
  ModuleForWriteResource,
  ModuleWriteCheckResult,
} from "../src/modules/modules/index.js";
import type {
  ProjectForWriteResource,
  ProjectWriteCheckResult,
} from "../src/modules/projects/index.js";
import { ProjectWriteAccessWorkflow } from "../src/workflows/index.js";

const tx = (): TransactionContext => ({ db: {} as never, sql: {} as never });

const actor: AuthenticatedSessionActor = {
  sessionId: 11,
  userId: 7,
  authState: "AUTHENTICATED",
  authVersionAtIssue: 1,
};

const project: ProjectForWriteResource = {
  projectId: 1,
  status: "ACTIVE",
  rowVersion: 1,
  isSystemAdmin: false,
};

const moduleResource: ModuleForWriteResource = {
  projectId: 1,
  moduleId: 2,
  rowVersion: 1,
};

function setup(
  overrides: {
    actor?: AuthenticatedSessionActor | undefined;
    project?: ProjectWriteCheckResult;
    module?: ModuleWriteCheckResult;
  } = {},
) {
  const calls: string[] = [];
  const sessionAuth = {
    resolveActorInTransaction: vi.fn(async () => {
      calls.push("session");
      return "actor" in overrides ? overrides.actor : actor;
    }),
  };
  const projectAccess = {
    checkProjectForWrite: vi.fn(async () => {
      calls.push("project");
      return overrides.project ?? { kind: "allowed", resource: project };
    }),
  };
  const modules = {
    checkModuleForWrite: vi.fn(async () => {
      calls.push("module");
      return overrides.module ?? { kind: "allowed", resource: moduleResource };
    }),
  };
  const workflow = new ProjectWriteAccessWorkflow(
    sessionAuth as never,
    projectAccess as never,
    modules as never,
  );
  return { calls, sessionAuth, projectAccess, modules, workflow };
}

describe("ProjectWriteAccessWorkflow", () => {
  test("module allowed 按 session -> project -> module 顺序返回完整摘要", async () => {
    const { calls, sessionAuth, projectAccess, modules, workflow } = setup();
    const context = tx();

    const result = await workflow.checkModuleForWrite(context, {
      cookieHeader: "__Host-session=token",
      projectId: 1,
      moduleId: 2,
    });

    expect(result).toEqual({
      kind: "allowed",
      actor,
      project,
      module: moduleResource,
    });
    expect(calls).toEqual(["session", "project", "module"]);
    expect(sessionAuth.resolveActorInTransaction).toHaveBeenCalledWith(
      context,
      "__Host-session=token",
    );
    expect(projectAccess.checkProjectForWrite).toHaveBeenCalledWith(context, {
      actorUserId: 7,
      projectId: 1,
    });
    expect(modules.checkModuleForWrite).toHaveBeenCalledWith(context, {
      projectId: 1,
      moduleId: 2,
    });
  });

  test("actor 未认证时不查询项目或模块", async () => {
    const { calls, projectAccess, modules, workflow } = setup({
      actor: undefined,
    });

    await expect(
      workflow.checkModuleForWrite(tx(), {
        cookieHeader: undefined,
        projectId: 1,
        moduleId: 2,
      }),
    ).resolves.toEqual({ kind: "unauthenticated" });

    expect(calls).toEqual(["session"]);
    expect(projectAccess.checkProjectForWrite).not.toHaveBeenCalled();
    expect(modules.checkModuleForWrite).not.toHaveBeenCalled();
  });

  test("项目 not-found 会阻断模块检查", async () => {
    const cases: ProjectWriteCheckResult[] = [{ kind: "not-found" }];

    for (const projectResult of cases) {
      const { calls, modules, workflow } = setup({
        project: projectResult,
      });

      await expect(
        workflow.checkModuleForWrite(tx(), {
          cookieHeader: "__Host-session=token",
          projectId: 1,
          moduleId: 2,
        }),
      ).resolves.toEqual({ kind: "project-not-found" });

      expect(calls).toEqual(["session", "project"]);
      expect(modules.checkModuleForWrite).not.toHaveBeenCalled();
    }
  });

  test("模块 not-found 返回 module-not-found（ADR-044：模块已无只读态）", async () => {
    const { calls, workflow } = setup({
      module: { kind: "not-found" },
    });

    await expect(
      workflow.checkModuleForWrite(tx(), {
        cookieHeader: "__Host-session=token",
        projectId: 1,
        moduleId: 2,
      }),
    ).resolves.toEqual({ kind: "module-not-found" });

    expect(calls).toEqual(["session", "project", "module"]);
  });
});
