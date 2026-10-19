import { z } from "zod";

export const ACTIVITY_PAGE_LIMIT_MAX = 50;
export const ACTIVITY_CURSOR_MAX_LENGTH = 512;

/** 按日总数最多回传的自然日数量；超出时置 dayTotalsTruncated 并截断，不失败。 */
export const ACTIVITY_DAY_TOTALS_MAX = 400;

/** 聚合动态允许过滤的项目数量上限（与 R-5 taskIds 同一约定）。 */
export const ACTIVITY_FEED_PROJECT_IDS_MAX = 100;

export const activitySourceEntityTypeSchema = z.enum([
  "PROJECT",
  "MODULE",
  "FEATURE",
  "TASK",
  "CHANGE_RECORD",
  "EXTERNAL_LINK",
  "TASK_GROUP",
  "LEFTOVER_ITEM",
]);

/**
 * 动态分类筛选：与前端 chip 行一一对应，服务端按 activityType /
 * sourceEntityType 归类（映射口径见技术设计 §5 与 activity-labels）。
 * `all` 等价于不传；未知取值由契约层返回 422。
 */
export const ACTIVITY_CATEGORIES = [
  "all",
  "task",
  "record",
  "feature",
  "module",
  "project",
  "member",
  "github",
] as const;

export const activityCategorySchema = z.enum(ACTIVITY_CATEGORIES);

export type ActivityCategory = z.infer<typeof activityCategorySchema>;

const booleanField = z.preprocess((value) => {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}, z.boolean());

export const activityPathSchema = z
  .object({
    projectId: z.coerce.number().int().positive(),
  })
  .strict()
  .meta({ id: "ActivityPath" });

export const activityQueryRequestSchema = z
  .object({
    cursor: z.string().min(1).max(ACTIVITY_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_PAGE_LIMIT_MAX)
      .optional(),
    includeAdminOnly: booleanField.optional(),
    category: activityCategorySchema.optional(),
  })
  .strict()
  .meta({ id: "ActivityQueryRequest" });

/**
 * 聚合动态查询参数（GET /activity）。
 *
 * projectIds 是以英文逗号分隔的 1..100 个正整数；服务端把它与「实时授权范围
 * ∪ 全部已删除项目」求交集，越权或未知项目静默排除而不是 404（与 R-3 / R-6
 * 同族的聚合读口径）。缺省表示「全部项目」：授权范围内的活跃项目加全部已删除
 * 项目的公开动态链（ADR-050 / ADR-052）。
 */
export const activityFeedQueryRequestSchema = z
  .object({
    projectIds: z
      .preprocess(
        // 缺省（键不存在）由 .optional() 短路；显式给出时必须是逗号分隔的正整数，
        // 空串与非字符串一律交给下面的规则报错，不得静默当作「全部项目」。
        (value) =>
          typeof value === "string"
            ? value.length === 0
              ? []
              : value.split(",")
            : value,
        z
          .array(z.coerce.number().int().positive().max(2147483647))
          .min(1)
          .max(ACTIVITY_FEED_PROJECT_IDS_MAX)
          .refine((ids) => new Set(ids).size === ids.length, {
            message: "projectIds 不得重复",
          }),
      )
      .optional(),
    cursor: z.string().min(1).max(ACTIVITY_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_PAGE_LIMIT_MAX)
      .optional(),
    includeAdminOnly: booleanField.optional(),
    category: activityCategorySchema.optional(),
  })
  .strict()
  .meta({ id: "ActivityFeedQueryRequest" });

export const activityItemSchema = z
  .object({
    id: z.string().min(1).max(80),
    projectId: z.number().int().positive(),
    sourceEntityType: activitySourceEntityTypeSchema,
    sourceEntityId: z.number().int().positive(),
    activityType: z.string().min(1).max(100),
    actorId: z.number().int().positive().nullable(),
    /** 当前展示名；墓碑账号固定为「删除用户」，系统事件为 null。 */
    actorName: z.string().min(1).max(200).nullable(),
    summary: z.string().min(1).max(1000),
    occurredAt: z.string().min(1).max(64),
  })
  .strict()
  .meta({ id: "ActivityItem" });

/**
 * 某个 Asia/Shanghai 自然日的动态总数（服务端按全量口径统计，不随分页增长）。
 * 客户端按它渲染日期旁的数量，而不是按已加载条目数。
 */
export const activityDayTotalSchema = z
  .object({
    day: z.iso.date(),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "ActivityDayTotal" });

export const activityPageSchema = z
  .object({
    items: z.array(activityItemSchema).max(ACTIVITY_PAGE_LIMIT_MAX),
    nextCursor: z.string().min(1).max(ACTIVITY_CURSOR_MAX_LENGTH).nullable(),
    hasMore: z.boolean(),
    dayTotals: z.array(activityDayTotalSchema).max(ACTIVITY_DAY_TOTALS_MAX),
    dayTotalsTruncated: z.boolean(),
  })
  .strict()
  .meta({ id: "ActivityPage" });

export type ActivityPath = z.infer<typeof activityPathSchema>;
export type ActivityQueryRequest = z.infer<typeof activityQueryRequestSchema>;
export type ActivityFeedQueryRequest = z.infer<
  typeof activityFeedQueryRequestSchema
>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityDayTotal = z.infer<typeof activityDayTotalSchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
