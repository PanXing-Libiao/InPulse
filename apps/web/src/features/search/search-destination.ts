import type { InpulseApiClient, SearchItem } from "@generated/api";
import type { QueryClient } from "@tanstack/react-query";
import { prefetchFeatureRoute } from "@features/features/feature-query";
import { prefetchModulesRoute } from "@features/modules/module-query";
import { prefetchRecordPath } from "@features/records/records-route-prefetch";
import { taskDetailPath } from "@features/tasks/task-links";

/**
 * 全局搜索结果的落地页（搜索结果页与命令面板共用同一条映射，改一处必须改两处）。
 *
 * 上级归属只认服务端下发的 projectId / moduleId / featureId / recordId
 * （见 SearchItem 契约注释：客户端不得自行推导），因此这里只做拼路径。
 * 返回 null 表示该结果没有可打开的页面，调用方据此不提供点击入口：
 *   * EXTERNAL_LINK（GitHub 关联）只作为所属对象页面上的一段信息存在，
 *     归属可能是任务 / 功能 / 记录 / 项目，没有自己的页面；
 *   * TASK_GROUP 只有任务中心里的聚合组弹层，没有独立页面；
 *   * 模块级任务、以及历史投影行可能缺少上级归属，一律按无页面处理，
 *     避免拼出指向错误对象的链接。
 */
export function searchResultPath(item: SearchItem): string | null {
  const projectPath = `/projects/${String(item.projectId)}/modules`;
  switch (item.entityType) {
    case "PROJECT":
      return projectPath;
    case "MODULE":
      return `${projectPath}/${String(item.entityId)}/tasks`;
    case "FEATURE":
      return item.moduleId === null
        ? null
        : `${projectPath}/${String(item.moduleId)}/features/${String(item.entityId)}`;
    case "TASK":
      return item.moduleId === null
        ? null
        : taskDetailPath({
            projectId: item.projectId,
            moduleId: item.moduleId,
            featureId: item.featureId,
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
 * 悬停搜索结果时的数据预取：功能/任务先取项目、模块与功能目录，模块/项目结果
 * 先取项目详情与模块目录。只预取首屏必需数据，不触发任何写操作；失败由
 * prefetchQuery 自行吞掉，真正导航时仍按原逻辑重试。
 */
export function prefetchSearchDestination(
  item: SearchItem,
  cache: QueryClient,
  client?: InpulseApiClient,
): Promise<void> {
  if (item.entityType === "FEATURE" || item.entityType === "TASK") {
    if (item.moduleId === null) return Promise.resolve();
    // FEATURE 结果自身就是功能，功能 ID 在 entityId；TASK 才用 featureId。
    const featureId =
      item.entityType === "FEATURE" ? item.entityId : item.featureId;
    if (featureId === null) {
      prefetchModulesRoute(cache, item.projectId, client);
      return Promise.resolve();
    }
    prefetchFeatureRoute(
      cache,
      {
        projectId: item.projectId,
        moduleId: item.moduleId,
        featureId,
      },
      client,
    );
    return Promise.resolve();
  }
  if (item.entityType === "PROJECT" || item.entityType === "MODULE") {
    prefetchModulesRoute(cache, item.projectId, client);
    return Promise.resolve();
  }
  if (item.entityType === "CHANGE_RECORD" || item.entityType === "LEFTOVER") {
    const path = searchResultPath(item);
    if (path === null) return Promise.resolve();
    return prefetchRecordPath(cache, path, client) ?? Promise.resolve();
  }
  return Promise.resolve();
}
