/**
 * 任务详情弹层由多个宿主页面按需加载。宿主 mount 后先预热 chunk，首次点任务
 * 卡片时就不会出现点击后短暂无反馈的空白期。
 */
export const loadTaskDetailOverlay = () =>
  import("@features/tasks/TaskDetailOverlay");

export function preloadTaskDetailOverlayChunk(): Promise<void> {
  return loadTaskDetailOverlay()
    .then(() => undefined)
    .catch(() => undefined);
}
