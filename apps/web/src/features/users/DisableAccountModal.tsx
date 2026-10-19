import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  createApiClient,
  type AdminUserDisableRequest,
  type AdminUserDisableTaskAction,
  type AdminUserItem,
  type AdminUserOffboardingProject,
  type AdminUserOffboardingTask,
  type InpulseApiClient,
} from "@generated/api";

import { AppModal as Modal } from "@features/common/components/AppModal";
import { adminUserErrorMessage } from "./admin-user-query";

interface TaskDraft {
  readonly selected: readonly number[];
  readonly removed: boolean;
  readonly expanded: boolean;
}

const EMPTY_DRAFT: TaskDraft = {
  selected: [],
  removed: false,
  expanded: false,
};

/** 项目编码取前两段首字母，和 D 稿的项目色块一致。 */
function projectInitials(code: string): string {
  const parts = code.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length > 1) {
    return (parts[0]?.slice(0, 1) ?? "") + (parts[1]?.slice(0, 1) ?? "");
  }
  return code.slice(0, 2).toUpperCase();
}

function taskDraft(
  drafts: Readonly<Record<number, TaskDraft>>,
  taskId: number,
): TaskDraft {
  return drafts[taskId] ?? EMPTY_DRAFT;
}

export interface DisableAccountModalProps {
  readonly open: boolean;
  readonly client?: InpulseApiClient | undefined;
  readonly user: AdminUserItem | null;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: (body: AdminUserDisableRequest) => Promise<void>;
}

/**
 * 停用账号前的任务交接弹窗。默认保留多负责人任务的其余负责人；
 * 只有「仅该账号一人负责」的任务必须指定接手人或标记删除。
 */
export const DisableAccountModal: React.FC<DisableAccountModalProps> = ({
  open,
  client,
  user,
  pending,
  error,
  onClose,
  onConfirm,
}) => {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const userId = user?.id;
  const offboarding = useQuery({
    queryKey: ["admin-user-offboarding", userId ?? 0],
    queryFn: ({ signal }) => {
      if (userId === undefined) throw new Error("missing target user");
      return apiClient.getAdminUserOffboarding(userId, { signal });
    },
    enabled: open && userId !== undefined,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const [drafts, setDrafts] = useState<Record<number, TaskDraft>>({});
  const submitGuard = useRef(false);

  useEffect(() => {
    setDrafts({});
    submitGuard.current = false;
  }, [open, userId]);

  const projects = useMemo(() => {
    const sorted = (offboarding.data?.projects ?? []).map((project) => ({
      ...project,
      tasks: [...project.tasks].sort(
        (left, right) =>
          Number(right.requiresHandover) - Number(left.requiresHandover) ||
          left.taskId - right.taskId,
      ),
    }));
    return sorted.sort(
      (left, right) =>
        right.tasks.filter((task) => task.requiresHandover).length -
          left.tasks.filter((task) => task.requiresHandover).length ||
        left.projectId - right.projectId,
    );
  }, [offboarding.data]);
  const allTasks = useMemo(
    () => projects.flatMap((project) => project.tasks),
    [projects],
  );
  const unresolved = allTasks.filter((task) => {
    const draft = taskDraft(drafts, task.taskId);
    return (
      task.requiresHandover && !draft.removed && draft.selected.length === 0
    );
  });

  const updateDraft = (taskId: number, change: Partial<TaskDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [taskId]: {
        ...taskDraft(current, taskId),
        ...change,
      },
    }));
  };

  const toggleAssignee = (
    taskId: number,
    memberId: number,
    checked: boolean,
  ): void => {
    const current = taskDraft(drafts, taskId);
    const selected = checked
      ? [...current.selected.filter((id) => id !== memberId), memberId].sort(
          (left, right) => left - right,
        )
      : current.selected.filter((id) => id !== memberId);
    updateDraft(taskId, { selected, removed: false });
  };

  const markRemoved = (taskId: number): void => {
    updateDraft(taskId, { removed: true, selected: [], expanded: false });
  };

  const undoRemoved = (taskId: number): void => {
    updateDraft(taskId, { removed: false });
  };

  const buildRequest = (): AdminUserDisableRequest => {
    const tasks: AdminUserDisableTaskAction[] = [];
    for (const task of allTasks) {
      const draft = taskDraft(drafts, task.taskId);
      if (!draft.removed && draft.selected.length === 0) continue;
      tasks.push({
        projectId: task.projectId,
        moduleId: task.moduleId,
        featureId: task.featureId,
        taskId: task.taskId,
        rowVersion: task.rowVersion,
        assigneeIds: [...draft.selected].sort((left, right) => left - right),
        delete: draft.removed,
      });
    }
    return { tasks };
  };

  const submit = async (): Promise<void> => {
    if (
      pending ||
      submitGuard.current ||
      offboarding.isPending ||
      offboarding.isError ||
      unresolved.length > 0
    ) {
      return;
    }
    submitGuard.current = true;
    try {
      await onConfirm(buildRequest());
    } catch {
      // 失败原因由父组件的 mutation 错误状态渲染在弹窗内。
    } finally {
      submitGuard.current = false;
    }
  };

  const canConfirm =
    !pending &&
    !offboarding.isPending &&
    !offboarding.isError &&
    unresolved.length === 0;

  let footNote = "交接已准备好，确认后将撤销全部会话并停用账号。";
  if (offboarding.isError) {
    footNote = "任务清单加载失败，请重试后再停用。";
  } else if (allTasks.length === 0) {
    footNote = "当前账号没有未完成任务，可以直接停用。";
  } else if (unresolved.length > 0) {
    footNote =
      "还有 " +
      unresolved.length +
      " 个仅该账号负责的任务未处理，处理后才能停用。";
  }

  return (
    <Modal
      className="disable-account-modal"
      size="xl"
      open={open}
      eyebrow={user ? "账号 · " + user.loginName : "账号"}
      title="停用账号 · 任务交接"
      body
      onCancel={onClose}
      mask={{ closable: !pending }}
      footer={
        <>
          <span className="disable-account-foot-note">{footNote}</span>
          <Button onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            type="primary"
            danger
            loading={pending}
            disabled={!canConfirm}
            onClick={() => void submit()}
          >
            确认停用
          </Button>
        </>
      }
    >
      {user === null ? null : (
        <>
          <div className="disable-account-card">
            <span className="person-avatar disable-account-avatar">
              {user.name.trim().charAt(0) || "成"}
            </span>
            <div className="disable-account-copy">
              <strong>{user.name}</strong>
              <span>
                {user.loginName} · {user.isAdmin ? "系统管理员" : "项目成员"}
              </span>
            </div>
            <div className="disable-account-badges">
              <span className="disable-pill is-green">
                {user.status === "ACTIVE" ? "启用" : "已停用"}
              </span>
              <span className="disable-pill is-amber">
                {offboarding.isError
                  ? "任务清单未加载"
                  : allTasks.length > 0
                    ? allTasks.length + " 个未完成任务"
                    : "没有未完成任务"}
              </span>
            </div>
          </div>

          {offboarding.isPending ? (
            <div className="disable-account-loading" role="status">
              正在加载任务清单…
            </div>
          ) : offboarding.isError ? (
            <div className="disable-account-error">
              <Alert
                type="error"
                title={
                  "任务清单加载失败：" +
                  adminUserErrorMessage(offboarding.error)
                }
              />
              <Button onClick={() => void offboarding.refetch()}>重试</Button>
            </div>
          ) : allTasks.length === 0 ? (
            <div className="disable-account-done">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>全部项目已完成。</strong>
                <p>当前账号没有未完成任务，可以直接停用。</p>
              </div>
            </div>
          ) : (
            <div className="disable-project-list">
              {projects.map((project) => (
                <ProjectHandoverCard
                  key={project.projectId}
                  project={project}
                  targetUserId={user.id}
                  drafts={drafts}
                  onToggleAssignee={toggleAssignee}
                  onTogglePanel={(taskId, expanded) =>
                    updateDraft(taskId, { expanded })
                  }
                  onMarkRemoved={markRemoved}
                  onUndoRemoved={undoRemoved}
                />
              ))}
            </div>
          )}

          {offboarding.isError ? null : error ? (
            <Alert type="error" title={adminUserErrorMessage(error)} />
          ) : null}
        </>
      )}
    </Modal>
  );
};

interface ProjectHandoverCardProps {
  readonly project: AdminUserOffboardingProject;
  readonly targetUserId: number;
  readonly drafts: Readonly<Record<number, TaskDraft>>;
  readonly onToggleAssignee: (
    taskId: number,
    memberId: number,
    checked: boolean,
  ) => void;
  readonly onTogglePanel: (taskId: number, expanded: boolean) => void;
  readonly onMarkRemoved: (taskId: number) => void;
  readonly onUndoRemoved: (taskId: number) => void;
}

const ProjectHandoverCard: React.FC<ProjectHandoverCardProps> = ({
  project,
  targetUserId,
  drafts,
  onToggleAssignee,
  onTogglePanel,
  onMarkRemoved,
  onUndoRemoved,
}) => {
  const requiredCount = project.tasks.filter(
    (task) => task.requiresHandover,
  ).length;
  return (
    <section
      className={"disable-project" + (requiredCount > 0 ? " is-urgent" : "")}
    >
      <div className="disable-project-head">
        <span
          className={
            "disable-project-logo" + (requiredCount > 0 ? " is-red" : "")
          }
          aria-hidden="true"
        >
          {projectInitials(project.projectCode)}
        </span>
        <div className="disable-project-copy">
          <strong>{project.projectName}</strong>
          <span>
            {project.projectCode} · {project.tasks.length} 个未完成任务
          </span>
        </div>
        <span
          className={
            "disable-pill " + (requiredCount > 0 ? "is-red" : "is-blue")
          }
        >
          {requiredCount > 0 ? requiredCount + " 个必须处理" : "全部多名负责人"}
        </span>
      </div>
      <table className="disable-task-table">
        <tbody>
          {project.tasks.map((task) => (
            <TaskHandoverRow
              key={task.taskId}
              project={project}
              task={task}
              targetUserId={targetUserId}
              draft={taskDraft(drafts, task.taskId)}
              onToggleAssignee={onToggleAssignee}
              onTogglePanel={onTogglePanel}
              onMarkRemoved={onMarkRemoved}
              onUndoRemoved={onUndoRemoved}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
};

interface TaskHandoverRowProps {
  readonly project: AdminUserOffboardingProject;
  readonly task: AdminUserOffboardingTask;
  readonly targetUserId: number;
  readonly draft: TaskDraft;
  readonly onToggleAssignee: (
    taskId: number,
    memberId: number,
    checked: boolean,
  ) => void;
  readonly onTogglePanel: (taskId: number, expanded: boolean) => void;
  readonly onMarkRemoved: (taskId: number) => void;
  readonly onUndoRemoved: (taskId: number) => void;
}

const TaskHandoverRow: React.FC<TaskHandoverRowProps> = ({
  project,
  task,
  targetUserId,
  draft,
  onToggleAssignee,
  onTogglePanel,
  onMarkRemoved,
  onUndoRemoved,
}) => {
  const existingAssigneeIds = new Set(
    task.assignees.map((assignee) => assignee.userId),
  );
  const availableMembers = project.members.filter(
    (member) => !existingAssigneeIds.has(member.userId),
  );
  const memberNames = new Map(
    project.members.map((member) => [member.userId, member.name] as const),
  );
  const orderedAssignees = [...task.assignees].sort(
    (left, right) =>
      Number(right.userId === targetUserId) -
        Number(left.userId === targetUserId) || left.userId - right.userId,
  );
  return (
    <tr
      className={
        "disable-task-row" +
        (task.requiresHandover ? " is-sole" : "") +
        (draft.removed ? " is-removed" : "")
      }
    >
      <td className="disable-task-main">
        <span className="disable-task-title">{task.title}</span>
        <span className="disable-task-code">{task.code}</span>
      </td>
      <td className="disable-task-people">
        {orderedAssignees.map((assignee) => (
          <span
            className={
              "disable-person" +
              (assignee.userId === targetUserId ? " is-self" : "")
            }
            key={assignee.userId}
          >
            {assignee.name}
          </span>
        ))}
      </td>
      <td className="disable-task-action">
        {draft.removed ? (
          <span className="disable-deleted-note">
            已标记删除
            <button type="button" onClick={() => onUndoRemoved(task.taskId)}>
              撤销
            </button>
          </span>
        ) : (
          <div className="disable-action-stack">
            <div className="disable-row-actions">
              <button
                type="button"
                className="disable-add-button"
                aria-expanded={draft.expanded}
                onClick={() => onTogglePanel(task.taskId, !draft.expanded)}
              >
                ＋ 添加成员
              </button>
              {draft.expanded && availableMembers.length === 0 ? (
                <span className="disable-add-empty">
                  项目内暂无可接手的启用成员
                </span>
              ) : null}
              {task.requiresHandover ? (
                <button
                  type="button"
                  className="disable-delete-button"
                  onClick={() => onMarkRemoved(task.taskId)}
                >
                  删除任务
                </button>
              ) : null}
            </div>
            {draft.expanded && availableMembers.length > 0 ? (
              <div className="disable-add-panel">
                {availableMembers.map((member) => (
                  <Checkbox
                    key={member.userId}
                    checked={draft.selected.includes(member.userId)}
                    onChange={(event) =>
                      onToggleAssignee(
                        task.taskId,
                        member.userId,
                        event.target.checked,
                      )
                    }
                  >
                    {member.name}
                  </Checkbox>
                ))}
              </div>
            ) : null}
            {draft.selected.length > 0 ? (
              <div className="disable-picked">
                {draft.selected.map((memberId) => (
                  <span className="disable-picker-chip" key={memberId}>
                    {memberNames.get(memberId) ?? "成员 " + memberId}
                    <button
                      type="button"
                      aria-label={
                        "移除 " + (memberNames.get(memberId) ?? "成员")
                      }
                      onClick={() =>
                        onToggleAssignee(task.taskId, memberId, false)
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
};
