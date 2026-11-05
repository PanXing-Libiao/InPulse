import React from "react";

import {
  createBlankTask,
  PROJECT_MODULE_DESCRIPTION_MAX_LENGTH,
  PROJECT_MODULE_NAME_MAX_LENGTH,
  PROJECT_TASK_DESCRIPTION_MAX_LENGTH,
  PROJECT_TASK_TITLE_MAX_LENGTH,
  type ProjectStructureIssue,
  type ProjectStructureModuleDraft,
  type ProjectStructureTaskDraft,
  type ProjectTaskPriority,
} from "./project-structure";

export interface ProjectStructureAssignee {
  readonly id: number;
  readonly name: string;
}

export interface ProjectStructureEditorProps {
  readonly modules: readonly ProjectStructureModuleDraft[];
  readonly assignees: readonly ProjectStructureAssignee[];
  readonly issues: readonly ProjectStructureIssue[];
  readonly disabled?: boolean | undefined;
  readonly onAddModule: () => void;
  readonly onChange: (modules: ProjectStructureModuleDraft[]) => void;
}

const PRIORITY_OPTIONS: readonly {
  readonly value: ProjectTaskPriority;
  readonly label: string;
}[] = [
  { value: "URGENT", label: "紧急" },
  { value: "HIGH", label: "高" },
  { value: "NORMAL", label: "中" },
];

function issueFor(
  issues: readonly ProjectStructureIssue[],
  moduleId: string,
  taskId: string | null,
  field: ProjectStructureIssue["field"],
): ProjectStructureIssue | undefined {
  return issues.find(
    (issue) =>
      issue.moduleId === moduleId &&
      issue.taskId === taskId &&
      issue.field === field,
  );
}

/**
 * 新建项目第二层：模块与任务的结构编辑。
 * 只负责渲染与局部编辑，状态（包括返回后保留）由 CreateProjectModal 持有。
 */
export const ProjectStructureEditor: React.FC<ProjectStructureEditorProps> = ({
  modules,
  assignees,
  issues,
  disabled = false,
  onAddModule,
  onChange,
}) => {
  const updateModule = (
    moduleId: string,
    patch: Partial<Omit<ProjectStructureModuleDraft, "id">>,
  ) => {
    onChange(
      modules.map((module) =>
        module.id === moduleId ? { ...module, ...patch } : module,
      ),
    );
  };

  const updateTask = (
    moduleId: string,
    taskId: string,
    patch: Partial<Omit<ProjectStructureTaskDraft, "id">>,
  ) => {
    onChange(
      modules.map((module) =>
        module.id === moduleId
          ? {
              ...module,
              tasks: module.tasks.map((task) =>
                task.id === taskId ? { ...task, ...patch } : task,
              ),
            }
          : module,
      ),
    );
  };

  let taskNumber = 0;

  return (
    <div className="project-structure-list">
      {modules.map((module, moduleIndex) => {
        const nameIssue = issueFor(issues, module.id, null, "name");
        return (
          <article className="project-module-card" key={module.id}>
            <div className="project-module-head">
              <span className="project-module-index" aria-hidden="true">
                {String(moduleIndex + 1).padStart(2, "0")}
              </span>
              <input
                className="project-structure-input project-module-name"
                aria-label={"模块 " + String(moduleIndex + 1) + " 名称"}
                aria-invalid={nameIssue !== undefined}
                maxLength={PROJECT_MODULE_NAME_MAX_LENGTH}
                placeholder="模块名称，例如：扫码巡检"
                value={module.name}
                disabled={disabled}
                onChange={(event) =>
                  updateModule(module.id, { name: event.currentTarget.value })
                }
              />
              <input
                className="project-structure-input project-module-desc"
                aria-label={"模块 " + String(moduleIndex + 1) + " 说明"}
                maxLength={PROJECT_MODULE_DESCRIPTION_MAX_LENGTH}
                placeholder="模块说明（可选）"
                value={module.description}
                disabled={disabled}
                onChange={(event) =>
                  updateModule(module.id, {
                    description: event.currentTarget.value,
                  })
                }
              />
              <button
                type="button"
                className="project-add-task-button"
                disabled={disabled}
                onClick={() =>
                  updateModule(module.id, {
                    tasks: [...module.tasks, createBlankTask()],
                  })
                }
              >
                <span aria-hidden="true">＋</span> 新建任务
              </button>
              <button
                type="button"
                className="project-row-remove"
                aria-label={"移除模块 " + String(moduleIndex + 1)}
                title="移除模块"
                disabled={disabled}
                onClick={() =>
                  onChange(modules.filter((item) => item.id !== module.id))
                }
              >
                ×
              </button>
            </div>
            {nameIssue === undefined ? null : (
              <p className="project-structure-error" role="alert">
                {nameIssue.message}
              </p>
            )}

            {module.tasks.length === 0 ? (
              <p className="project-task-empty">
                还没有任务，点模块右侧的「新建任务」直接添加。
              </p>
            ) : (
              <div className="project-task-list">
                {module.tasks.map((task) => {
                  taskNumber += 1;
                  const currentNumber = taskNumber;
                  const titleIssue = issueFor(
                    issues,
                    module.id,
                    task.id,
                    "title",
                  );
                  const assigneeIssue = issueFor(
                    issues,
                    module.id,
                    task.id,
                    "assignee",
                  );
                  const dueIssue = issueFor(
                    issues,
                    module.id,
                    task.id,
                    "dueDate",
                  );
                  return (
                    <div className="project-task-row" key={task.id}>
                      <span className="project-task-dot" aria-hidden="true" />
                      <input
                        className="project-task-field project-task-title"
                        aria-label={"任务 " + String(currentNumber) + " 标题"}
                        aria-invalid={titleIssue !== undefined}
                        maxLength={PROJECT_TASK_TITLE_MAX_LENGTH}
                        placeholder="任务标题，例如：完成扫码巡检闭环"
                        value={task.title}
                        disabled={disabled}
                        onChange={(event) =>
                          updateTask(module.id, task.id, {
                            title: event.currentTarget.value,
                          })
                        }
                      />
                      <select
                        className="project-task-field project-task-select"
                        aria-label={"任务 " + String(currentNumber) + " 负责人"}
                        aria-invalid={assigneeIssue !== undefined}
                        value={
                          task.assigneeId === null
                            ? ""
                            : String(task.assigneeId)
                        }
                        disabled={disabled}
                        onChange={(event) =>
                          updateTask(module.id, task.id, {
                            assigneeId:
                              event.currentTarget.value === ""
                                ? null
                                : Number(event.currentTarget.value),
                          })
                        }
                      >
                        <option value="">负责人</option>
                        {assignees.map((assignee) => (
                          <option key={assignee.id} value={String(assignee.id)}>
                            {assignee.name}
                          </option>
                        ))}
                      </select>
                      <select
                        className="project-task-field project-task-select"
                        aria-label={"任务 " + String(currentNumber) + " 优先级"}
                        value={task.priority}
                        disabled={disabled}
                        onChange={(event) =>
                          updateTask(module.id, task.id, {
                            priority: event.currentTarget
                              .value as ProjectTaskPriority,
                          })
                        }
                      >
                        {PRIORITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        className="project-task-field project-task-due"
                        aria-label={
                          "任务 " + String(currentNumber) + " 截止日期"
                        }
                        aria-invalid={dueIssue !== undefined}
                        value={task.dueDate}
                        disabled={disabled}
                        onChange={(event) =>
                          updateTask(module.id, task.id, {
                            dueDate: event.currentTarget.value,
                          })
                        }
                      />
                      <button
                        type="button"
                        className="project-row-remove"
                        aria-label={"移除任务 " + String(currentNumber)}
                        title="移除任务"
                        disabled={disabled}
                        onClick={() =>
                          updateModule(module.id, {
                            tasks: module.tasks.filter(
                              (item) => item.id !== task.id,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                      <textarea
                        className="project-task-detail"
                        aria-label={"任务 " + String(currentNumber) + " 详情"}
                        maxLength={PROJECT_TASK_DESCRIPTION_MAX_LENGTH}
                        placeholder="任务详情（可选）"
                        rows={2}
                        value={task.description}
                        disabled={disabled}
                        onChange={(event) =>
                          updateTask(module.id, task.id, {
                            description: event.currentTarget.value,
                          })
                        }
                      />
                      {titleIssue === undefined &&
                      assigneeIssue === undefined &&
                      dueIssue === undefined ? null : (
                        <p className="project-structure-error task-row-error">
                          {titleIssue?.message ??
                            assigneeIssue?.message ??
                            dueIssue?.message}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        );
      })}

      {modules.length === 0 ? (
        <div className="project-structure-empty">
          <div className="project-structure-empty-icon" aria-hidden="true">
            ＋
          </div>
          <strong>还没有模块</strong>
          <p>可以现在添加，也可以返回后直接创建空项目。</p>
          <button
            type="button"
            className="project-add-module-button"
            disabled={disabled}
            onClick={onAddModule}
          >
            ＋ 添加第一个模块
          </button>
        </div>
      ) : null}
    </div>
  );
};
