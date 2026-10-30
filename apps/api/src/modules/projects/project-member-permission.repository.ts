import { Injectable } from "@nestjs/common";
import type {
  ProjectMemberPermissionCapability,
  ProjectMemberPermissionLevel,
  ProjectMemberPermissions,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";

export interface ProjectMemberPermissionSettingsRecord {
  readonly projectEdit: ProjectMemberPermissionLevel;
  readonly projectMemberManage: ProjectMemberPermissionLevel;
  readonly projectLeaderTransfer: ProjectMemberPermissionLevel;
  readonly projectDelete: ProjectMemberPermissionLevel;
  readonly projectDocumentImport: ProjectMemberPermissionLevel;
  readonly moduleEdit: ProjectMemberPermissionLevel;
  readonly moduleDelete: ProjectMemberPermissionLevel;
  readonly taskEdit: ProjectMemberPermissionLevel;
  readonly taskLifecycle: ProjectMemberPermissionLevel;
  readonly recordWrite: ProjectMemberPermissionLevel;
  readonly projectWecomGroup: ProjectMemberPermissionLevel;
  readonly rowVersion: number;
  readonly updatedAt: string | null;
  readonly updatedByName: string | null;
}

interface SettingsRow {
  readonly projectEdit: ProjectMemberPermissionLevel;
  readonly projectMemberManage: ProjectMemberPermissionLevel;
  readonly projectLeaderTransfer: ProjectMemberPermissionLevel;
  readonly projectDelete: ProjectMemberPermissionLevel;
  readonly projectDocumentImport: ProjectMemberPermissionLevel;
  readonly moduleEdit: ProjectMemberPermissionLevel;
  readonly moduleDelete: ProjectMemberPermissionLevel;
  readonly taskEdit: ProjectMemberPermissionLevel;
  readonly taskLifecycle: ProjectMemberPermissionLevel;
  readonly recordWrite: ProjectMemberPermissionLevel;
  readonly projectWecomGroup: ProjectMemberPermissionLevel;
  readonly rowVersion: number;
  readonly updatedAt: string | Date | null;
  readonly updatedByName: string | null;
}

export interface UpdateProjectMemberPermissionsInput {
  readonly values: Readonly<
    Record<ProjectMemberPermissionCapability, ProjectMemberPermissionLevel>
  >;
  readonly expectedRowVersion: number;
  readonly actorId: number;
}

const toRecord = (row: SettingsRow): ProjectMemberPermissionSettingsRecord => ({
  projectEdit: row.projectEdit,
  projectMemberManage: row.projectMemberManage,
  projectLeaderTransfer: row.projectLeaderTransfer,
  projectDelete: row.projectDelete,
  projectDocumentImport: row.projectDocumentImport,
  moduleEdit: row.moduleEdit,
  moduleDelete: row.moduleDelete,
  taskEdit: row.taskEdit,
  taskLifecycle: row.taskLifecycle,
  recordWrite: row.recordWrite,
  projectWecomGroup: row.projectWecomGroup,
  rowVersion: row.rowVersion,
  updatedAt:
    row.updatedAt === null ? null : new Date(row.updatedAt).toISOString(),
  updatedByName: row.updatedByName,
});

/** ADR-104 单行全局配置仓储；读路径可按写命令要求取得显式行锁。 */
@Injectable()
export class ProjectMemberPermissionRepository {
  async find(
    tx: TransactionContext,
    forUpdate = false,
  ): Promise<ProjectMemberPermissionSettingsRecord | undefined> {
    const [row] = await tx.sql<SettingsRow[]>`
      SELECT project_edit AS "projectEdit",
             project_member_manage AS "projectMemberManage",
             project_leader_transfer AS "projectLeaderTransfer",
             project_delete AS "projectDelete",
             project_document_import AS "projectDocumentImport",
             module_edit AS "moduleEdit",
             module_delete AS "moduleDelete",
             task_edit AS "taskEdit",
             task_lifecycle AS "taskLifecycle",
             record_write AS "recordWrite",
             project_wecom_group AS "projectWecomGroup",
             row_version AS "rowVersion",
             updated_at AS "updatedAt",
             updated_by_snapshot->>'name' AS "updatedByName"
        FROM app.project_member_permission_settings
       WHERE id = 1
       ${forUpdate ? tx.sql`FOR UPDATE` : tx.sql``}
    `;
    return row === undefined ? undefined : toRecord(row);
  }

  async update(
    tx: TransactionContext,
    input: UpdateProjectMemberPermissionsInput,
  ): Promise<boolean> {
    const values = input.values;
    const rows = (await tx.sql`
      UPDATE app.project_member_permission_settings
         SET project_edit = ${values.projectEdit},
             project_member_manage = ${values.projectMemberManage},
             project_leader_transfer = ${values.projectLeaderTransfer},
             project_delete = ${values.projectDelete},
             project_document_import = ${values.projectDocumentImport},
             module_edit = ${values.moduleEdit},
             module_delete = ${values.moduleDelete},
             task_edit = ${values.taskEdit},
             task_lifecycle = ${values.taskLifecycle},
             record_write = ${values.recordWrite},
             project_wecom_group = ${values.projectWecomGroup},
             updated_by = ${input.actorId},
             updated_at = now(),
             row_version = row_version + 1
       WHERE id = 1
         AND row_version = ${input.expectedRowVersion}
       RETURNING id
    `) as unknown as readonly { readonly id: number }[];
    return rows.length === 1;
  }
}

export function projectMemberPermissionToContract(
  record: ProjectMemberPermissionSettingsRecord,
): ProjectMemberPermissions {
  return {
    projectEdit: record.projectEdit,
    projectMemberManage: record.projectMemberManage,
    projectLeaderTransfer: record.projectLeaderTransfer,
    projectDelete: record.projectDelete,
    projectDocumentImport: record.projectDocumentImport,
    moduleEdit: record.moduleEdit,
    moduleDelete: record.moduleDelete,
    taskEdit: record.taskEdit,
    taskLifecycle: record.taskLifecycle,
    recordWrite: record.recordWrite,
    projectWecomGroup: record.projectWecomGroup,
    rowVersion: record.rowVersion,
    updatedAt: record.updatedAt,
    updatedByName: record.updatedByName,
  };
}
