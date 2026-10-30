/** 侧栏「系统目录」树的选中层级：系统 → 模块。 */
export type TreeSelection =
  | { readonly kind: "project" }
  | { readonly kind: "module"; readonly moduleId: number };

/** 项目内路径解析结果；非项目路径全部为 null。 */
export interface CatalogIds {
  readonly projectId: number | null;
  readonly moduleId: number | null;
}

export interface TreeScope {
  readonly projectId: number;
  readonly selection: TreeSelection;
}

/**
 * 由当前路径解析结果得到目录树作用域；不在项目内返回 null。
 * 项目主页与项目级页面（成员、动态等）都落在「系统」节点上。
 */
export function treeScopeOf(ids: CatalogIds): TreeScope | null {
  const { projectId, moduleId } = ids;
  if (projectId === null) {
    return null;
  }
  if (moduleId === null) {
    return { projectId, selection: { kind: "project" } };
  }
  return { projectId, selection: { kind: "module", moduleId } };
}

/**
 * 目录树节点对应的既有项目页路径：
 * 系统 -> 项目主页，模块 -> 模块任务。
 */
export function treePath(projectId: number, selection: TreeSelection): string {
  const projectRoot = `/projects/${projectId}/modules`;
  if (selection.kind === "project") {
    return projectRoot;
  }
  return `${projectRoot}/${selection.moduleId}/tasks`;
}
