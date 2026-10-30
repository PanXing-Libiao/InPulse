import { useModules } from "@features/modules/module-query";
import { useProjectDetail } from "@features/projects/project-query";
import type { InpulseApiClient } from "@generated/api";

export interface TaskOriginInput {
  readonly projectId: number;
  readonly moduleId: number;
  readonly client?: InpulseApiClient | undefined;
}

/**
 * 任务归属名称解析：任务中心、任务状态弹层等位置看不到项目结构，必须显示
 * 项目 / 模块名称而不是编号。名称走既有只读契约（getProject / listModules），
 * query key 与页面共用，不产生额外请求；层级为项目 → 模块 → 任务。
 */
function useTaskOrigin({ projectId, moduleId, client }: TaskOriginInput) {
  const project = useProjectDetail({ client, projectId });
  const modules = useModules(projectId, client);
  return {
    projectName: project.data?.project.name ?? `项目 #${projectId}`,
    moduleName:
      modules.query.data?.items.find((item) => item.id === moduleId)?.name ??
      `模块 #${moduleId}`,
  };
}

/** 弹层头部的归属面包屑：单行省略，名称过长时不挤压标题与关闭按钮。 */
export function TaskOriginCrumb(input: TaskOriginInput) {
  const { projectName, moduleName } = useTaskOrigin(input);
  const text = `${projectName} / ${moduleName}`;
  return (
    <span className="task-origin-crumb" title={text}>
      {text}
    </span>
  );
}

/** 任务详情事实栏的归属行：项目 / 模块。 */
export function TaskOriginFacts(input: TaskOriginInput) {
  const { projectName, moduleName } = useTaskOrigin(input);
  return (
    <>
      <dt>项目</dt>
      <dd>{projectName}</dd>
      <dt>模块</dt>
      <dd>{moduleName}</dd>
    </>
  );
}
