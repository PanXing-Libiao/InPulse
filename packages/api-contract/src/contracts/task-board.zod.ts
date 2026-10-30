import { z } from "zod";

import { userRefSchema } from "./aggregate-read.zod.js";
import { projectStatusSchema } from "./projects.zod.js";

const id = z.number().int().positive().max(2147483647);

/**
 * R-8 项目任务看板契约（项目任务看板，2026-09-18 视觉与交互定稿）。
 *
 * 口径（与功能设计 29 节统计口径对齐，全部由服务端聚合，前端不重算）：
 * 1. 看板集合 = 项目内 lifecycle_status = ACTIVE 的任务（不含已归档与无效任务），
 *    再排除任务组的历史来源分支；已取消任务保留在集合中作为历史标记。
 * 2. 完成率 = 已完成 /（已完成 + 未完成），已取消与历史来源分支不计入分母（29.2 节）。
 * 3. 逾期 / 今日到期 / 本周完成与卡片截止状态均由服务端按 Asia/Shanghai 与同一次
 *    查询的 now() 计算，前端不得按客户端时钟重算，避免时区与时钟偏差。
 * 4. 单项目任务超过 TASK_BOARD_TASKS_MAX 时截断并置 truncated = true；顶部统计与
 *    泳道统计仍为全量口径，与列表截断无关。
 */
export const TASK_BOARD_TASKS_MAX = 1000;
export const TASK_BOARD_MODULES_MAX = 200;
export const TASK_BOARD_LANE_AVATARS_MAX = 24;
/** 卡片负责人上限；与 ADR-040 的请求侧 assigneeIds 上限（20）保持一致。 */
export const TASK_BOARD_CARD_ASSIGNEES_MAX = 20;

/** 卡片截止状态；只对未完成任务取值，已完成 / 已取消 / 未设截止为 NONE。 */
export const TASK_BOARD_DUE_STATES = [
  "OVERDUE",
  "TODAY",
  "SCHEDULED",
  "NONE",
] as const;

/** 看板项目头；返回原始状态枚举，展示文案由前端映射。 */
export const taskBoardProjectSchema = z
  .object({
    projectId: id,
    name: z.string().min(1).max(200),
    status: projectStatusSchema,
  })
  .strict()
  .meta({ id: "TaskBoardProject" });

export type TaskBoardProject = z.infer<typeof taskBoardProjectSchema>;

/**
 * 看板项目级统计。总分母 total 为看板集合大小；completionRate 为 0..100 的整数
 * 百分比，分母（done + open）为 0 时取 0；memberCount 为项目成员数（与 R-2 同源）。
 */
export const taskBoardStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    dueToday: z.number().int().nonnegative(),
    completedThisWeek: z.number().int().nonnegative(),
    completionRate: z.number().int().min(0).max(100),
    memberCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "TaskBoardStats" });

export type TaskBoardStats = z.infer<typeof taskBoardStatsSchema>;

/**
 * 看板任务卡。assignees 为全部负责人的展示字段（ADR-040 平权集合，按 userId 升序，
 * 至少一人，2026-09-23 由单值 assignee 收口为集合）；publishedRecordCount 为
 * 该任务 PUBLISHED 记录数（29.4 节，
 * 不按版本计数）；dueState 由服务端按 Asia/Shanghai 计算。
 */
export const taskBoardCardSchema = z
  .object({
    taskId: id,
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    moduleId: id,
    priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]),
    dueAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    dueState: z.enum(TASK_BOARD_DUE_STATES),
    assignees: z.array(userRefSchema).min(1).max(TASK_BOARD_CARD_ASSIGNEES_MAX),
    publishedRecordCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "TaskBoardCard" });

export type TaskBoardCard = z.infer<typeof taskBoardCardSchema>;

/** 泳道统计；分母口径与项目级一致（completionRate 使用 done + open）。 */
export const taskBoardModuleStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    completionRate: z.number().int().min(0).max(100),
  })
  .strict()
  .meta({ id: "TaskBoardModuleStats" });

export type TaskBoardModuleStats = z.infer<typeof taskBoardModuleStatsSchema>;

/**
 * 看板泳道（模块泳道）。assignees 为该模块下有任务的全部负责人（去重、按首次出现
 * 顺序，最多 TASK_BOARD_LANE_AVATARS_MAX 人，供泳道头像组展示）。
 */
export const taskBoardModuleSchema = z
  .object({
    moduleId: id,
    name: z.string().min(1).max(200),
    stats: taskBoardModuleStatsSchema,
    assignees: z.array(userRefSchema).max(TASK_BOARD_LANE_AVATARS_MAX),
    tasks: z.array(taskBoardCardSchema).max(TASK_BOARD_TASKS_MAX),
  })
  .strict()
  .meta({ id: "TaskBoardModule" });

export type TaskBoardModule = z.infer<typeof taskBoardModuleSchema>;

/**
 * R-8 响应：项目头 + 服务端生成时间 + 项目级统计 + 模块泳道；
 * truncated = true 表示任务超过上限被截断，统计仍为全量口径。
 */
export const taskBoardResponseSchema = z
  .object({
    project: taskBoardProjectSchema,
    generatedAt: z.iso.datetime(),
    stats: taskBoardStatsSchema,
    modules: z.array(taskBoardModuleSchema).max(TASK_BOARD_MODULES_MAX),
    truncated: z.boolean(),
  })
  .strict()
  .meta({ id: "TaskBoardResponse" });

export type TaskBoardResponse = z.infer<typeof taskBoardResponseSchema>;
