import type {
  TaskBoardCard,
  TaskBoardModule,
  TaskBoardProject,
  TaskBoardResponse,
  TaskBoardStats,
  UserRef,
} from "@generated/api";

/**
 * R-8 项目任务看板视图类型（GET /api/v1/projects/{projectId}/task-board）。
 *
 * 契约事实（packages/api-contract/src/contracts/task-board.zod.ts）：
 * 统计、逾期 / 今日到期 / 本周完成、卡片截止状态（dueState）全部由服务端按
 * Asia/Shanghai 计算，前端只做展示映射，不按客户端时钟重算；
 * 任务超过 1000 条时 truncated = true，顶部与泳道统计仍为全量口径。
 *
 * 筛选是纯展示层行为：服务端一次返回项目全量看板，前端在本地过滤
 * （V1 单项目任务量与 1000 上限一致），顶部统计始终保持全量口径，
 * 与筛选结果并存展示，避免「完成率 0%」误读。
 */

export type TaskBoardPriority = TaskBoardCard["priority"];
export type TaskBoardWorkStatus = TaskBoardCard["workStatus"];
export type TaskBoardDueState = TaskBoardCard["dueState"];

/** 视图切换：看板（模块泳道）/ 列表（分组表格）。 */
export type TaskBoardView = "board" | "list";

/**
 * 状态筛选；对应工具栏的 3 个状态 chip。2026-10-09 按用户要求移除 `canceled`：
 * ADR-096 之后取消任务入口已下线，该筛选恒无命中。
 */
export type TaskBoardStatusFilter = "all" | "open" | "done";

/** 时间筛选；overdue / today 均由服务端 dueState 派生。 */
export type TaskBoardTimeFilter = "all" | "overdue" | "today";

export interface TaskBoardFilters {
  readonly view: TaskBoardView;
  readonly status: TaskBoardStatusFilter;
  readonly time: TaskBoardTimeFilter;
  readonly priority: TaskBoardPriority | null;
  readonly assigneeId: number | null;
  readonly query: string;
}

export interface TaskBoardQueryInput {
  readonly projectId: number;
}

/** 数据源适配器；页面默认注入 server 实现，测试可注入内存实现。 */
export interface TaskBoardAdapter {
  readonly source: "server" | "test";
  readonly notice: string;
  fetchTaskBoard(input: TaskBoardQueryInput): Promise<TaskBoardResponse>;
}

export type {
  TaskBoardCard,
  TaskBoardModule,
  TaskBoardProject,
  TaskBoardResponse,
  TaskBoardStats,
  UserRef,
};
