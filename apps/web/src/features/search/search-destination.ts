import type { InpulseApiClient, SearchItem } from "@generated/api";
import type { QueryClient } from "@tanstack/react-query";
import { prefetchModulesRoute } from "@features/modules/module-query";
import { prefetchRecordPath } from "@features/records/records-route-prefetch";
import { taskDetailPath } from "@features/tasks/task-links";

/**
 * 全局搜索结果的落地页（搜索结果页与命令面板共用同一条映射，改一处必须改两处）。
 *
 * 上级归属只认服务端下发的 projectId / moduleId / recordId。当前对象树为
 * 项目 → 模块 → 任务 → 迭代记录，不再存在功能层。
 * 返回 null 表示该结果没有可打开的页面，调用方据此不提供点击入口：
 *   * EXTERNAL_LINK（GitHub 关联）只作为所属对象页面上的一段信息存在；
 *   * TASK_GROUP 只有任务中心里的聚合组弹层，没有独立页面；
 *   * 历史投影行缺少上级归属时按无页面处理，避免拼出错误链接。
 */
export function searchResultPath(item: SearchItem): string | null {
  const projectPath = `/projects/${String(item.projectId)}/modules`;
  switch (item.entityType) {
    case "PROJECT":
      return projectPath;
    case "MODULE":
      return `${projectPath}/${String(item.entityId)}/tasks`;
    case "TASK":
      return item.moduleId === null
        ? null
        : taskDetailPath({
            projectId: item.projectId,
            moduleId: item.moduleId,
            taskId: item.entityId,
          });
    case "CHANGE_RECORD":
      return recordPath(item.projectId, item.entityId);
    case "LEFTOVER":
      return item.recordId === null
        ? null
        : recordPath(item.projectId, item.recordId);
    case "EXTERNAL_LINK":
    case "TASK_GROUP":
      return null;
  }
}

/** 已发布记录的深链口径与 RecordsWorkspace 读取 `publishedId` 一致。 */
function recordPath(projectId: number, recordId: number): string {
  return `/records?view=published&projectId=${String(projectId)}&publishedId=${String(recordId)}`;
}

/**
 * 悬停搜索结果时的数据预取：任务、模块与项目结果先取项目详情与模块目录。
 * 只预取首屏必需数据，不触发任何写操作；失败由 prefetchQuery 自行吞掉，
 * 真正导航时仍按原逻辑重试。
 */
export function prefetchSearchDestination(
  item: SearchItem,
  cache: QueryClient,
  client?: InpulseApiClient,
): Promise<void> {
  if (
    item.entityType === "PROJECT" ||
    item.entityType === "MODULE" ||
    item.entityType === "TASK"
  ) {
    prefetchModulesRoute(cache, item.projectId, client);
    return Promise.resolve();
  }
  if (item.entityType === "CHANGE_RECORD" || item.entityType === "LEFTOVER") {
    const targetPath = searchResultPath(item);
    if (targetPath === null) return Promise.resolve();
    return prefetchRecordPath(cache, targetPath, client) ?? Promise.resolve();
  }
  return Promise.resolve();
}
