import React, { useEffect, useRef, useState } from "react";
import { Button } from "antd";
import { formatBeijingMinute } from "@features/common/beijing-time";
import { CalmBadge, CalmSectionTitle } from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import type {
  InpulseApiClient,
  ProjectMemberPermissionLevel,
  ProjectMemberPermissions,
  ProjectMemberPermissionsUpdateRequest,
} from "@generated/api";
import {
  projectMemberPermissionsErrorMessage,
  useProjectMemberPermissions,
} from "./member-permissions-query";
import {
  permissionMatrixRows,
  projectMemberPermissionCapabilities,
  projectMemberPermissionLevelLabels,
  projectMemberPermissionLevelOptions,
  type ConfigurablePermissionKey,
  type PermissionMatrixRow,
} from "./settings-content";

export interface PermissionMatrixPanelProps {
  readonly client?: InpulseApiClient | undefined;
  readonly isAdmin?: boolean | undefined;
}

function editableLevels(
  settings: ProjectMemberPermissions,
): ProjectMemberPermissionsUpdateRequest {
  return {
    projectEdit: settings.projectEdit,
    projectMemberManage: settings.projectMemberManage,
    projectLeaderTransfer: settings.projectLeaderTransfer,
    projectDelete: settings.projectDelete,
    projectDocumentImport: settings.projectDocumentImport,
    moduleEdit: settings.moduleEdit,
    moduleDelete: settings.moduleDelete,
    taskEdit: settings.taskEdit,
    taskLifecycle: settings.taskLifecycle,
    recordWrite: settings.recordWrite,
    projectWecomGroup: settings.projectWecomGroup,
  };
}

function fixedBadge(row: PermissionMatrixRow): React.ReactNode {
  if (row.fixedAccess === "ALL_MEMBERS") {
    return <CalmBadge tone="green">固定开放</CalmBadge>;
  }
  return (
    <CalmBadge tone="amber" title="任何项目成员（含组长）都不能执行">
      仅系统管理员
    </CalmBadge>
  );
}

/**
 * ADR-104：全平台统一的项目成员权限矩阵。系统管理员修改 11 项三档配置；
 * 固定开放与固定管理员项不进入配置。普通成员只能查看当前生效策略。
 */
export const PermissionMatrixPanel: React.FC<PermissionMatrixPanelProps> = ({
  client,
  isAdmin = false,
}) => {
  const { query, save } = useProjectMemberPermissions(client);
  const [draft, setDraft] =
    useState<ProjectMemberPermissionsUpdateRequest | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const appliedVersion = useRef<number | null>(null);

  const settings = query.data;
  useEffect(() => {
    if (
      settings === undefined ||
      appliedVersion.current === settings.rowVersion
    ) {
      return;
    }
    appliedVersion.current = settings.rowVersion;
    setDraft(editableLevels(settings));
  }, [settings]);

  const dirty =
    settings !== undefined &&
    draft !== null &&
    projectMemberPermissionCapabilities.some(
      (key) => draft[key] !== settings[key],
    );

  const updateCapability = (
    key: ConfigurablePermissionKey,
    level: ProjectMemberPermissionLevel,
  ): void => {
    setSaved(null);
    save.reset();
    setDraft((current) =>
      current === null ? current : { ...current, [key]: level },
    );
  };

  const resetDraft = (): void => {
    if (settings === undefined) return;
    save.reset();
    setSaved(null);
    setDraft(editableLevels(settings));
  };

  const reload = (): void => {
    save.reset();
    setSaved(null);
    void query.refetch();
  };

  const submit = async (): Promise<void> => {
    if (settings === undefined || draft === null || !dirty) return;
    setSaved(null);
    save.reset();
    try {
      await save.mutateAsync({
        values: draft,
        expectedRowVersion: settings.rowVersion,
      });
      setSaved("全平台权限配置已保存，下一次请求立即按新配置校验。");
    } catch {
      // 失败详情由 save.error 统一渲染。
    }
  };

  return (
    <section
      className="panel settings-panel table-panel permission-matrix-panel"
      aria-label="权限矩阵"
    >
      <CalmSectionTitle title="权限矩阵" />

      <div className="permission-matrix-intro permission-note">
        <InpulseIcon name="shield" size={17} />
        <span>
          <strong>全平台统一配置</strong>
          修改后下一次请求立即生效，不按项目单独设置。查看项目与动态、创建项目、
          个人设置与通知、个人企业微信绑定、整项目导入固定开放；迭代记录作废/恢复
          与系统管理固定仅系统管理员。
        </span>
      </div>

      {query.isPending ? (
        <CalmSkeleton
          variant="list"
          rows={8}
          compact
          label="正在加载全平台权限配置"
        />
      ) : null}

      {query.isError ? (
        <div className="permission-matrix-load-error">
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={17} />
            <span>{projectMemberPermissionsErrorMessage(query.error)}</span>
          </div>
          <Button size="small" onClick={reload}>
            重新加载
          </Button>
        </div>
      ) : null}

      {settings !== undefined ? (
        <>
          <div className="table-wrap">
            <table className="settings-table permission-matrix-table">
              <caption className="sr-only">全平台项目成员权限矩阵</caption>
              <thead>
                <tr>
                  <th scope="col">权限能力</th>
                  <th scope="col">权限范围</th>
                  <th scope="col">规则说明</th>
                </tr>
              </thead>
              <tbody>
                {permissionMatrixRows.map((row) => {
                  const level =
                    row.capability === undefined
                      ? undefined
                      : (draft ?? settings)[row.capability];
                  return (
                    <tr key={row.key}>
                      <td>
                        <strong>{row.capabilityLabel}</strong>
                      </td>
                      <td className="permission-cell permission-level-cell">
                        {row.fixedAccess !== undefined ? (
                          fixedBadge(row)
                        ) : isAdmin && row.capability !== undefined ? (
                          <CalmSelect
                            ariaLabel={row.capabilityLabel + "权限范围"}
                            appearance="menu"
                            width={176}
                            value={level}
                            options={projectMemberPermissionLevelOptions}
                            disabled={save.isPending}
                            onChange={(next) => {
                              if (typeof next !== "string") return;
                              const option =
                                projectMemberPermissionLevelOptions.find(
                                  (candidate) => candidate.value === next,
                                );
                              if (option === undefined) return;
                              updateCapability(row.capability!, option.value);
                            }}
                          />
                        ) : (
                          <CalmBadge tone="blue">
                            {level === undefined
                              ? "—"
                              : projectMemberPermissionLevelLabels[level]}
                          </CalmBadge>
                        )}
                      </td>
                      <td>
                        <small>{row.note}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="permission-matrix-actions">
            <span className="permission-matrix-saved-at">
              {settings.updatedAt === null
                ? "尚未由管理员保存，当前为上线默认值"
                : "最近保存 " +
                  formatBeijingMinute(settings.updatedAt) +
                  (settings.updatedByName === null
                    ? ""
                    : " · " + settings.updatedByName)}
            </span>
            {isAdmin ? (
              <span className="permission-matrix-action-buttons">
                <Button
                  onClick={resetDraft}
                  disabled={!dirty || save.isPending}
                >
                  撤销未保存修改
                </Button>
                <Button
                  type="primary"
                  onClick={() => void submit()}
                  loading={save.isPending}
                  disabled={!dirty}
                >
                  保存权限配置
                </Button>
              </span>
            ) : (
              <CalmBadge tone="gray">当前账号只读</CalmBadge>
            )}
          </div>
        </>
      ) : null}

      {saved !== null ? (
        <div className="permission-note note-success" role="status">
          <InpulseIcon name="check" size={16} />
          <span>{saved}</span>
        </div>
      ) : null}

      {save.isError ? (
        <div className="permission-matrix-save-error">
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={16} />
            <span>{projectMemberPermissionsErrorMessage(save.error)}</span>
          </div>
          <Button size="small" onClick={reload}>
            重新加载最新配置
          </Button>
        </div>
      ) : null}
    </section>
  );
};

export default PermissionMatrixPanel;
