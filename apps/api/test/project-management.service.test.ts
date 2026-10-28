import { describe, expect, it, vi } from "vitest";

import type { AuditWritePort } from "../src/audit/audit.port.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { ActivityWritePort } from "../src/modules/activity/activity.write-port.js";
import type { ProjectAccessQueryPort } from "../src/modules/projects/project-access.port.js";
import type { ProjectMembersQueryPort } from "../src/modules/projects/project-members-query.port.js";
import type { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import type { ProjectStartNotifier } from "../src/modules/projects/project-start.notifier.js";
import type { ProjectWrapNotifier } from "../src/modules/projects/project-wrap.notifier.js";
import {
  ProjectManagementService,
  ProjectManagementError,
} from "../src/modules/projects/project-management.service.js";
import type {
  ProjectChangeRecord,
  ProjectWrapRecord,
  ProjectsWritePort,
} from "../src/modules/projects/projects-write.port.js";
import type { SearchProjectionWritePort } from "../src/modules/search/search-projection.write-port.js";
import { allowProjectMemberPermissions } from "./project-member-permission.helpers.js";

const current: ProjectChangeRecord = {
  projectId: 7,
  code: "SHOP",
  name: "商城系统",
  description: "旧描述",
  status: "ACTIVE",
  firstTaskCompletedAt: "2026-09-09T01:00:00.000Z",
  rowVersion: 1,
  createdBy: 5,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 2,
    activeFeatureCount: 1,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

const wrapRecord: ProjectWrapRecord = {
  projectId: 7,
  sealedAt: "2026-09-10T00:00:00.000Z",
  templateVersion: 1,
  snapshot: {
    version: 1,
    project: { id: 7, code: "SHOP", name: "商城系统" },
    stats: {
      completedTaskCount: 5,
      publishedRecordCount: 3,
      activeMemberCount: 2,
      activeModuleCount: 2,
      activeFeatureCount: 1,
      openTaskCount: 0,
      durationDays: 12,
      completionPercent: 100,
    },
    participants: [
      {
        userId: 2,
        name: "成员甲",
        role: "LEADER",
        completedTaskCount: 3,
      },
      {
        userId: 3,
        name: "成员乙",
        role: "MEMBER",
        completedTaskCount: 2,
      },
    ],
    timeline: {
      foundedAt: "2026-08-30T00:00:00.000Z",
      firstRecordAt: "2026-09-01T00:00:00.000Z",
      lastTaskCompletedAt: "2026-09-09T01:00:00.000Z",
      sealedAt: "2026-09-10T00:00:00.000Z",
    },
  },
};

const tx = {} as unknown as TransactionContext;

function setup(
  check: Awaited<ReturnType<ProjectAccessQueryPort["checkProjectForWrite"]>> = {
    kind: "allowed",
    resource: {
      projectId: 7,
      status: "ACTIVE",
      rowVersion: 1,
      isSystemAdmin: false,
    },
  },
  found: ProjectChangeRecord | undefined = current,
  statusUpdated: ProjectChangeRecord | undefined = {
    ...current,
    status: "MAINTENANCE",
    rowVersion: 1,
    updatedAt: "2026-09-10T00:00:00.000Z",
  },
) {
  const checkProjectForWrite = vi.fn().mockResolvedValue(check);
  const findProjectForChange = vi.fn().mockResolvedValue(found);
  const updateProjectDetails = vi.fn().mockResolvedValue({
    ...current,
    name: "商城系统二期",
    description: "新描述",
    rowVersion: 2,
    updatedAt: "2026-09-10T00:00:00.000Z",
  });
  const updateProjectStatus = vi.fn().mockResolvedValue(statusUpdated);
  const createProjectWrap = vi.fn().mockResolvedValue(wrapRecord);
  const countOpenTasks = vi.fn().mockResolvedValue(0);
  const appendAudit = vi
    .fn()
    .mockResolvedValue({ chainId: "chain-1", sequenceNo: 4 });
  const appendActivity = vi.fn().mockResolvedValue(undefined);
  const upsertSearch = vi.fn().mockResolvedValue(undefined);
  const findActiveRole = vi.fn().mockResolvedValue("LEADER");
  const listActiveMemberIds = vi.fn().mockResolvedValue([2, 3]);
  const manageRole = vi.fn().mockResolvedValue("LEADER");
  const notifyProjectStarted = vi.fn().mockResolvedValue(undefined);
  const notifyProjectWrapped = vi.fn().mockResolvedValue(undefined);
  const permissions = allowProjectMemberPermissions();
  const service = new ProjectManagementService(
    {
      findProjectForChange,
      updateProjectDetails,
      updateProjectStatus,
      createProjectWrap,
      countOpenTasks,
    } as unknown as ProjectsWritePort,
    { checkProjectForWrite } as unknown as ProjectAccessQueryPort,
    { append: appendAudit } as unknown as AuditWritePort,
    { append: appendActivity } as unknown as ActivityWritePort,
    { upsert: upsertSearch } as unknown as SearchProjectionWritePort,
    {
      findActiveRole,
      listActiveMemberIds,
    } as unknown as ProjectMembersQueryPort,
    { manageRole } as unknown as ProjectRoleGateService,
    permissions,
    { notify: notifyProjectStarted } as unknown as ProjectStartNotifier,
    { notify: notifyProjectWrapped } as unknown as ProjectWrapNotifier,
  );
  return {
    service,
    checkProjectForWrite,
    findProjectForChange,
    updateProjectDetails,
    updateProjectStatus,
    createProjectWrap,
    countOpenTasks,
    appendAudit,
    appendActivity,
    upsertSearch,
    findActiveRole,
    notifyProjectWrapped,
    permissions,
  };
}

describe("ProjectManagementService", () => {
  it("edits the project, locks the row and writes audit, activity and search in one transaction", async () => {
    const s = setup();
    const result = await s.service.updateProject(tx, {
      actorId: 5,
      projectId: 7,
      version: 1,
      edit: { name: "商城系统二期", description: "新描述" },
      requestId: "req-1",
    });

    expect(s.checkProjectForWrite).toHaveBeenCalledWith(tx, {
      actorUserId: 5,
      projectId: 7,
    });
    expect(s.findProjectForChange).toHaveBeenCalledWith(
      tx,
      { projectId: 7 },
      true,
    );
    expect(s.updateProjectDetails).toHaveBeenCalledWith(tx, {
      projectId: 7,
      expectedRowVersion: 1,
      name: "商城系统二期",
      description: "新描述",
    });
    expect(s.appendAudit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: "project.update",
        targetType: "PROJECT",
        targetId: "7",
        requestId: "req-1",
        eventPayload: {
          before: { name: "商城系统", description: "旧描述", rowVersion: 1 },
          after: {
            name: "商城系统二期",
            description: "新描述",
            rowVersion: 2,
          },
        },
      }),
    );
    expect(s.appendActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sourceEntityType: "PROJECT",
        sourceEntityId: 7,
        activityType: "PROJECT_UPDATED",
        sourceRowVersion: 2,
      }),
    );
    expect(s.upsertSearch).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        entityType: "PROJECT",
        entityId: 7,
        title: "商城系统二期",
        sourceStatus: "ACTIVE",
        sourceRowVersion: 2,
      }),
    );
    expect(result.project).toMatchObject({
      id: 7,
      name: "商城系统二期",
      rowVersion: 2,
    });
    // ADR-033：写命令响应携带当前用户的项目内角色。
    expect(result.currentUserRole).toBe("LEADER");
    expect(s.findActiveRole).toHaveBeenCalledWith(tx, {
      projectId: 7,
      userId: 5,
    });
  });

  it("rejects stale versions before writing anything", async () => {
    const s = setup(undefined, {
      ...current,
      rowVersion: 3,
    });
    await expect(
      s.service.updateProject(tx, {
        actorId: 5,
        projectId: 7,
        version: 1,
        edit: { name: "过期编辑", description: "" },
        requestId: "req-2",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_VERSION_CONFLICT",
    });
    expect(s.updateProjectDetails).not.toHaveBeenCalled();
    expect(s.appendAudit).not.toHaveBeenCalled();
  });

  it("rejects missing projects and validates replay context", async () => {
    const missing = setup({ kind: "not-found" });
    await expect(
      missing.service.updateProject(tx, {
        actorId: 5,
        projectId: 7,
        version: 1,
        edit: { name: "x", description: "" },
        requestId: "req-3",
      }),
    ).rejects.toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });

    await expect(
      missing.service.replay(tx, 5, { projectId: "not-a-number" }),
    ).rejects.toThrow();
    await expect(
      missing.service.replay(tx, 5, { projectId: 7 }),
    ).rejects.toBeInstanceOf(ProjectManagementError);
  });

  it("把项目切换为维护中：首次封箱写快照、动态、搜索投影与个人通知", async () => {
    const s = setup();
    const result = await s.service.changeProjectStatus(tx, {
      actorId: 9,
      projectId: 7,
      version: 1,
      target: "MAINTENANCE",
      requestId: "req-status",
    });

    expect(s.checkProjectForWrite).toHaveBeenCalledWith(tx, {
      actorUserId: 9,
      projectId: 7,
    });
    expect(s.permissions.assertCapabilities).toHaveBeenCalledWith(tx, {
      actorUserId: 9,
      projectId: 7,
      capabilities: ["projectEdit"],
    });
    expect(s.countOpenTasks).toHaveBeenCalledWith(tx, { projectId: 7 });
    expect(s.updateProjectStatus).toHaveBeenCalledWith(tx, {
      projectId: 7,
      expectedRowVersion: 1,
      status: "MAINTENANCE",
    });
    expect(s.createProjectWrap).toHaveBeenCalledWith(tx, {
      projectId: 7,
      actorId: 9,
      sealedAt: expect.any(Date),
    });
    expect(s.appendAudit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: "project.status.change",
        requestId: "req-status",
        eventPayload: expect.objectContaining({
          wrapped: true,
          wrapTemplateVersion: 1,
        }),
      }),
    );
    expect(s.appendActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        activityType: "PROJECT_WRAPPED",
        sourceRowVersion: 1,
        summary: expect.stringContaining("项目封箱"),
      }),
    );
    expect(s.upsertSearch).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sourceStatus: "MAINTENANCE",
        sourceRowVersion: 1,
      }),
    );
    expect(s.notifyProjectWrapped).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        projectId: 7,
        chainId: "chain-1",
        sequenceNo: 4,
        snapshot: wrapRecord.snapshot,
      }),
    );
    expect(result.project).toMatchObject({
      status: "MAINTENANCE",
      rowVersion: 1,
    });
  });

  it("再次进入维护中不重复封箱，只写普通状态动态", async () => {
    const s = setup();
    s.createProjectWrap.mockResolvedValueOnce(undefined);
    await s.service.changeProjectStatus(tx, {
      actorId: 9,
      projectId: 7,
      version: 1,
      target: "MAINTENANCE",
      requestId: "req-status-again",
    });
    expect(s.appendActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ activityType: "PROJECT_STATUS_CHANGED" }),
    );
    expect(s.notifyProjectWrapped).not.toHaveBeenCalled();
  });

  it("维护中门禁：仍有未收尾任务时拒绝进入维护中且不写任何副作用", async () => {
    const s = setup();
    s.countOpenTasks.mockResolvedValueOnce(2);
    await expect(
      s.service.changeProjectStatus(tx, {
        actorId: 9,
        projectId: 7,
        version: 1,
        target: "MAINTENANCE",
        requestId: "req-gate",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_MAINTENANCE_TASKS_OPEN",
    });
    expect(s.updateProjectStatus).not.toHaveBeenCalled();
    expect(s.appendAudit).not.toHaveBeenCalled();
    expect(s.appendActivity).not.toHaveBeenCalled();
  });

  it("未开始与维护中禁止越级互改，目标态与当前态相同返回 409", async () => {
    const notStarted = setup(undefined, {
      ...current,
      status: "NOT_STARTED",
      firstTaskCompletedAt: null,
    });
    await expect(
      notStarted.service.changeProjectStatus(tx, {
        actorId: 9,
        projectId: 7,
        version: 1,
        target: "MAINTENANCE",
        requestId: "req-skip",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_STATUS_LEVEL_SKIP",
    });
    expect(notStarted.countOpenTasks).not.toHaveBeenCalled();

    const same = setup();
    await expect(
      same.service.changeProjectStatus(tx, {
        actorId: 9,
        projectId: 7,
        version: 1,
        target: "ACTIVE",
        requestId: "req-same",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_STATE_CONFLICT",
    });
  });
});
