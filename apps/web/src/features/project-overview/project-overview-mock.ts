import type {
  ProjectOverviewAdapter,
  ProjectOverviewIteration,
  ProjectOverviewLeftover,
  ProjectOverviewResult,
} from "./project-overview-types";

export const PROJECT_OVERVIEW_MOCK_NOTICE =
  "项目概览 mock 数据：仅用于前端测试与降级演示，未接入服务端聚合接口；生产页面默认使用 server adapter（GET /api/v1/projects/{projectId}/overview）。";

function isoDaysAgo(days: number, hour = 15): string {
  const now = new Date();
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
    hour,
    0,
    0,
    0,
  );
  return day.toISOString();
}

function createIterations(): readonly ProjectOverviewIteration[] {
  return [
    {
      recordId: 301,
      code: "R-301",
      title: "任务中心与项目概览骨架对齐设计稿",
      publishedAt: isoDaysAgo(1, 16),
    },
    {
      recordId: 302,
      code: "R-302",
      title: "项目成员移除时的任务改派流程复核",
      publishedAt: isoDaysAgo(3, 11),
    },
    {
      recordId: 303,
      code: "R-303",
      title: "搜索短词命中率复核结论",
      publishedAt: isoDaysAgo(6, 14),
    },
  ];
}

function createLeftovers(): readonly ProjectOverviewLeftover[] {
  return [
    {
      leftoverId: 21,
      summary: "恢复码入口与说明文档不一致，需要补齐登录页入口",
      recordCode: "R-021",
      recordTitle: "登录安全复核",
    },
    {
      leftoverId: 22,
      summary: "归档预览的未完成任务口径需要补充说明文案",
      recordCode: "R-024",
      recordTitle: "项目归档流程复核",
    },
  ];
}

export function createProjectOverviewMockResult(): ProjectOverviewResult {
  return {
    stats: {
      activeModules: 4,
      openTasks: 6,
      publishedRecords: 9,
      openLeftovers: createLeftovers().length,
    },
    recentIterations: createIterations(),
    leftovers: createLeftovers(),
  };
}

export const PROJECT_OVERVIEW_MOCK_ADAPTER: ProjectOverviewAdapter = {
  source: "mock",
  notice: PROJECT_OVERVIEW_MOCK_NOTICE,
  fetchProjectOverview: (): Promise<ProjectOverviewResult> =>
    Promise.resolve(createProjectOverviewMockResult()),
};
