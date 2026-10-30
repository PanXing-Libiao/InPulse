import React, { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Typography } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { CalmBadge, CalmSegmented } from "@features/common/components/Calm";
import {
  projectLifecycleLabel,
  projectLifecycleTone,
} from "@features/common/resource-lifecycle";
import { Controller, useForm } from "react-hook-form";
import type { InpulseApiClient, ProjectItem } from "@generated/api";
import {
  describeProjectManagementError,
  useChangeProjectStatus,
  useDeleteProject,
  useUpdateProject,
} from "./project-management-query";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  projectEditFormSchema,
  type ProjectEditFormValues,
} from "./project-form";

const { Text } = Typography;

/** ADR-043：可手动切换的三个目标状态就是项目的全部状态，归档已下线。 */
export type ProjectLifecycleTarget = "NOT_STARTED" | "ACTIVE" | "MAINTENANCE";

export interface EditProjectModalProps {
  readonly open: boolean;
  readonly project: ProjectItem;
  readonly client?: InpulseApiClient | undefined;
  readonly onClose: () => void;
  readonly onUpdated: (updated: ProjectItem) => void;
  /**
   * ADR-039：调用方按「系统管理员或本项目任意活跃成员」判定后传入，
   * 默认 false 只展示当前状态标签。服务端仍会二次校验同一条件。
   */
  readonly canChangeStatus?: boolean | undefined;
  /**
   * ADR-062：只有本项目组长（实时成员关系中的 ACTIVE LEADER）或系统管理员
   * 可以删除项目。调用方按 `canDeleteProject` 判定后传入，默认 false 就不渲染
   * 危险区；服务端 `projectDeleterRole` 会用同一口径二次判定。
   */
  readonly canDeleteProject?: boolean | undefined;
  /** 删除成功（204）后通知调用方：列表页刷新即可，项目页需要离开该路由。 */
  readonly onDeleted?: (() => void) | undefined;
}

/** F-06.1 前端编辑入口；编码不可修改，保存走 If-Match 乐观锁。 */
export const EditProjectModal: React.FC<EditProjectModalProps> = ({
  open,
  project,
  client,
  onClose,
  onUpdated,
  canChangeStatus = false,
  canDeleteProject = false,
  onDeleted,
}) => {
  const {
    control,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    formState: { errors, isDirty: fieldsDirty },
  } = useForm<ProjectEditFormValues>({
    defaultValues: { name: project.name, description: project.description },
  });
  const mutation = useUpdateProject(project.id, client);
  const statusMutation = useChangeProjectStatus(project.id, client);
  const deleteMutation = useDeleteProject(project.id, client);
  const formId = React.useId();
  const [statusDraft, setStatusDraft] = useState<ProjectLifecycleTarget | null>(
    null,
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [baseProject, setBaseProject] = useState(project);

  useEffect(() => {
    if (open) {
      reset({ name: project.name, description: project.description });
      setBaseProject(project);
      mutation.reset();
      setStatusDraft(null);
      statusMutation.reset();
      deleteMutation.reset();
      setDeleteConfirmOpen(false);
    }
  }, [open, project.id, project.name, project.description]);

  // ADR-043：项目只有未开始 / 进行中 / 维护中三态，不存在只读锁定态。
  const canEditStatus = canChangeStatus;
  const currentStatus: ProjectLifecycleTarget = baseProject.status;
  const statusValue = statusDraft ?? currentStatus;
  const statusDirty = statusValue !== currentStatus;
  const saving = mutation.isPending || statusMutation.isPending;

  const statusOptions = (
    [
      { value: "NOT_STARTED", label: "未开始" },
      { value: "ACTIVE", label: "进行中" },
      { value: "MAINTENANCE", label: "维护中" },
    ] as const
  ).map((option) => {
    const backToNotStarted = option.value === "NOT_STARTED";
    const skipLevel =
      (backToNotStarted && baseProject.status === "MAINTENANCE") ||
      (option.value === "MAINTENANCE" && baseProject.status === "NOT_STARTED");
    const blockedByCompletedTask =
      backToNotStarted && baseProject.hasCompletedTask;
    return {
      value: option.value,
      label: option.label,
      disabled: saving || blockedByCompletedTask || skipLevel,
      title: blockedByCompletedTask
        ? "项目里已经出现过已完成任务，不能再退回未开始"
        : skipLevel
          ? "未开始与维护中不能直接互相切换，请先切到进行中"
          : undefined,
    };
  });

  const statusHint = !canChangeStatus
    ? "只有本项目活跃成员或系统管理员可以更改项目状态。"
    : "未开始 ⇄ 进行中 ⇄ 维护中；未开始与维护中不能直接互改；切到维护中要求项目下任务全部收尾。" +
      (baseProject.hasCompletedTask
        ? "项目里已有完成任务，因此不能再退回未开始。"
        : "");

  const submit = async (values: ProjectEditFormValues) => {
    const parsed = projectEditFormSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "name" || field === "description") {
          setError(field, { message: issue.message });
        }
      }
      return;
    }

    const fieldsChanged =
      parsed.data.name !== baseProject.name ||
      parsed.data.description !== baseProject.description;
    const statusChanged = canEditStatus && statusDirty;
    if (!fieldsChanged && !statusChanged) {
      onClose();
      return;
    }

    mutation.reset();
    statusMutation.reset();
    let current = baseProject;
    try {
      if (fieldsChanged) {
        const updated = await mutation.mutateAsync({
          edit: {
            name: parsed.data.name,
            description: parsed.data.description,
          },
          rowVersion: current.rowVersion,
        });
        current = updated.project;
        setBaseProject(current);
        reset({
          name: current.name,
          description: current.description,
        });
      }
      if (statusChanged) {
        const updated = await statusMutation.mutateAsync({
          status: statusValue,
          rowVersion: current.rowVersion,
        });
        current = updated.project;
        setBaseProject(current);
      }
      onUpdated(current);
      onClose();
    } catch {
      // mutation.error / statusMutation.error 负责展示；字段保存成功后
      // baseProject 已更新，重试状态时不会复用旧版本号。
    }
  };

  const submitDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ rowVersion: project.rowVersion });
      setDeleteConfirmOpen(false);
      onDeleted?.();
    } catch {
      // deleteMutation.error 负责展示，确认弹窗保持打开以便重试。
    }
  };

  return (
    <>
      <Modal
        className="catalog-modal"
        title="编辑项目"
        destroyOnHidden
        mask={{ closable: false }}
        open={open}
        onCancel={() => {
          if (!mutation.isPending) onClose();
        }}
        footer={
          <>
            {/* ADR-062：删除入口只对系统管理员与本项目组长渲染，放在页脚最左侧
                与常规的取消/保存分开；后果说明与级联范围由二次确认弹窗承担。 */}
            {canDeleteProject ? (
              <Button
                className="danger-button footer-leading"
                data-testid="delete-project-button"
                disabled={saving}
                onClick={() => {
                  deleteMutation.reset();
                  setDeleteConfirmOpen(true);
                }}
              >
                删除项目
              </Button>
            ) : null}
            <Button disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              form={formId}
              loading={saving}
              disabled={!fieldsDirty && !statusDirty}
            >
              保存修改
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="catalog-form calm-form"
          onSubmit={handleSubmit((values) => void submit(values))}
          noValidate
        >
          <Form component={false} layout="vertical" requiredMark={false}>
            <div className="dialog-form">
              <Form.Item label="项目编码">
                <Input value={project.code} disabled aria-label="项目编码" />
              </Form.Item>
              <Controller
                name="name"
                control={control}
                render={({ field }) => (
                  <Form.Item
                    label="项目名称"
                    required
                    validateStatus={errors.name ? "error" : ""}
                    help={errors.name?.message ?? ""}
                  >
                    <Input
                      {...field}
                      aria-label="项目名称"
                      maxLength={PROJECT_NAME_MAX_LENGTH}
                      disabled={saving}
                      onChange={(event) => {
                        field.onChange(event.currentTarget.value);
                        clearErrors("name");
                      }}
                    />
                  </Form.Item>
                )}
              />
              <Controller
                name="description"
                control={control}
                render={({ field }) => (
                  <Form.Item
                    label="项目描述"
                    validateStatus={errors.description ? "error" : ""}
                    help={errors.description?.message ?? ""}
                  >
                    <Input.TextArea
                      {...field}
                      aria-label="项目描述"
                      rows={4}
                      maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                      disabled={saving}
                      onChange={(event) => {
                        field.onChange(event.currentTarget.value);
                        clearErrors("description");
                      }}
                    />
                  </Form.Item>
                )}
              />
              <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                编码创建后不可修改，仅用于溯源；保存成功后项目版本递增，
                其他页面的编辑需要重新加载最新版本。
              </Text>
              {mutation.error ? (
                <Alert
                  showIcon
                  type="error"
                  title={describeProjectManagementError(
                    mutation.error,
                    "update",
                  )}
                  style={{ marginTop: 16 }}
                />
              ) : null}
            </div>
            <div className="dialog-form project-status-section">
              <Form.Item label="项目状态">
                <div className="project-status-control">
                  {canEditStatus ? (
                    <CalmSegmented
                      label="项目状态"
                      value={statusValue}
                      options={statusOptions}
                      onChange={(next) => {
                        if (saving) return;
                        statusMutation.reset();
                        setStatusDraft(next);
                      }}
                    />
                  ) : (
                    <CalmBadge
                      tone={projectLifecycleTone(project.status, "blue")}
                    >
                      {projectLifecycleLabel(project.status)}
                    </CalmBadge>
                  )}
                </div>
              </Form.Item>
              <Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                {statusHint}
              </Text>
              {statusMutation.error ? (
                <Alert
                  showIcon
                  type="error"
                  title={describeProjectManagementError(
                    statusMutation.error,
                    "status",
                  )}
                  style={{ marginTop: 16 }}
                />
              ) : null}
            </div>
          </Form>
        </form>
      </Modal>
      {canDeleteProject ? (
        <Modal
          className="catalog-modal"
          open={deleteConfirmOpen}
          eyebrow={`${project.code} / 删除项目`}
          title="确认删除项目"
          tone="danger"
          icon="alert"
          onCancel={() => {
            if (!deleteMutation.isPending) setDeleteConfirmOpen(false);
          }}
          mask={{ closable: !deleteMutation.isPending }}
          footer={
            <>
              <Button
                className="secondary-button"
                disabled={deleteMutation.isPending}
                onClick={() => setDeleteConfirmOpen(false)}
              >
                取消
              </Button>
              <Button
                className="primary-button danger-button"
                data-testid="confirm-delete-project"
                loading={deleteMutation.isPending}
                onClick={() => void submitDelete()}
              >
                确认删除
              </Button>
            </>
          }
        >
          <div className="catalog-form">
            <div className="dialog-form">
              <Alert
                showIcon
                type="warning"
                title={`确认删除项目「${project.name}」？`}
                description="删除不可撤销，会物理删除该项目下的全部模块、任务、迭代记录、GitHub 链接、通知与项目动态，项目编码将可以被重新使用；该项目的历史审计链会保留，仅供系统管理员在审计日志中查看。"
              />
              {deleteMutation.error ? (
                <Alert
                  showIcon
                  type="error"
                  title={describeProjectManagementError(
                    deleteMutation.error,
                    "delete",
                  )}
                />
              ) : null}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
};
