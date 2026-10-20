import { z } from "zod";
import { userRefSchema } from "./aggregate-read.zod.js";

const id = z.number().int().positive().max(2147483647);

/**
 * F-33 迭代总结（年终总结）契约。
 *
 * 口径：只读聚合，服务端只返回事实——范围内可见的 PUBLISHED 正式记录、已完成
 * 任务、遗留问题与「已完成但没有任何记录」的缺口，外加计数；分节标题、正文措辞、
 * 分节顺序等派生展示值由客户端按事实计算，与 R-7 聚合组「服务端只透传事实字段」
 * 同一口径。不返回作废记录，不返回草稿。
 *
 * 范围：from / to 为 Asia/Shanghai 自然日（含首尾），服务端按服务器当前时区把
 * 日期换算成 [from 00:00, to 次日 00:00) 的半开区间；跨度过大（超过
 * RECORD_SUMMARY_RANGE_MAX_DAYS）返回 422，避免一次拉取整库历史。
 *
 * 授权：与 R-6 / R-7 / B-3b 同族，范围固定为服务端 AuthorizedProjectScope；
 * projectId / memberId 只用于收窄，越权项目被静默排除而不是返回 403 / 404。
 */
export const RECORD_SUMMARY_GROUPINGS = ["PROJECT", "MEMBER"] as const;

/** 单次总结允许的最大自然日跨度（含首尾）；超出返回 422。 */
export const RECORD_SUMMARY_RANGE_MAX_DAYS = 400;

/** 单个分节的要点条目上限；超出时置 truncated 并截断，不失败。 */
export const RECORD_SUMMARY_POINT_MAX = 300;

/** 单次总结返回的记录 / 任务 / 遗留问题条目总量上限。 */
export const RECORD_SUMMARY_ITEM_MAX = 2000;

const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
      86400000,
  ) + 1;

export const recordSummaryQueryRequestSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    projectId: z.coerce.number().int().positive().max(2147483647).optional(),
    memberId: z.coerce.number().int().positive().max(2147483647).optional(),
    groupBy: z.enum(RECORD_SUMMARY_GROUPINGS).default("PROJECT"),
  })
  .strict()
  .refine((value) => daysBetween(value.from, value.to) >= 1, {
    message: "起始日期不能晚于结束日期",
  })
  .refine(
    (value) =>
      daysBetween(value.from, value.to) <= RECORD_SUMMARY_RANGE_MAX_DAYS,
    {
      message: `单次总结最多覆盖 ${String(RECORD_SUMMARY_RANGE_MAX_DAYS)} 个自然日`,
    },
  )
  .meta({ id: "RecordSummaryQueryRequest" });

export type RecordSummaryQueryRequest = z.infer<
  typeof recordSummaryQueryRequestSchema
>;

/** 总结实际生效的范围，回显给客户端做正文抬头（范围行不做本地时间换算）。 */
export const recordSummaryRangeSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict()
  .meta({ id: "RecordSummaryRange" });

export type RecordSummaryRange = z.infer<typeof recordSummaryRangeSchema>;

/** 总结计数；全部为范围内事实的计数，口径见各字段说明。 */
export const recordSummaryTotalsSchema = z
  .object({
    projectCount: z.number().int().nonnegative(),
    moduleCount: z.number().int().nonnegative(),
    featureCount: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
    missingRecordTaskCount: z.number().int().nonnegative(),
    leftoverCount: z.number().int().nonnegative(),
    closedLeftoverCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "RecordSummaryTotals" });

export type RecordSummaryTotals = z.infer<typeof recordSummaryTotalsSchema>;

/**
 * 正文要点：一条正式记录压成一行事实。detail 取 resultVerification（验证/结果），
 * 为空时退 changeSolution（改动）；两者都为空时由服务端填 title 本身，恒非空。
 */
export const recordSummaryPointSchema = z
  .object({
    recordId: id,
    recordCode: z.string().min(1).max(64),
    projectId: id,
    projectName: z.string().min(1).max(200),
    moduleId: id,
    moduleName: z.string().min(1).max(200),
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    title: z.string().min(1).max(500),
    detail: z.string().min(1).max(1000),
    author: userRefSchema,
    publishedAt: z.iso.datetime(),
    taskId: id.nullable(),
    taskCode: z.string().min(1).max(64).nullable(),
  })
  .strict()
  .meta({ id: "RecordSummaryPoint" });

export type RecordSummaryPoint = z.infer<typeof recordSummaryPointSchema>;

/**
 * 范围内遗留问题（来源记录的 publishedAt 落在范围内）。status 为遗留项当前处置
 * 状态：ACTIVE 未处理、CONVERTED / RESOLVED 已处理、VOIDED 已作废（父记录
 * 作废时派生）；后三者计入 totals.closedLeftoverCount。
 */
export const recordSummaryIssueSchema = z
  .object({
    leftoverItemId: id,
    recordId: id,
    recordCode: z.string().min(1).max(64),
    recordTitle: z.string().min(1).max(500),
    projectId: id,
    projectName: z.string().min(1).max(200),
    author: userRefSchema,
    content: z.string().min(1).max(10000),
    status: z.enum(["ACTIVE", "CONVERTED", "RESOLVED", "VOIDED"]),
    followupTaskId: id.nullable(),
    followupTaskCode: z.string().min(1).max(64).nullable(),
    publishedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "RecordSummaryIssue" });

export type RecordSummaryIssue = z.infer<typeof recordSummaryIssueSchema>;

/**
 * 缺口：范围内已完成、但所在功能（无功能时为其模块）在本范围内没有任何
 * PUBLISHED 记录的任务，年终总结里最容易漏掉。
 */
export const recordSummaryGapSchema = z
  .object({
    taskId: id,
    taskCode: z.string().min(1).max(64),
    projectId: id,
    projectName: z.string().min(1).max(200),
    moduleId: id,
    moduleName: z.string().min(1).max(200),
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    title: z.string().min(1).max(500),
    completedAt: z.iso.datetime(),
    assignee: userRefSchema,
  })
  .strict()
  .meta({ id: "RecordSummaryGap" });

export type RecordSummaryGap = z.infer<typeof recordSummaryGapSchema>;

/**
 * 分节事实：groupBy=PROJECT 时是项目，groupBy=MEMBER 时是成员。
 * key 为 String(projectId) 或 String(userId)；recordCount / completedTaskCount
 * 是该分节去重后的计数（模块级记录多功能引用仍计 1 条，与 F-18 统计口径一致）。
 */
export const recordSummarySectionSchema = z
  .object({
    key: z.string().min(1).max(64),
    projectId: id.nullable(),
    member: userRefSchema.nullable(),
    recordCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "RecordSummarySection" });

export type RecordSummarySection = z.infer<typeof recordSummarySectionSchema>;

export const recordSummaryResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    range: recordSummaryRangeSchema,
    groupBy: z.enum(RECORD_SUMMARY_GROUPINGS),
    scope: z
      .object({
        projectIds: z.array(id).max(RECORD_SUMMARY_ITEM_MAX),
        projectNames: z
          .array(z.string().min(1).max(200))
          .max(RECORD_SUMMARY_ITEM_MAX),
        member: userRefSchema.nullable(),
      })
      .strict(),
    totals: recordSummaryTotalsSchema,
    sections: z.array(recordSummarySectionSchema).max(RECORD_SUMMARY_ITEM_MAX),
    points: z.array(recordSummaryPointSchema).max(RECORD_SUMMARY_ITEM_MAX),
    leftovers: z.array(recordSummaryIssueSchema).max(RECORD_SUMMARY_ITEM_MAX),
    gaps: z.array(recordSummaryGapSchema).max(RECORD_SUMMARY_ITEM_MAX),
    truncated: z.boolean(),
  })
  .strict()
  .meta({ id: "RecordSummaryResponse" });

export type RecordSummaryResponse = z.infer<typeof recordSummaryResponseSchema>;

export const recordSummarySchemas = {
  RecordSummaryQueryRequest: {
    schema: recordSummaryQueryRequestSchema,
    summary:
      "迭代总结取数范围（from / to 为 Asia/Shanghai 自然日，含首尾）、项目与成员收窄、分组口径 PROJECT / MEMBER；跨度上限 400 天，越界或起止倒置返回 422",
    sensitiveFieldPaths: [],
  },
  RecordSummaryRange: {
    schema: recordSummaryRangeSchema,
    summary: "总结实际生效的自然日范围回显",
    sensitiveFieldPaths: [],
  },
  RecordSummaryTotals: {
    schema: recordSummaryTotalsSchema,
    summary:
      "范围内项目 / 模块 / 功能 / 记录 / 已完成任务 / 缺口 / 遗留问题计数",
    sensitiveFieldPaths: [],
  },
  RecordSummaryPoint: {
    schema: recordSummaryPointSchema,
    summary: "正文要点：一条 PUBLISHED 记录的标题与效果句等事实",
    sensitiveFieldPaths: [],
  },
  RecordSummaryIssue: {
    schema: recordSummaryIssueSchema,
    summary: "范围内遗留问题及其处置状态与跟进任务引用",
    sensitiveFieldPaths: [],
  },
  RecordSummaryGap: {
    schema: recordSummaryGapSchema,
    summary: "已完成但所在范围没有任何记录的任务",
    sensitiveFieldPaths: [],
  },
  RecordSummarySection: {
    schema: recordSummarySectionSchema,
    summary: "按项目或成员分节的事实与计数",
    sensitiveFieldPaths: [],
  },
  RecordSummaryResponse: {
    schema: recordSummaryResponseSchema,
    summary:
      "迭代总结事实集：范围、分组、计数、分节、要点、遗留问题与缺口；正文措辞由客户端按事实渲染",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
