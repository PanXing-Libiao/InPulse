import { describe, expect, it, vi } from "vitest";

import { allowProjectMemberPermissions } from "./project-member-permission.helpers.js";

import type { TransactionContext } from "../src/database/transaction-context.js";
import type { ProjectAccessQueryPort } from "../src/modules/projects/project-access.port.js";
import type {
  ActiveUsersQueryPort,
  ProjectsWritePort,
} from "../src/modules/projects/projects-write.port.js";
import type { ProjectMemberTaskCommandPort } from "../src/modules/tasks/project-member-task.command-port.js";
import type { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import { ProjectCapabilityAccessError } from "../src/modules/projects/project-member-permission-policy.service.js";
import { ProjectMemberManagementService } from "../src/modules/projects/project-member-management.service.js";

const tx = {} as TransactionContext;
const project = {
  projectId: 7,
  name: "商城系统",
  status: "ACTIVE" as const,
  rowVersion: 1,
};
const activeMember = {
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
const removedMember = {
  ...activeMember,
  membershipId: 9,
  status: "REMOVED" as const,
  removedAt: "2026-09-09T01:00:00.000Z",
};
const leaderMember = {
  ...activeMember,
  membershipId: 11,
  userId: 6,
  name: "组长",
  role: "LEADER" as const,
};
const unfinishedTask = {
  taskId: 12,
  projectId: 7,
  moduleId: 3,
  featureId: null,
  scopeType: "MODULE" as const,
  code: "P-T-1",
  title: "任务",
  description: "",
  priority: "NORMAL" as const,
  dueAt: null,
  workStatus: "TODO" as const,
  assigneeId: 5,
  rowVersion: 2,
  impactFeatureIds: [],
};

function setup() {
  const projects = {
    findProject: vi.fn().mockResolvedValue(project),
    listMembers: vi.fn().mockResolvedValue([activeMember]),
    findLatestMember: vi.fn().mockResolvedValue(activeMember),
    addMemberHistory: vi.fn().mockResolvedValue(activeMember),
    removeMember: vi.fn().mockResolvedValue(removedMember),
    setMemberRole: vi.fn().mockResolvedValue(activeMember),
  };
  const access = {
    checkProjectForWrite: vi.fn().mockResolvedValue({
      kind: "allowed",
      resource: {
        projectId: 7,
        status: "ACTIVE",
        rowVersion: 1,
        isSystemAdmin: true,
      },
    }),
  };
  const activeUsers = {
    findActiveUserIds: vi.fn().mockResolvedValue([5]),
  };
  const tasks = {
    listUnfinished: vi.fn().mockResolvedValue([unfinishedTask]),
    reassign: vi.fn().mockResolvedValue([12]),
  };
  const roleGate = {
    manageRole: vi.fn().mockResolvedValue("SYSTEM_ADMIN"),
    roleSetterRole: vi.fn().mockResolvedValue("SYSTEM_ADMIN"),
  };
  const audit = {
    append: vi.fn().mockResolvedValue({
      chainId: "PROJECT:7",
      sequenceNo: 1,
      recordHash: Buffer.alloc(32),
    }),
  };
  const activity = { append: vi.fn().mockResolvedValue(undefined) };
  const notifications = { dispatch: vi.fn().mockResolvedValue(1) };
  const service = new ProjectMemberManagementService(
    projects as unknown as ProjectsWritePort,
    activeUsers as unknown as ActiveUsersQueryPort,
    access as unknown as ProjectAccessQueryPort,
    tasks as unknown as ProjectMemberTaskCommandPort,
    roleGate as unknown as ProjectRoleGateService,
    allowProjectMemberPermissions(),
    audit as never,
    activity as never,
    notifications as never,
  );
  return {
    service,
    projects,
    access,
    activeUsers,
    tasks,
    roleGate,
    audit,
    activity,
    notifications,
  };
}

describe("ProjectMemberManagementService", () => {
  it("lists full member history for an existing project", async () => {
    const s = setup();
    const body = await s.service.listMembers(tx, 7, 1);
    expect(body.items).toHaveLength(1);
    expect(s.projects.findProject).toHaveBeenCalledWith(tx, { projectId: 7 });
  });

  it("lists unfinished tasks only for an ACTIVE member", async () => {
    const s = setup();
    await expect(s.service.listUnfinishedTasks(tx, 7, 5, 1)).resolves.toEqual({
      items: [unfinishedTask],
    });
    s.projects.findLatestMember.mockResolvedValueOnce(removedMember);
    await expect(
      s.service.listUnfinishedTasks(tx, 7, 5, 1),
    ).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_MEMBER_NOT_FOUND",
    });
  });

  it("allows member management for any active member and hides projects from non-members", async () => {
    const s = setup();
    s.roleGate.manageRole.mockResolvedValue("MEMBER");
    await expect(s.service.listMembers(tx, 7, 1)).resolves.toMatchObject({
      items: expect.any(Array),
    });
    s.roleGate.manageRole.mockResolvedValue("NOT_MEMBER");
    await expect(s.service.listMembers(tx, 7, 1)).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_MEMBER_NOT_FOUND",
    });
  });

  it("adds a new ACTIVE member with audit/activity/notification in one transaction", async () => {
    const s = setup();
    // ADR-053：项目已有活跃组长，新成员以普通成员身份加入。
    s.projects.listMembers.mockResolvedValue([leaderMember, activeMember]);
    s.projects.findLatestMember.mockResolvedValueOnce(removedMember);
    const result = await s.service.addMember(tx, {
      actorId: 1,
      projectId: 7,
      userId: 5,
      requestId: "req-1",
    });
    expect(result.responseStatus).toBe(200);
    expect(result.body).toMatchObject({
      member: { userId: 5, status: "ACTIVE" },
    });
    expect(s.projects.addMemberHistory).toHaveBeenCalledWith(tx, {
      projectId: 7,
      userId: 5,
      role: "MEMBER",
    });
    expect(s.audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: "project.member.add" }),
    );
    expect(s.activity.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ activityType: "PROJECT_MEMBER_ADDED" }),
    );
    expect(s.notifications.dispatch).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        notificationType: "PROJECT_JOINED",
      }),
      [5],
    );
  });

  it("promotes the first joiner to leader when the project has no active leader (ADR-053)", async () => {
    const s = setup();
    // 默认夹具没有活跃组长（历史数据或夹具清理残留）——加入者直接成为组长。
    s.projects.listMembers.mockResolvedValue([removedMember]);
    s.projects.findLatestMember.mockResolvedValueOnce(removedMember);
    s.projects.addMemberHistory.mockResolvedValue({
      ...activeMember,
      role: "LEADER",
    });
    const result = await s.service.addMember(tx, {
      actorId: 1,
      projectId: 7,
      userId: 5,
      requestId: "req-1b",
    });
    expect(result.responseStatus).toBe(200);
    expect(s.projects.addMemberHistory).toHaveBeenCalledWith(tx, {
      projectId: 7,
      userId: 5,
      role: "LEADER",
    });
    expect(s.activity.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        activityType: "PROJECT_MEMBER_ADDED",
        metadata: expect.objectContaining({ role: "LEADER" }),
      }),
    );
  });

  it("rejects duplicate active member and invalid user without writing", async () => {
    const s = setup();
    s.projects.findLatestMember.mockResolvedValueOnce(activeMember);
    await expect(
      s.service.addMember(tx, {
        actorId: 1,
        projectId: 7,
        userId: 5,
        requestId: "req-2",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_MEMBER_ALREADY_ACTIVE",
    });
    expect(s.projects.addMemberHistory).not.toHaveBeenCalled();

    s.activeUsers.findActiveUserIds.mockResolvedValueOnce([]);
    s.projects.findLatestMember.mockResolvedValueOnce(undefined);
    await expect(
      s.service.addMember(tx, {
        actorId: 1,
        projectId: 7,
        userId: 99,
        requestId: "req-3",
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "PROJECT_MEMBER_USER_INVALID",
    });
  });

  it("removes a member after optional true reassignment and preserves historical owner", async () => {
    const s = setup();
    s.tasks.listUnfinished.mockResolvedValueOnce([]);
    const result = await s.service.removeMember(tx, {
      actorId: 1,
      projectId: 7,
      userId: 5,
      request: {
        reassignments: [
          {
            taskId: 12,
            moduleId: 3,
            featureId: null,
            rowVersion: 2,
            assigneeIds: [6],
          },
        ],
      },
      requestId: "req-4",
    });
    expect(result.responseStatus).toBe(200);
    expect(result.body).toMatchObject({
      member: { status: "REMOVED" },
      reassignedTaskIds: [12],
      unfinishedTaskCount: 0,
    });
    expect(s.tasks.reassign).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ targetUserId: 5 }),
    );
    expect(s.notifications.dispatch).not.toHaveBeenCalled();
    expect(s.audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: "project.member.remove" }),
    );
  });

  it("returns 404 when removing a non-active member", async () => {
    const s = setup();
    s.projects.findLatestMember.mockResolvedValueOnce(removedMember);
    await expect(
      s.service.removeMember(tx, {
        actorId: 1,
        projectId: 7,
        userId: 5,
        request: { reassignments: [] },
        requestId: "req-5",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(s.tasks.reassign).not.toHaveBeenCalled();
  });

  it("refuses to remove the project LEADER (409) until the role is transferred", async () => {
    const s = setup();
    s.projects.findLatestMember.mockResolvedValueOnce({
      ...activeMember,
      role: "LEADER" as const,
    });
    await expect(
      s.service.removeMember(tx, {
        actorId: 1,
        projectId: 7,
        userId: 5,
        request: { reassignments: [] },
        requestId: "req-6",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_MEMBER_LEADER_PROTECTED",
    });
    expect(s.tasks.reassign).not.toHaveBeenCalled();
  });

  it("sets member roles with audit and activity, enforcing setter and transfer gates", async () => {
    const s = setup();
    s.projects.findLatestMember.mockResolvedValueOnce(activeMember);
    s.projects.setMemberRole.mockResolvedValueOnce({
      ...activeMember,
      role: "LEADER" as const,
    });
    const result = await s.service.setRole(tx, {
      actorId: 1,
      projectId: 7,
      userId: 5,
      role: "LEADER",
      requestId: "req-7",
    });
    expect(result.responseStatus).toBe(200);
    expect(result.body).toMatchObject({
      member: { userId: 5, role: "LEADER" },
    });
    expect(s.projects.setMemberRole).toHaveBeenCalledWith(tx, {
      projectId: 7,
      userId: 5,
      role: "LEADER",
    });
    expect(s.audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: "project.member.role.set" }),
    );
    expect(s.activity.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        activityType: "PROJECT_MEMBER_ROLE_CHANGED",
      }),
    );

    // ADR-039：普通成员调用角色任命 -> 403
    s.roleGate.roleSetterRole.mockRejectedValueOnce(
      new ProjectCapabilityAccessError(
        403,
        "PROJECT_MEMBER_ROLE_FORBIDDEN",
        "当前平台权限配置不允许该成员任命或转移项目组长",
        "projectLeaderTransfer",
      ),
    );
    await expect(
      s.service.setRole(tx, {
        actorId: 2,
        projectId: 7,
        userId: 5,
        role: "LEADER",
        requestId: "req-8",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROJECT_MEMBER_ROLE_FORBIDDEN",
    });

    // ADR-053：本项目组长可以转移身份——把其他成员设为组长放行。
    s.projects.setMemberRole.mockResolvedValueOnce({
      ...activeMember,
      role: "LEADER" as const,
    });
    s.roleGate.roleSetterRole.mockResolvedValueOnce("LEADER");
    const transferred = await s.service.setRole(tx, {
      actorId: 3,
      projectId: 7,
      userId: 5,
      role: "LEADER",
      requestId: "req-9",
    });
    expect(transferred.responseStatus).toBe(200);
    expect(transferred.body).toMatchObject({
      member: { userId: 5, role: "LEADER" },
    });

    // ADR-053：组长不能撤销组长，也不能把组长设给自己。
    s.roleGate.roleSetterRole.mockResolvedValueOnce("LEADER");
    await expect(
      s.service.setRole(tx, {
        actorId: 3,
        projectId: 7,
        userId: 5,
        role: "MEMBER",
        requestId: "req-9a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROJECT_MEMBER_ROLE_FORBIDDEN",
    });
    s.roleGate.roleSetterRole.mockResolvedValueOnce("LEADER");
    await expect(
      s.service.setRole(tx, {
        actorId: 5,
        projectId: 7,
        userId: 5,
        role: "LEADER",
        requestId: "req-9b",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROJECT_MEMBER_ROLE_FORBIDDEN",
    });

    // ADR-053：即使系统管理员也不能直接降级现任组长 -> 409
    s.projects.findLatestMember.mockResolvedValueOnce({
      ...activeMember,
      role: "LEADER" as const,
    });
    s.roleGate.roleSetterRole.mockResolvedValueOnce("SYSTEM_ADMIN");
    await expect(
      s.service.setRole(tx, {
        actorId: 1,
        projectId: 7,
        userId: 5,
        role: "MEMBER",
        requestId: "req-9c",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_MEMBER_LEADER_REQUIRED",
    });

    // 唯一组长约束冲突 -> 409
    s.projects.setMemberRole.mockRejectedValueOnce({
      code: "23505",
      constraint_name: "project_members_one_leader",
    });
    await expect(
      s.service.setRole(tx, {
        actorId: 1,
        projectId: 7,
        userId: 5,
        role: "LEADER",
        requestId: "req-10",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_MEMBER_LEADER_CONFLICT",
    });
  });

  it("re-checks project writability before replaying idempotent member writes", async () => {
    const s = setup();
    await expect(
      s.service.replayAuthorizer(
        tx,
        1,
        {
          projectId: 7,
          memberUserId: 5,
        },
        "projectMemberManage",
      ),
    ).resolves.toBeUndefined();
    expect(s.access.checkProjectForWrite).toHaveBeenCalledWith(tx, {
      actorUserId: 1,
      projectId: 7,
    });

    s.access.checkProjectForWrite.mockResolvedValueOnce({
      kind: "not-found",
    });
    await expect(
      s.service.replayAuthorizer(
        tx,
        1,
        {
          projectId: 7,
          memberUserId: 5,
        },
        "projectMemberManage",
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_MEMBER_NOT_FOUND",
    });
  });
});
