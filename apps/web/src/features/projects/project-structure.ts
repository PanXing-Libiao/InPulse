import type {
  ProjectCreateModuleRequest,
  ProjectCreateTaskRequest,
} from "@generated/api";

export type ProjectTaskPriority = "NORMAL" | "HIGH" | "URGENT";

export const PROJECT_STRUCTURE_MODULE_LIMIT = 100;
export const PROJECT_STRUCTURE_TASK_LIMIT = 200;
export const PROJECT_MODULE_NAME_MAX_LENGTH = 200;
export const PROJECT_MODULE_DESCRIPTION_MAX_LENGTH = 20_000;
export const PROJECT_TASK_TITLE_MAX_LENGTH = 500;
export const PROJECT_TASK_DESCRIPTION_MAX_LENGTH = 50_000;

export interface ProjectStructureTaskDraft {
  readonly id: string;
  readonly title: string;
  readonly assigneeId: number | null;
  readonly priority: ProjectTaskPriority;
  readonly dueDate: string;
  readonly description: string;
}

export interface ProjectStructureModuleDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tasks: readonly ProjectStructureTaskDraft[];
}

export type ProjectStructureIssueField =
  "name" | "title" | "assignee" | "dueDate";

export interface ProjectStructureIssue {
  readonly moduleId: string;
  readonly taskId: string | null;
  readonly field: ProjectStructureIssueField;
  readonly message: string;
}

let draftSequence = 0;

function nextDraftId(prefix: string): string {
  draftSequence += 1;
  return prefix + "-" + String(draftSequence);
}

export function createBlankModule(): ProjectStructureModuleDraft {
  return {
    id: nextDraftId("module"),
    name: "",
    description: "",
    tasks: [],
  };
}

export function createBlankTask(): ProjectStructureTaskDraft {
  return {
    id: nextDraftId("task"),
    title: "",
    assigneeId: null,
    priority: "NORMAL",
    dueDate: "",
    description: "",
  };
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 截止日期只接受本地日历日，转换成当天 00:00 的 ISO 串。 */
function dueDateToIso(value: string): string | null | undefined {
  const raw = value.trim();
  if (raw === "") return null;
  const matched = DATE_PATTERN.exec(raw);
  if (matched === null) return undefined;
  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const at = new Date(year, month, day);
  if (
    at.getFullYear() !== year ||
    at.getMonth() !== month ||
    at.getDate() !== day
  ) {
    return undefined;
  }
  return at.toISOString();
}

export function validateProjectStructure(
  modules: readonly ProjectStructureModuleDraft[],
  allowedAssigneeIds: readonly number[],
): ProjectStructureIssue[] {
  const issues: ProjectStructureIssue[] = [];
  const moduleNames = new Map<string, string>();
  const allowed = new Set(allowedAssigneeIds);

  for (const module of modules) {
    const name = module.name.trim();
    if (name.length === 0) {
      issues.push({
        moduleId: module.id,
        taskId: null,
        field: "name",
        message: "请填写模块名称",
      });
    } else if (moduleNames.has(name)) {
      issues.push({
        moduleId: module.id,
        taskId: null,
        field: "name",
        message: "模块名称不能重复",
      });
    } else {
      moduleNames.set(name, module.id);
    }

    for (const task of module.tasks) {
      if (task.title.trim().length === 0) {
        issues.push({
          moduleId: module.id,
          taskId: task.id,
          field: "title",
          message: "请填写任务标题",
        });
      }
      if (task.assigneeId === null) {
        issues.push({
          moduleId: module.id,
          taskId: task.id,
          field: "assignee",
          message: "请选择负责人",
        });
      } else if (!allowed.has(task.assigneeId)) {
        issues.push({
          moduleId: module.id,
          taskId: task.id,
          field: "assignee",
          message: "负责人需为项目成员",
        });
      }
      if (dueDateToIso(task.dueDate) === undefined) {
        issues.push({
          moduleId: module.id,
          taskId: task.id,
          field: "dueDate",
          message: "截止日期格式不正确",
        });
      }
    }
  }

  return issues;
}

export function toCreateProjectModules(
  modules: readonly ProjectStructureModuleDraft[],
): ProjectCreateModuleRequest[] {
  return modules.map((module) => ({
    name: module.name.trim(),
    description: module.description.trim(),
    tasks: module.tasks.map((task): ProjectCreateTaskRequest => {
      const dueAt = dueDateToIso(task.dueDate);
      return {
        title: task.title.trim(),
        description: task.description,
        priority: task.priority,
        assigneeIds: task.assigneeId === null ? [] : [task.assigneeId],
        dueAt: dueAt ?? null,
      };
    }),
  }));
}
