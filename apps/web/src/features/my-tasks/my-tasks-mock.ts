import {
  MY_TASKS_FULL_FILTER_SUPPORT,
  type MyTaskGroupItem,
  type MyTaskGroupsQueryInput,
  type MyTaskGroupsResult,
  type MyTaskListItem,
  type MyTaskListResult,
  type MyTaskPriority,
  type MyTaskStats,
  type MyTasksAdapter,
  type MyTasksQueryInput,
  type MyTaskWorkStatus,
} from "./my-tasks-types";
import {
  isBeforeTodayIso,
  isSameDayIso,
  isWithinNextDaysIso,
} from "./my-tasks-time";

/**
 * mock 数据集内置的示例用户；mock 适配器固定以该视角演示，
 * 避免真实用户 id 与演示数据不匹配导致空列表（server adapter 走会话身份）。
 */
export const MY_TASKS_MOCK_VIEWER_ID = 1;

export const MY_TASKS_MOCK_NOTICE =
  "任务中心 mock 数据：仅用于前端测试与降级演示，未接入服务端聚合接口；生产页面默认使用 server adapter（GET /api/v1/me/tasks）。";

/**
 * mock 数据集持有全部骨架字段（含契约未提供的 description），仅供测试与演示；
 * 其余字段与视图类型 MyTaskListItem 一致，应与服务端映射保持同源。
 */
type MockTaskItem = MyTaskListItem & { description: string };

/**
 * 种子只声明单个负责人（示例数据足够）；assignees 由 createMockItems 统一补全，
 * 避免 10 份示例重复写集合，同时保证导出条目仍是完整 MyTaskListItem。
 */
type MockItemSeed = Omit<MockTaskItem, "assignees">;

type Bucket = "open" | "done" | "canceled";

const bucketRank: Record<Bucket, number> = { open: 0, done: 1, canceled: 2 };

const priorityRank: Record<MyTaskPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
};

function startOfDay(offsetDays: number, hour = 10): string {
  const now = new Date();
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + offsetDays,
    hour,
    0,
    0,
    0,
  );
  return day.toISOString();
}

function dayOfMonth(offsetDays: number): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    1 + offsetDays,
    9,
    0,
    0,
    0,
  ).toISOString();
}

function bucketOf(status: MyTaskWorkStatus): Bucket {
  if (status === "TODO") return "open";
  if (status === "DONE") return "done";
  return "canceled";
}

function createMockItemSeeds(): readonly MockItemSeed[] {
  return [
    {
      taskId: 101,
      code: "T-101",
      title: "登录页缺少恢复码入口，管理员无法自助找回",
      description:
        "恢复码入口只在注册流程出现，登录页没有入口，也没有说明文案。",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 11,
      moduleName: "访问控制",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      priority: "URGENT",
      dueAt: startOfDay(-2),
      updatedAt: startOfDay(-1),
      completedAt: null,
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      groupId: null,
      githubLinkCount: 1,
      hasLeftoverSource: true,
    },
    {
      taskId: 102,
      code: "T-102",
      title: "任务合并后来源分支的历史记录仍可回溯",
      description:
        "合并只改变入口，不改写历史；需要确认来源分支记录仍可按原任务检索。",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 12,
      moduleName: "任务与聚合",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      priority: "HIGH",
      dueAt: startOfDay(0),
      updatedAt: startOfDay(0, 8),
      completedAt: null,
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: true,
      publishedRecordCount: 3,
      groupRole: "MAIN",
      groupId: 501,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
    {
      taskId: 103,
      code: "T-103",
      title: "搜索短词命中率复核（中文两字词）",
      description: "复核 PGroonga 默认计划下两字中文词的召回与耗时。",
      projectId: 2,
      projectName: "订单中台",
      moduleId: 21,
      moduleName: "检索",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      priority: "NORMAL",
      dueAt: startOfDay(5),
      updatedAt: startOfDay(-1, 15),
      completedAt: null,
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      groupId: null,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
    {
      taskId: 104,
      code: "T-104",
      title: "通知铃铛未读计数与列表联动",
      description: "已读操作后未读计数需要与列表同步刷新。",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 13,
      moduleName: "通知",
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      priority: "NORMAL",
      dueAt: dayOfMonth(3),
      updatedAt: dayOfMonth(4),
      completedAt: dayOfMonth(4),
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: true,
      publishedRecordCount: 2,
      groupRole: null,
      groupId: null,
      githubLinkCount: 1,
      hasLeftoverSource: true,
    },
    {
      taskId: 105,
      code: "T-105",
      title: "项目成员移除前的未完成任务提示文案",
      description: "移除成员前需要展示其未完成任务，并给出改派入口。",
      projectId: 2,
      projectName: "订单中台",
      moduleId: 22,
      moduleName: "成员管理",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      priority: "HIGH",
      dueAt: startOfDay(3),
      updatedAt: startOfDay(-2, 16),
      completedAt: null,
      creatorId: 1,
      assignee: { userId: 2, name: "王敏", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: "SOURCE",
      groupId: 501,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
    {
      taskId: 106,
      code: "T-106",
      title: "移动端窄屏下任务卡片换行错位",
      description: "700px 以下卡片底部信息会挤压换行。",
      projectId: 3,
      projectName: "移动端体验",
      moduleId: 31,
      moduleName: "样式基线",
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      priority: "NORMAL",
      dueAt: dayOfMonth(6),
      updatedAt: dayOfMonth(2),
      completedAt: dayOfMonth(2),
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      groupId: null,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
    {
      taskId: 107,
      code: "T-107",
      title: "旧版任务导出脚本下线",
      description: "需求取消，保留编号与历史，不物理删除。",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 14,
      moduleName: "数据导出",
      workStatus: "CANCELED",
      lifecycleStatus: "ACTIVE",
      priority: "NORMAL",
      dueAt: null,
      updatedAt: dayOfMonth(5),
      completedAt: null,
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      groupId: null,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
    {
      taskId: 108,
      code: "T-108",
      title: "任务中心 URL 筛选状态需要可分享",
      description: "筛选状态由 URL 承载，刷新与分享后保持一致。",
      projectId: 3,
      projectName: "移动端体验",
      moduleId: 32,
      moduleName: "信息架构",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      priority: "NORMAL",
      dueAt: startOfDay(20),
      updatedAt: startOfDay(-3, 11),
      completedAt: null,
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      groupId: null,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
    {
      taskId: 109,
      code: "T-109",
      title: "审计日志导出缺少请求 ID 列",
      description: "导出列需要补齐 requestId，方便与错误响应关联。",
      projectId: 2,
      projectName: "订单中台",
      moduleId: 23,
      moduleName: "审计",
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      priority: "HIGH",
      dueAt: startOfDay(-1),
      updatedAt: startOfDay(-1, 18),
      completedAt: startOfDay(-1, 18),
      creatorId: 1,
      assignee: { userId: 1, name: "陈晓", avatarUrl: null },
      hasPublishedRecord: true,
      publishedRecordCount: 1,
      groupRole: null,
      groupId: null,
      githubLinkCount: 1,
      hasLeftoverSource: false,
    },
    {
      taskId: 110,
      code: "T-110",
      title: "项目归档预览的未完成任务口径",
      description: "归档预览只统计真实任务，不计入已取消任务。",
      projectId: 1,
      projectName: "InPulse 平台",
      moduleId: 15,
      moduleName: "项目设置",
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      priority: "NORMAL",
      dueAt: startOfDay(9),
      updatedAt: startOfDay(-4, 14),
      completedAt: null,
      creatorId: 3,
      assignee: { userId: 3, name: "赵磊", avatarUrl: null },
      hasPublishedRecord: false,
      publishedRecordCount: 0,
      groupRole: null,
      groupId: null,
      githubLinkCount: 0,
      hasLeftoverSource: false,
    },
  ];
}

/** ADR-040：负责人是集合，标量 assignee 是它的派生视图（等于 assignees[0]）。 */
function createMockItems(): readonly MockTaskItem[] {
  return createMockItemSeeds().map((seed) => ({
    ...seed,
    assignees: [seed.assignee],
  }));
}

function haystack(item: MockTaskItem): string {
  return [
    item.code,
    item.title,
    item.description,
    item.projectName,
    item.moduleName,
    item.assignee.name,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesScope(
  item: MockTaskItem,
  filters: MyTasksQueryInput["filters"],
  viewerId: number,
): boolean {
  if (filters.scope === "mine") return item.assignee.userId === viewerId;
  if (filters.scope === "created") return item.creatorId === viewerId;
  if (filters.scope === "project")
    return filters.projectId === null || item.projectId === filters.projectId;
  return true;
}

function matchesFilters(
  item: MockTaskItem,
  filters: MyTasksQueryInput["filters"],
): boolean {
  const bucket = bucketOf(item.workStatus);
  if (bucket === "canceled") {
    if (!filters.includeCanceled) return false;
    if (filters.status !== "all") return false;
  }
  if (filters.status === "open" && item.workStatus !== "TODO") return false;
  if (filters.status === "done" && item.workStatus !== "DONE") return false;
  // 与 URL 读取和 R-3 适配器同口径：今日待办只在「未完成」视图下生效。
  if (
    filters.status === "open" &&
    filters.todayTodo === true &&
    !isTodayTodoItem(item)
  )
    return false;
  if (filters.priority !== null && item.priority !== filters.priority)
    return false;
  if (filters.relation === "STANDALONE" && item.groupRole !== null)
    return false;
  if (filters.relation === "MAIN" && item.groupRole !== "MAIN") return false;
  if (filters.relation === "SOURCE" && item.groupRole !== "SOURCE")
    return false;
  if (filters.hasRecord === "yes" && !item.hasPublishedRecord) return false;
  if (filters.hasRecord === "no" && item.hasPublishedRecord) return false;
  if (filters.hasGithub === "yes" && item.githubLinkCount === 0) return false;
  if (filters.hasGithub === "no" && item.githubLinkCount > 0) return false;
  const term = filters.query.trim().toLowerCase();
  if (term.length > 0 && !haystack(item).includes(term)) return false;
  return true;
}

function compareOpen(a: MockTaskItem, b: MockTaskItem): number {
  const aOverdue = a.dueAt !== null && isBeforeTodayIso(a.dueAt);
  const bOverdue = b.dueAt !== null && isBeforeTodayIso(b.dueAt);
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  const aToday = a.dueAt !== null && isSameDayIso(a.dueAt, 0);
  const bToday = b.dueAt !== null && isSameDayIso(b.dueAt, 0);
  if (aToday !== bToday) return aToday ? -1 : 1;
  const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
  if (byPriority !== 0) return byPriority;
  return (a.dueAt ?? "9999-12-31").localeCompare(b.dueAt ?? "9999-12-31");
}

function compareClosed(a: MockTaskItem, b: MockTaskItem): number {
  return (b.completedAt ?? b.updatedAt).localeCompare(
    a.completedAt ?? a.updatedAt,
  );
}

function compareItems(a: MockTaskItem, b: MockTaskItem): number {
  const bucket = bucketOf(a.workStatus);
  const byBucket = bucketRank[bucket] - bucketRank[bucketOf(b.workStatus)];
  if (byBucket !== 0) return byBucket;
  return bucket === "open" ? compareOpen(a, b) : compareClosed(a, b);
}

/** 有效任务口径与服务端统计一致：排除作废来源分支与已取消。 */
function isEffective(item: MockTaskItem): boolean {
  return item.lifecycleStatus !== "INVALID" && item.workStatus !== "CANCELED";
}

/** 今日待办的四个来源判定；四个子项可以互相重叠，其并集即 todayTodo。 */
function isOverdueSource(item: MockTaskItem): boolean {
  return item.dueAt !== null && isBeforeTodayIso(item.dueAt);
}

function isDueWithinDaysSource(item: MockTaskItem): boolean {
  return item.dueAt !== null && isWithinNextDaysIso(item.dueAt, 7);
}

function isUrgentSource(item: MockTaskItem): boolean {
  return item.priority === "URGENT";
}

function isLeftoverSource(item: MockTaskItem): boolean {
  return item.hasLeftoverSource;
}

function isTodayTodoItem(item: MockTaskItem): boolean {
  if (item.workStatus !== "TODO") return false;
  return (
    isOverdueSource(item) ||
    isDueWithinDaysSource(item) ||
    isUrgentSource(item) ||
    isLeftoverSource(item)
  );
}

function buildStats(
  scoped: readonly MockTaskItem[],
  viewerId: number,
): MyTaskStats {
  const effective = scoped.filter(isEffective);
  const mine = effective.filter(
    (item) => item.assignee.userId === viewerId && item.workStatus === "TODO",
  );
  return {
    todayTodo: mine.filter(isTodayTodoItem).length,
    todayTodoBreakdown: {
      overdue: mine.filter(isOverdueSource).length,
      leftover: mine.filter(isLeftoverSource).length,
      urgent: mine.filter(isUrgentSource).length,
      dueWithinDays: mine.filter(isDueWithinDaysSource).length,
    },
    myOpen: mine.length,
    completed: effective.filter(
      (item) => item.assignee.userId === viewerId && item.workStatus === "DONE",
    ).length,
    created: effective.filter((item) => item.creatorId === viewerId).length,
  };
}
/** 惰性构造演示数据：到期日相对当前日期生成，避免注释型日期随时间漂移。 */
export function createTasksMockItems(): readonly MockTaskItem[] {
  return createMockItems();
}

type MockGroupBranchSeed = {
  readonly taskId: number;
  readonly role: "MAIN" | "SOURCE";
  readonly sourceKind: "ACTIVE" | "HISTORICAL" | null;
};

/**
 * 任务聚合组演示数据：主分支固定一条，来源分支覆盖活动/历史来源与
 * 未完成、已完成、已取消三种工作状态；分支字段全部从同一 mock 任务
 * 数据集派生，不复制标题、状态或负责人，保证与任务列表口径一致。
 */
const MOCK_GROUP_BRANCH_SEEDS: readonly MockGroupBranchSeed[] = [
  { taskId: 102, role: "MAIN", sourceKind: null },
  { taskId: 101, role: "SOURCE", sourceKind: "ACTIVE" },
  { taskId: 104, role: "SOURCE", sourceKind: "HISTORICAL" },
  { taskId: 107, role: "SOURCE", sourceKind: "HISTORICAL" },
];

function createMockGroups(): readonly MyTaskGroupItem[] {
  const dataset = createMockItems();
  const byId = new Map(dataset.map((item) => [item.taskId, item]));
  const branches = MOCK_GROUP_BRANCH_SEEDS.map((seed) => {
    const task = byId.get(seed.taskId);
    if (task === undefined) {
      throw new Error("mock 聚合组引用了不存在的任务 " + String(seed.taskId));
    }
    return {
      taskId: task.taskId,
      taskCode: task.code,
      title: task.title,
      role: seed.role,
      sourceKind: seed.sourceKind,
      workStatus: task.workStatus,
      priority: task.priority,
      moduleId: task.moduleId,
      moduleName: task.moduleName,
      dueAt: task.dueAt,
      publishedRecordCount: task.publishedRecordCount,
      assignee: task.assignee,
      projectId: task.projectId,
      projectName: task.projectName,
    };
  });
  const projectIds = new Set(branches.map((branch) => branch.projectId));
  if (projectIds.size !== 1) {
    throw new Error("mock 聚合组的分支必须属于同一项目");
  }
  const main = branches.find((branch) => branch.role === "MAIN");
  if (main === undefined) {
    throw new Error("mock 聚合组必须包含主分支");
  }
  return [
    {
      groupId: 501,
      projectId: main.projectId,
      projectName: main.projectName,
      code: "TG-001",
      name: "任务合并后来源分支历史保留",
      status: "ACTIVE",
      mainTask: {
        taskId: main.taskId,
        code: main.taskCode,
        projectId: main.projectId,
        moduleId: main.moduleId,
      },
      branches: branches.map((branch) => ({
        taskId: branch.taskId,
        taskCode: branch.taskCode,
        title: branch.title,
        role: branch.role,
        sourceKind: branch.sourceKind,
        workStatus: branch.workStatus,
        priority: branch.priority,
        moduleId: branch.moduleId,
        moduleName: branch.moduleName,
        dueAt: branch.dueAt,
        publishedRecordCount: branch.publishedRecordCount,
        assignee: branch.assignee,
      })),
    },
  ];
}

export const MY_TASKS_MOCK_ADAPTER: MyTasksAdapter = {
  source: "mock",
  notice: MY_TASKS_MOCK_NOTICE,
  fetchMyTasks: (input: MyTasksQueryInput): Promise<MyTaskListResult> => {
    const viewerId = MY_TASKS_MOCK_VIEWER_ID;
    const dataset = createMockItems();
    const scoped = dataset.filter((item) =>
      matchesScope(item, input.filters, viewerId),
    );
    // 统计口径与服务端一致：只受 projectId 收窄，与 scope（负责 / 创建）无关。
    const projectScoped =
      input.filters.projectId === null
        ? dataset
        : dataset.filter((item) => item.projectId === input.filters.projectId);
    const items = scoped
      .filter((item) => matchesFilters(item, input.filters))
      .slice()
      .sort(compareItems);
    return Promise.resolve({
      items,
      nextCursor: null,
      hasMore: false,
      filterSupport: MY_TASKS_FULL_FILTER_SUPPORT,
      stats: buildStats(projectScoped, viewerId),
      scopeCounts: {
        mine: dataset.filter((item) => item.assignee.userId === viewerId)
          .length,
        created: dataset.filter((item) => item.creatorId === viewerId).length,
        project:
          input.filters.projectId === null
            ? dataset.length
            : dataset.filter(
                (item) => item.projectId === input.filters.projectId,
              ).length,
        all: dataset.length,
      },
      leftoverCount: 3,
      leftoverSample: {
        recordCode: "R-021",
        summary: "恢复码入口与说明文档不一致，需要补齐登录页入口",
      },
    });
  },
  fetchTaskGroups: (
    input: MyTaskGroupsQueryInput,
  ): Promise<MyTaskGroupsResult> => {
    const items = createMockGroups().filter(
      (group) =>
        input.projectId === null || group.projectId === input.projectId,
    );
    return Promise.resolve({ items, nextCursor: null, hasMore: false });
  },
};
