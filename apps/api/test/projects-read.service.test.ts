import { describe, expect, it, vi } from "vitest";
import type { ProjectItem } from "@inpulse/api-contract";
import type { SessionAuthService } from "../src/auth/session-auth.service.js";
import type { ProjectAccessQueryPort } from "../src/modules/projects/project-access.port.js";
import type { ProjectQueryPort } from "../src/modules/projects/project-query.port.js";
import {
  ProjectsReadService,
  ProjectReadServiceError,
} from "../src/modules/projects/projects-read.service.js";

const project: ProjectItem = {
  id: 7,
  code: "SHOP",
  name: "商城系统",
  description: "项目描述",
  status: "ACTIVE",
  hasCompletedTask: true,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 2,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

function setup(scopeProjectIds: readonly number[] = [7]) {
  const resolveActor = vi.fn().mockResolvedValue({
    sessionId: 1,
    userId: 5,
    authState: "AUTHENTICATED",
    authVersionAtIssue: 1,
  });
  const getAuthorizedSearchScope = vi.fn().mockResolvedValue({
    actorUserId: 5,
    projectIds: scopeProjectIds,
    isSystemAdmin: false,
  });
  const list = vi.fn().mockResolvedValue([project]);
  const find = vi.fn().mockResolvedValue(project);
  const findActiveMemberRole = vi.fn().mockResolvedValue("MEMBER");
  const service = new ProjectsReadService(
    { resolveActor } as unknown as SessionAuthService,
    { getAuthorizedSearchScope } as unknown as ProjectAccessQueryPort,
    { list, find, findActiveMemberRole } as unknown as ProjectQueryPort,
  );
  return {
    service,
    resolveActor,
    getAuthorizedSearchScope,
    list,
    find,
    findActiveMemberRole,
  };
}

describe("ProjectsReadService", () => {
  it("uses the server-scoped project list and never accepts client scope", async () => {
    const s = setup([7, 9]);
    await expect(s.service.list("__Host-session=t")).resolves.toEqual({
      items: [project],
    });
    expect(s.resolveActor).toHaveBeenCalledWith("__Host-session=t");
    expect(s.getAuthorizedSearchScope).toHaveBeenCalledWith(5);
    expect(s.list).toHaveBeenCalledWith([7, 9], 5);
  });

  it("returns detail for a scoped project and 404 for inaccessible projects", async () => {
    const allowed = setup([7]);
    await expect(allowed.service.detail("cookie", 7)).resolves.toEqual({
      project,
      currentUserRole: "MEMBER",
    });
    expect(allowed.find).toHaveBeenCalledWith(7);
    expect(allowed.findActiveMemberRole).toHaveBeenCalledWith(7, 5);

    const denied = setup([9]);
    await expect(denied.service.detail("cookie", 7)).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
    expect(denied.find).not.toHaveBeenCalled();
    expect(denied.findActiveMemberRole).not.toHaveBeenCalled();
  });

  it("maps missing session and missing committed project to safe errors", async () => {
    const anonymous = setup();
    anonymous.resolveActor.mockResolvedValue(undefined);
    await expect(anonymous.service.list(undefined)).rejects.toMatchObject({
      status: 401,
      code: "PROJECT_SESSION_REQUIRED",
    });

    const missing = setup([7]);
    missing.find.mockResolvedValue(undefined);
    await expect(missing.service.detail("cookie", 7)).rejects.toBeInstanceOf(
      ProjectReadServiceError,
    );
  });
});
