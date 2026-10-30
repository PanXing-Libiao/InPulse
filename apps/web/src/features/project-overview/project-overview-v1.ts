import type { ProjectStatus } from "@generated/api";

import type {
  ProjectOverviewIteration,
  ProjectOverviewLeftover,
  ProjectOverviewResult,
} from "./project-overview-types";

/**
 * R-2 getProjectOverview 的 A 岗冻结契约映射（F-29 项目概览）。
 *
 * 冻结事实见 docs/a-contract-review-f25-f29-f32.md §2、§3、Q-06、Q-13 ~ Q-15：
 * 路径 GET /api/v1/projects/{projectId}/overview；查询参数 recentRecordLimit 与
 * activeLeftoverLimit 均为 1..10，默认 3 / 2，越界或非整数由服务端 422 拒绝；
 * 响应为 project / memberCount / stats（4 项）/ recentRecords / activeLeftovers。
 *
 * 本文件只做参数收口与无损映射：不发起请求、不引入生成客户端、不改契约。
 * 第二轮契约扩展后 activeLeftoverTotal 与 leftover.recordTitle 已接线，
 * 缺口清单清零，所有字段均为服务端实时数据。
 */

export const PROJECT_OVERVIEW_V1_PATH = "/api/v1/projects/{projectId}/overview";
export const PROJECT_OVERVIEW_V1_RECENT_RECORD_LIMIT_DEFAULT = 3;
export const PROJECT_OVERVIEW_V1_ACTIVE_LEFTOVER_LIMIT_DEFAULT = 2;
export const PROJECT_OVERVIEW_V1_LIMIT_MIN = 1;
export const PROJECT_OVERVIEW_V1_LIMIT_MAX = 10;

export interface ProjectOverviewV1Query {
  readonly recentRecordLimit: number;
  readonly activeLeftoverLimit: number;
}

export interface ProjectOverviewV1QueryInput {
  readonly recentRecordLimit?: number;
  readonly activeLeftoverLimit?: number;
}

export interface ProjectOverviewV1Project {
  readonly projectId: number;
  readonly name: string;
  /** ADR-035：项目四态与后端 projectStatusSchema 一致。 */
  readonly status: ProjectStatus;
}

export interface ProjectOverviewV1Stats {
  readonly activeModuleCount: number;
  readonly openTaskCount: number;
  readonly publishedRecordCount: number;
}

export interface ProjectOverviewV1RecentRecord {
  readonly recordId: number;
  readonly code: string;
  readonly title: string;
  readonly moduleId: number;
  readonly publishedAt: string;
}

export interface ProjectOverviewV1Leftover {
  readonly leftoverItemId: number;
  readonly recordId: number;
  readonly recordCode: string;
  readonly recordTitle: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface ProjectOverviewV1Response {
  readonly project: ProjectOverviewV1Project;
  readonly memberCount: number;
  readonly stats: ProjectOverviewV1Stats;
  readonly recentRecords: readonly ProjectOverviewV1RecentRecord[];
  readonly activeLeftoverTotal: number;
  readonly activeLeftovers: readonly ProjectOverviewV1Leftover[];
}

/**
 * 原骨架缺口清单：R-2 第二轮扩展已提供 activeLeftoverTotal 与
 * leftover.recordTitle，清单清零保留为入口；恢复缺口时必须同步补回。
 */
export const PROJECT_OVERVIEW_V1_MISSING_METRICS = [] as const;
export const PROJECT_OVERVIEW_V1_MISSING_FIELDS = [] as const;

export function isProjectOverviewV1LimitValid(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= PROJECT_OVERVIEW_V1_LIMIT_MIN &&
    value <= PROJECT_OVERVIEW_V1_LIMIT_MAX
  );
}

/** 未提供或越界的值回退默认值，避免把 422 边界的参数发给服务端。 */
export function toProjectOverviewV1Query(
  input: ProjectOverviewV1QueryInput = {},
): ProjectOverviewV1Query {
  const recent =
    input.recentRecordLimit ?? PROJECT_OVERVIEW_V1_RECENT_RECORD_LIMIT_DEFAULT;
  const leftover =
    input.activeLeftoverLimit ??
    PROJECT_OVERVIEW_V1_ACTIVE_LEFTOVER_LIMIT_DEFAULT;
  return {
    recentRecordLimit: isProjectOverviewV1LimitValid(recent)
      ? recent
      : PROJECT_OVERVIEW_V1_RECENT_RECORD_LIMIT_DEFAULT,
    activeLeftoverLimit: isProjectOverviewV1LimitValid(leftover)
      ? leftover
      : PROJECT_OVERVIEW_V1_ACTIVE_LEFTOVER_LIMIT_DEFAULT,
  };
}

/** 无损映射：冻结字段到骨架的最近迭代视图（moduleId 不进入视图）。 */
export function fromV1RecentRecords(
  items: readonly ProjectOverviewV1RecentRecord[],
): readonly ProjectOverviewIteration[] {
  return items.map((item) => ({
    recordId: item.recordId,
    code: item.code,
    title: item.title,
    publishedAt: item.publishedAt,
  }));
}

/**
 * R-2 响应 → F-29 骨架结果。
 *
 * 第二轮契约扩展后 openLeftovers 取 activeLeftoverTotal、
 * leftovers[].recordTitle 取服务端字段，无降级项。
 */
export function fromV1ProjectOverview(
  response: ProjectOverviewV1Response,
): ProjectOverviewResult {
  return {
    stats: {
      activeModules: response.stats.activeModuleCount,
      openTasks: response.stats.openTaskCount,
      publishedRecords: response.stats.publishedRecordCount,
      openLeftovers: response.activeLeftoverTotal,
    },
    recentIterations: fromV1RecentRecords(response.recentRecords),
    leftovers: response.activeLeftovers.map(
      (item): ProjectOverviewLeftover => ({
        leftoverId: item.leftoverItemId,
        summary: item.content,
        recordCode: item.recordCode,
        recordTitle: item.recordTitle,
      }),
    ),
  };
}
