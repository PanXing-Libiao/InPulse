/**
 * 项目主页四个就地弹窗（成员与设置 / 企业微信项目群 / 迭代记录 / 遗留问题）的内容 chunk 装载点。
 *
 * 背景（2026-10-12）：这三个视图与任务详情都用 `React.lazy` 按需加载，而弹层骨架是同步
 * 渲染的，于是「弹层的盒子先出现、内容后到」。本机 dev server 实测：点「查看全部」后弹层
 * 先以「只有标题、正文空白」的 129px 空壳出现约 330ms，chunk 到位后才跳到骨架（402px）
 * 与内容（521px）——用户看到的就是「闪出一个没有记录的迭代记录弹窗」。
 *
 * 处理分两层：
 * 1. 宿主（`ProjectWorkspaceModals` / `TasksPage`）把 Suspense 边界提到弹层外面：chunk 没
 *    到位时整个弹层不渲染。宁可晚一点出现，也不出现「没有内容的弹层」（用户明确要求
 *    「如果加载略慢就慢一点跳转，不要闪出不该存在的界面」）。
 * 2. 入口按钮的悬停 / 按下 / 键盘聚焦即预热对应 chunk（与 `route-preload.ts` 的路由 chunk
 *    预取同一套口径），让上面那句「慢一点」在常见操作里根本不发生。
 *
 * 加载函数集中在本文件，`lazy()` 与预热共用同一份 `import()`，避免两处路径各写一遍后漂移。
 */

/** 项目主页可用的四个工作区弹窗。 */
export type ProjectWorkspaceModalKind =
  "members" | "wecom" | "records" | "issues";

/** 成员视图只有命名导出：lazy 需要 default，这里映射一次。 */
export const loadProjectMembersPageView = () =>
  import("@features/projects/ProjectMembersPageView").then((mod) => ({
    default: mod.ProjectMembersPageView,
  }));

export const loadActiveProjectMembers = () =>
  import("@features/projects/ActiveProjectMembers").then((mod) => ({
    default: mod.ActiveProjectMembers,
  }));

export const loadProjectWecomGroupCard = () =>
  import("@features/projects/ProjectWecomGroupCard").then((mod) => ({
    default: mod.ProjectWecomGroupCard,
  }));

export const loadRecordsWorkspace = () =>
  import("@features/records/RecordsWorkspace").then((mod) => ({
    default: mod.RecordsWorkspace,
  }));

export const loadIssuesPageView = () =>
  import("@features/issues/IssuesPageView");

export const loadTaskDetailOverlay = () =>
  import("@features/tasks/TaskDetailOverlay");

/** 每个入口需要预热的模块：成员入口按权限落到两个视图之一，两个都预热。 */
const WORKSPACE_CHUNKS: Record<
  ProjectWorkspaceModalKind,
  () => Promise<unknown>
> = {
  members: () =>
    Promise.all([loadProjectMembersPageView(), loadActiveProjectMembers()]),
  wecom: loadProjectWecomGroupCard,
  records: loadRecordsWorkspace,
  issues: loadIssuesPageView,
};

/**
 * 预热某个工作区弹窗的内容 chunk。失败只吞掉异常：预热与「能不能打开」无关，
 * 真正的 `import()` 会再试一次（与 `route-preload.ts` 同口径）。
 */
function preloadProjectWorkspaceChunk(kind: ProjectWorkspaceModalKind): void {
  void WORKSPACE_CHUNKS[kind]().catch(() => undefined);
}

/**
 * 导航意图事件：鼠标悬停、按下、键盘聚焦都算「马上要打开这个弹窗」。
 * 与 `routePreloadHandlers` 同名同形，入口按钮直接展开即可。
 */
export function projectWorkspacePreloadHandlers(
  kind: ProjectWorkspaceModalKind,
) {
  const preload = () => {
    preloadProjectWorkspaceChunk(kind);
  };
  return {
    onPointerEnter: preload,
    onPointerDown: preload,
    onFocus: preload,
  } as const;
}
