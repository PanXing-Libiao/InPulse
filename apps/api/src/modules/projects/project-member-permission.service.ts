import { Inject, Injectable } from "@nestjs/common";
import type {
  ProjectMemberPermissions,
  ProjectMemberPermissionsUpdateRequest,
} from "@inpulse/api-contract";

import { AuditWritePort } from "../../audit/index.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  ProjectMemberPermissionRepository,
  projectMemberPermissionToContract,
  type ProjectMemberPermissionSettingsRecord,
} from "./project-member-permission.repository.js";

export class ProjectMemberPermissionError extends Error {
  constructor(
    readonly status: 409 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectMemberPermissionError";
  }
}

const versionConflict = () =>
  new ProjectMemberPermissionError(
    409,
    "PROJECT_MEMBER_PERMISSION_VERSION_CONFLICT",
    "全平台权限配置已被其他管理员修改，请重新加载后再保存",
  );

const missingSettings = () =>
  new ProjectMemberPermissionError(
    500,
    "PROJECT_MEMBER_PERMISSION_CONFIG_MISSING",
    "全平台权限配置缺失，请检查数据库迁移",
  );

const levelsOf = (
  record: ProjectMemberPermissionSettingsRecord,
): ProjectMemberPermissionsUpdateRequest => ({
  projectEdit: record.projectEdit,
  projectMemberManage: record.projectMemberManage,
  projectLeaderTransfer: record.projectLeaderTransfer,
  projectDelete: record.projectDelete,
  projectDocumentImport: record.projectDocumentImport,
  moduleFeatureEdit: record.moduleFeatureEdit,
  moduleFeatureDelete: record.moduleFeatureDelete,
  taskEdit: record.taskEdit,
  taskLifecycle: record.taskLifecycle,
  recordWrite: record.recordWrite,
  projectWecomGroup: record.projectWecomGroup,
});

/**
 * ADR-104：全平台项目成员权限单行配置。读路径供所有登录用户只读展示；
 * 写路径只由完整管理员 Session 进入，行锁、版本校验、更新与审计同事务。
 */
@Injectable()
export class ProjectMemberPermissionService {
  constructor(
    @Inject(ProjectMemberPermissionRepository)
    private readonly repository: ProjectMemberPermissionRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
  ) {}

  async get(tx: TransactionContext): Promise<ProjectMemberPermissions> {
    const current = await this.repository.find(tx);
    if (current === undefined) throw missingSettings();
    return projectMemberPermissionToContract(current);
  }

  async update(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly expectedRowVersion: number;
      readonly values: ProjectMemberPermissionsUpdateRequest;
      readonly requestId: string;
    },
  ): Promise<ProjectMemberPermissions> {
    const current = await this.repository.find(tx, true);
    if (current === undefined) throw missingSettings();
    if (current.rowVersion !== input.expectedRowVersion) {
      throw versionConflict();
    }
    const updated = await this.repository.update(tx, {
      values: input.values,
      expectedRowVersion: input.expectedRowVersion,
      actorId: input.actorId,
    });
    if (!updated) throw versionConflict();
    const after = await this.repository.find(tx);
    if (after === undefined) throw missingSettings();

    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: input.actorId,
      action: "admin.projectMemberPermissions.update",
      targetType: "PROJECT_MEMBER_PERMISSION_SETTINGS",
      targetId: "1",
      eventPayload: {
        before: levelsOf(current),
        after: levelsOf(after),
        previousRowVersion: current.rowVersion,
        rowVersion: after.rowVersion,
      },
      requestId: input.requestId,
    });
    return projectMemberPermissionToContract(after);
  }

  /** 幂等重放前复核单行配置仍存在；管理员身份由 HTTP 层重新验证。 */
  async replay(tx: TransactionContext): Promise<void> {
    const current = await this.repository.find(tx);
    if (current === undefined) throw missingSettings();
  }
}
