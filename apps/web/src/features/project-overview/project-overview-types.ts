/**
 * F-29 项目概览（骨架）：统计指标、最近迭代与待处理遗留问题。
 *
 * 指标口径对齐服务端聚合读：活跃模块、未完成任务、迭代记录、最近迭代、
 * 待处理遗留问题；
 * 项目名、状态与成员数来自 A 的既有项目端口（getProject），不经过本适配器。
 * 默认数据源为 server adapter（R-2 getProjectOverview，见 project-overview-server.ts）；
 * mock adapter 只保留用于前端测试与降级演示。第二轮契约扩展后
 * openLeftovers 总数与 leftover.recordTitle 已由 R-2 提供，无降级字段。
 */

export interface ProjectOverviewStats {
  readonly activeModules: number;
  readonly openTasks: number;
  readonly publishedRecords: number;
  /** R-2 第二轮扩展已提供总数；显示层直接渲染服务端口径。 */
  readonly openLeftovers: number;
}

export interface ProjectOverviewIteration {
  readonly recordId: number;
  readonly code: string;
  readonly title: string;
  readonly publishedAt: string;
}

export interface ProjectOverviewLeftover {
  readonly leftoverId: number;
  readonly summary: string;
  readonly recordCode: string;
  /** R-2 第二轮扩展已提供来源记录标题；显示层展示编号 + 标题。 */
  readonly recordTitle: string;
}

export interface ProjectOverviewResult {
  readonly stats: ProjectOverviewStats;
  readonly recentIterations: readonly ProjectOverviewIteration[];
  readonly leftovers: readonly ProjectOverviewLeftover[];
}

export interface ProjectOverviewQueryInput {
  readonly projectId: number;
}

export interface ProjectOverviewAdapter {
  readonly source: "mock" | "server";
  readonly notice: string;
  fetchProjectOverview(
    input: ProjectOverviewQueryInput,
  ): Promise<ProjectOverviewResult>;
}
