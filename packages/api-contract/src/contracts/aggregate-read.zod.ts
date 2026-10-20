import { z } from "zod";

import { projectStatusSchema } from "./projects.zod.js";

const id = z.number().int().positive().max(2147483647);

/** R-3 任务优先级；与 app.tasks.tasks_priority_check 的取值一致。 */
export const TASK_PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const;

/** R-5 批量任务 ID 上限：单次 1..100 个；数量、格式或重复校验失败返回 422。 */
export const TASK_GROUP_MEMBERSHIP_IDS_MAX = 100;

/** R-3 遗留问题摘要上限：取最新版本 content 前 200 个字符，截断时追加 “…” 。 */
export const MY_TASK_LEFTOVER_SUMMARY_MAX = 200;

/**
 * F-25 / F-29 / F-32 聚合读契约（A 裁决见 docs/a-contract-review-f25-f29-f32.md）。
 * 分页 envelope 与 getSearch 同一约定（C-006）：items / nextCursor / hasMore，
 * 游标为服务端签名、校验并带过期时间的不透明字符串；limit 默认 20、上限 100。
 */
export const AGGREGATE_READ_PAGE_LIMIT_DEFAULT = 20;
export const AGGREGATE_READ_PAGE_LIMIT_MAX = 100;
export const AGGREGATE_READ_CURSOR_MAX_LENGTH = 256;
/** R-2 收口参数（Q-06）：默认 3 / 2，上限 10；越界或非整数由服务端返回 422。 */
export const PROJECT_OVERVIEW_RECENT_LIMIT_DEFAULT = 3;
export const PROJECT_OVERVIEW_LEFTOVER_LIMIT_DEFAULT = 2;
export const PROJECT_OVERVIEW_LIST_LIMIT_MAX = 10;

/** 查询字符串布尔值；与 getSearch 的 includeVoid 同一解析口径，未知文本判为非法输入。 */
const queryBoolean = z.preprocess((value) => {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}, z.boolean());

/** 聚合读共用的用户引用；只含展示字段，不暴露登录名、邮箱或凭据材料。 */
export const userRefSchema = z
  .object({
    userId: id,
    name: z.string().min(1).max(200),
    avatarUrl: z.string().min(1).max(2048).nullable(),
  })
  .strict()
  .meta({ id: "UserRef" });

export type UserRef = z.infer<typeof userRefSchema>;

/** 聚合组路径参数；Q-01 保持全局路径，项目归属由服务端按 groupId 反查。 */
export const taskGroupPathSchema = z
  .object({ groupId: z.coerce.number().int().positive().max(2147483647) })
  .strict()
  .meta({ id: "TaskGroupPath" });

export type TaskGroupPath = z.infer<typeof taskGroupPathSchema>;

/** R-1 聚合组摘要；closedAt 只在 CLOSED 时有值。 */
export const taskGroupSummarySchema = z
  .object({
    groupId: id,
    projectId: id,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(500),
    status: z.enum(["ACTIVE", "CLOSED"]),
    createdAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
    rowVersion: id,
  })
  .strict()
  .meta({ id: "TaskGroupSummary" });

export type TaskGroupSummary = z.infer<typeof taskGroupSummarySchema>;

/**
 * R-1 成员明细。role 与 sourceKind 是两个正交维度：sourceKind 表示分支是否仍可
 * 继续工作，memberStatus 表示合并关系是否已解除；已解除成员仍需展示历史。
 * sourceKind 的可空性由 role 决定（MAIN 恒为 null、SOURCE 必非空），契约不额外收窄，
 * 服务端按数据库 task_group_members_snapshot_check 的同一形状返回。
 *
 * publishedRecordCount 是该任务 PUBLISHED 正式记录数（功能设计 §29.4：按
 * change_records 计数，不按版本计数，也不按影响功能去重）。
 * priority 是分支任务当前优先级，featureName 是所属功能名称；任务为模块级作用域时
 * featureId 与 featureName 同时为 null（2026-09-21 聚合组弹窗按名称展示功能）。
 */
export const taskGroupMemberDetailSchema = z
  .object({
    taskId: id,
    taskCode: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    role: z.enum(["MAIN", "SOURCE"]),
    sourceKind: z.enum(["ACTIVE", "HISTORICAL"]).nullable(),
    memberStatus: z.enum(["ACTIVE", "DETACHED"]),
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]),
    priority: z.enum(TASK_PRIORITIES),
    // ADR-054：任务层面下线归档，ARCHIVED 不可达。
    lifecycleStatus: z.enum(["ACTIVE", "INVALID"]),
    moduleId: id,
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    assignee: userRefSchema,
    joinedAt: z.iso.datetime(),
    detachedAt: z.iso.datetime().nullable(),
    detachReason: z.string().min(1).max(10000).nullable(),
    publishedRecordCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "TaskGroupMemberDetail" });

export type TaskGroupMemberDetail = z.infer<typeof taskGroupMemberDetailSchema>;

/**
 * R-1 响应：只返回组与成员；记录列表按 Q-02 形态 B 拆到 R-4 子资源分页。
 * 成员排序由服务端固定：主任务在前，来源任务按 joinedAt 升序、taskId 升序。
 */
export const taskGroupDetailResponseSchema = z
  .object({
    group: taskGroupSummarySchema,
    members: z.array(taskGroupMemberDetailSchema).max(1000),
  })
  .strict()
  .meta({ id: "TaskGroupDetailResponse" });

export type TaskGroupDetailResponse = z.infer<
  typeof taskGroupDetailResponseSchema
>;

/** R-4 查询参数；memberTaskId 缺省表示组内全部成员任务，过滤在服务端执行。 */
export const taskGroupRecordQueryRequestSchema = z
  .object({
    memberTaskId: z.coerce.number().int().positive().max(2147483647).optional(),
    cursor: z.string().min(1).max(AGGREGATE_READ_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGGREGATE_READ_PAGE_LIMIT_MAX)
      .optional(),
  })
  .strict()
  .meta({ id: "TaskGroupRecordQueryRequest" });

export type TaskGroupRecordQueryRequest = z.infer<
  typeof taskGroupRecordQueryRequestSchema
>;

/**
 * R-4 记录上的 GitHub 链接。titleSnapshot / stateSnapshot 是关联时刻快照，
 * 不是远程实时状态（Q-14）；externalNumber 按数据库 bigint 以字符串承载，
 * 与既有 ExternalLinkItem 的表示一致。
 */
export const taskGroupRecordLinkSchema = z
  .object({
    linkId: id,
    displayUrl: z.string().min(1).max(2048),
    kind: z.enum(["ISSUE", "PULL_REQUEST", "COMMIT", "OTHER"]),
    repository: z.string().min(3).max(201).nullable(),
    externalNumber: z.string().max(20).nullable(),
    externalSha: z.string().min(7).max(64).nullable(),
    titleSnapshot: z.string().min(1).max(500).nullable(),
    stateSnapshot: z.string().min(1).max(100).nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "TaskGroupRecordLink" });

export type TaskGroupRecordLink = z.infer<typeof taskGroupRecordLinkSchema>;

/**
 * R-4 记录条目：只含 PUBLISHED 与 VOID（Q-13，DRAFT 不可见）；
 * sourceLabel 为「主任务」或来源任务编号，由服务端按组成员推导；
 * featureName 是记录所属功能名称，与 featureId 同为 null 表示记录属模块级作用域。
 */
export const taskGroupRecordItemSchema = z
  .object({
    recordId: id,
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    recordStatus: z.enum(["PUBLISHED", "VOID"]),
    taskId: id,
    sourceLabel: z.string().min(1).max(64),
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    publishedAt: z.iso.datetime(),
    externalLinks: z.array(taskGroupRecordLinkSchema).max(100),
  })
  .strict()
  .meta({ id: "TaskGroupRecordItem" });

export type TaskGroupRecordItem = z.infer<typeof taskGroupRecordItemSchema>;

/** R-4 分页响应（C-006 envelope）。 */
export const taskGroupRecordPageSchema = z
  .object({
    items: z
      .array(taskGroupRecordItemSchema)
      .max(AGGREGATE_READ_PAGE_LIMIT_MAX),
    nextCursor: z
      .string()
      .min(1)
      .max(AGGREGATE_READ_CURSOR_MAX_LENGTH)
      .nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "TaskGroupRecordPage" });

export type TaskGroupRecordPage = z.infer<typeof taskGroupRecordPageSchema>;

/** R-2 收口参数（Q-06）：recentRecordLimit 默认 3、activeLeftoverLimit 默认 2，上限 10。 */
export const projectOverviewQueryRequestSchema = z
  .object({
    recentRecordLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PROJECT_OVERVIEW_LIST_LIMIT_MAX)
      .optional(),
    activeLeftoverLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PROJECT_OVERVIEW_LIST_LIMIT_MAX)
      .optional(),
  })
  .strict()
  .meta({ id: "ProjectOverviewQueryRequest" });

export type ProjectOverviewQueryRequest = z.infer<
  typeof projectOverviewQueryRequestSchema
>;

/**
 * 项目概览的项目头；返回项目四态原始枚举，展示文案（未开始 / 进行中 / 维护中 / 已归档）
 * 由前端映射（Q-15）。
 */
export const projectOverviewProjectSchema = z
  .object({
    projectId: id,
    name: z.string().min(1).max(200),
    status: projectStatusSchema,
  })
  .strict()
  .meta({ id: "ProjectOverviewProject" });

export type ProjectOverviewProject = z.infer<
  typeof projectOverviewProjectSchema
>;

/**
 * 项目概览四项统计：活跃模块 / 活跃功能按行自身 status = ACTIVE 计数（Q-05）；
 * openTaskCount 为功能设计 §29.1 有效任务中 work_status = TODO 的计数；
 * publishedRecordCount 只计 PUBLISHED（§29.4，版本与影响功能不重复计数）。
 */
export const projectOverviewStatsSchema = z
  .object({
    activeModuleCount: z.number().int().nonnegative(),
    activeFeatureCount: z.number().int().nonnegative(),
    openTaskCount: z.number().int().nonnegative(),
    publishedRecordCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "ProjectOverviewStats" });

export type ProjectOverviewStats = z.infer<typeof projectOverviewStatsSchema>;

/** 最近迭代条目；featureName 用于「功能名：记录标题」展示，模块级记录为 null。 */
export const recentRecordItemSchema = z
  .object({
    recordId: id,
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    moduleId: id,
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    publishedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "RecentRecordItem" });

export type RecentRecordItem = z.infer<typeof recentRecordItemSchema>;

/** 待处理遗留问题条目；content 取该遗留项最新版本的内容快照。 */
export const leftoverItemSummarySchema = z
  .object({
    leftoverItemId: id,
    recordId: id,
    recordCode: z.string().min(1).max(64),
    recordTitle: z.string().min(1).max(500),
    content: z.string().min(1).max(10000),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "LeftoverItemSummary" });

export type LeftoverItemSummary = z.infer<typeof leftoverItemSummarySchema>;

/** R-2 响应：项目头 + 成员数 + 四项统计 + 最近迭代 + 待处理遗留问题。 */
export const projectOverviewResponseSchema = z
  .object({
    project: projectOverviewProjectSchema,
    memberCount: z.number().int().nonnegative(),
    stats: projectOverviewStatsSchema,
    recentRecords: z
      .array(recentRecordItemSchema)
      .max(PROJECT_OVERVIEW_LIST_LIMIT_MAX),
    activeLeftoverTotal: z.number().int().nonnegative(),
    activeLeftovers: z
      .array(leftoverItemSummarySchema)
      .max(PROJECT_OVERVIEW_LIST_LIMIT_MAX),
  })
  .strict()
  .meta({ id: "ProjectOverviewResponse" });

export type ProjectOverviewResponse = z.infer<
  typeof projectOverviewResponseSchema
>;

/**
 * R-3 查询参数。归属主体固定为当前用户，不接受 assigneeId / creatorId / userId /
 * projectIds：projectId 只用于缩小范围，服务端仍按 AuthorizedProjectScope 复验（Q-08）。
 * V1 承载 F-32 的筛选（Q-09 / §10.3）；排序固定 id DESC，不提供 sort（Q-10）。
 */
export const myTasksQueryRequestSchema = z
  .object({
    cursor: z.string().min(1).max(AGGREGATE_READ_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGGREGATE_READ_PAGE_LIMIT_MAX)
      .optional(),
    projectId: z.coerce.number().int().positive().max(2147483647).optional(),
    /**
     * 归属维度（F-32 任务中心「我负责的 / 我创建的」分段）：
     * ASSIGNEE = 当前用户负责的任务（缺省，与历史行为一致）；
     * CREATOR = 当前用户创建的任务，用于跟踪已指派给他人的任务。
     * 两个取值都只使用当前 Session 用户的身份，仍按 AuthorizedProjectScope
     * 过滤，不引入任何他人身份或授权范围参数（Q-08）。
     */
    ownership: z.enum(["ASSIGNEE", "CREATOR"]).optional(),
    scopeType: z.enum(["FEATURE", "MODULE"]).optional(),
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]).optional(),
    hasPublishedRecord: queryBoolean.optional(),
    /** 单值优先级筛选；与 workStatus 正交（A 裁决 §10.3）。 */
    priority: z.enum(TASK_PRIORITIES).optional(),
    /**
     * 与 workStatus 组合表达「未完成并含已取消」（TODO ∪ CANCELED）；
     * workStatus 缺省时的全集本就包含 CANCELED，该参数不产生额外过滤。
     */
    includeCanceled: queryBoolean.optional(),
    /**
     * 「今日待办」集合（F-32 统计卡与列表联动）：work_status = 'TODO' 且满足
     * 逾期 ∪ 遗留来源 ∪ 标记紧急 ∪ 距截止 7 个日历日内（Asia/Shanghai）任一条件；
     * 缺省 false 时该参数不产生额外过滤。
     */
    todayTodo: queryBoolean.optional(),
  })
  .strict()
  .meta({ id: "MyTasksQueryRequest" });

export type MyTasksQueryRequest = z.infer<typeof myTasksQueryRequestSchema>;

/**
 * R-3 列表项。hasPublishedRecord 为单条 SQL 内先过滤后分页的存在性判断；
 * publishedRecordCount 与它同源同口径（裁决修订 D-1：按 change_records 计数，
 * 不按版本计数、不按影响功能去重），恒有
 * hasPublishedRecord === publishedRecordCount > 0；
 * groupRole 是任务在当前 ACTIVE 聚合组中的角色，不属于任何组时为 null（Q-11）；
 * hasLeftoverSource 标记任务是否由遗留问题转换而来（裁决修订 D-2）。
 */
export const myTaskItemSchema = z
  .object({
    taskId: id,
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    projectId: id,
    projectName: z.string().min(1).max(200),
    moduleId: id,
    moduleName: z.string().min(1).max(200),
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    scopeType: z.enum(["FEATURE", "MODULE"]),
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]),
    // ADR-054：任务层面下线归档，ARCHIVED 不可达。
    lifecycleStatus: z.enum(["ACTIVE", "INVALID"]),
    /**
     * 派生展示字段：恒等于 assignees[0]，与 assignees 同源同口径（ADR-040）。
     * 集合本身是唯一真相，取值不一致时以 assignees 为准。
     */
    assignee: userRefSchema,
    /** 全部负责人，按 userId 升序且至少一名、至多 20 名（ADR-040 多负责人平权）。 */
    assignees: z.array(userRefSchema).min(1).max(20),
    updatedAt: z.iso.datetime(),
    priority: z.enum(TASK_PRIORITIES),
    /** null = 未设置截止；与骨架的 undefined（不可知）语义不同。 */
    dueAt: z.iso.datetime().nullable(),
    /** 与 work_status = 'DONE' 同真（tasks_completion_state_check）。 */
    completedAt: z.iso.datetime().nullable(),
    creatorId: id,
    /** 该任务经 task_external_links 关联的外部链接条数，按链接去重。 */
    githubLinkCount: z.number().int().nonnegative(),
    hasPublishedRecord: z.boolean(),
    /** 与 hasPublishedRecord 同源同口径（裁决修订 D-1），无 PUBLISHED 记录为 0。 */
    publishedRecordCount: z.number().int().nonnegative(),
    groupRole: z.enum(["MAIN", "SOURCE"]).nullable(),
    /** 与 groupRole 同源、同空同非空；支撑「查看主任务」入口（A 裁决 §10.3）。 */
    groupId: id.nullable(),
    /**
     * 任务是否由遗留问题转换而来（F-20 / 裁决修订 D-2）：按 leftover_task_links
     * 存在链接行判定，与来源记录当前状态（PUBLISHED / VOID）无关。
     */
    hasLeftoverSource: z.boolean(),
  })
  .strict()
  .meta({ id: "MyTaskItem" });

export type MyTaskItem = z.infer<typeof myTaskItemSchema>;

/**
 * R-3 统计卡片口径（A 裁决 §10.3；2026-09-20 按任务中心新卡片重定口径）：
 * 基准集合 = projectId 生效、排除 INVALID / CANCELED 与历史来源分支的有效任务；
 * 分页与游标不影响计数，日界按业务时区 Asia/Shanghai 由服务端计算，客户端不得自行推导。
 * `todayTodo` / `myOpen` / `completed` 取负责人维度（assignee = 当前用户），
 * `created` 取创建人维度（creator = 当前用户，无论任务指派给谁）。
 */
export const myTaskTodayTodoBreakdownSchema = z
  .object({
    overdue: z.number().int().nonnegative(),
    leftover: z.number().int().nonnegative(),
    urgent: z.number().int().nonnegative(),
    dueWithinDays: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "MyTaskTodayTodoBreakdown" });

export type MyTaskTodayTodoBreakdown = z.infer<
  typeof myTaskTodayTodoBreakdownSchema
>;

/**
 * todayTodoBreakdown 的四个子项各自独立计数、可以互相重叠（例如同一任务既逾期又来自遗留问题），
 * 其并集即 todayTodo，不保证四项之和等于 todayTodo。
 */
export const myTaskStatsSchema = z
  .object({
    todayTodo: z.number().int().nonnegative(),
    todayTodoBreakdown: myTaskTodayTodoBreakdownSchema,
    myOpen: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "MyTaskStats" });

export type MyTaskStats = z.infer<typeof myTaskStatsSchema>;

/** R-3 遗留问题入口样例：summary 为最新版本 content 前 200 字符，截断时追加 “…” 。 */
export const myTaskLeftoverSampleSchema = z
  .object({
    recordCode: z.string().min(1).max(64),
    summary: z
      .string()
      .min(1)
      .max(MY_TASK_LEFTOVER_SUMMARY_MAX + 1),
  })
  .strict()
  .meta({ id: "MyTaskLeftoverSample" });

export type MyTaskLeftoverSample = z.infer<typeof myTaskLeftoverSampleSchema>;

/** R-3 分页响应（C-006 envelope）+ 统计与遗留问题入口（A 裁决 §10.3）。 */
export const myTaskPageSchema = z
  .object({
    items: z.array(myTaskItemSchema).max(AGGREGATE_READ_PAGE_LIMIT_MAX),
    nextCursor: z
      .string()
      .min(1)
      .max(AGGREGATE_READ_CURSOR_MAX_LENGTH)
      .nullable(),
    hasMore: z.boolean(),
    stats: myTaskStatsSchema,
    leftoverCount: z.number().int().nonnegative(),
    leftoverSample: myTaskLeftoverSampleSchema.nullable(),
  })
  .strict()
  .meta({ id: "MyTaskPage" });

export type MyTaskPage = z.infer<typeof myTaskPageSchema>;

/**
 * R-5 任务记录标记批量读（A 裁决 §10.4，裁决修订 D-1 / §11.4）。
 *
 * taskIds 是以英文逗号分隔的 1..100 个正整数；生成客户端对数组参数序列化为
 * 同一格式，服务端按此解析。数量、格式或重复校验失败统一返回 422；
 * 请求中每一个有权 taskId 都出现在结果中，未入组任务以 groupId / groupRole
 * 为 null 返回且计数照常；无权或不存在仍不出现，不泄露存在性。
 */
export const taskGroupMembershipQueryRequestSchema = z
  .object({
    taskIds: z.preprocess(
      (value) =>
        typeof value === "string" && value.length > 0
          ? value.split(",")
          : undefined,
      z
        .array(z.coerce.number().int().positive().max(2147483647))
        .min(1)
        .max(TASK_GROUP_MEMBERSHIP_IDS_MAX)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "taskIds 不得重复",
        }),
    ),
  })
  .strict()
  .meta({ id: "TaskGroupMembershipQueryRequest" });

export type TaskGroupMembershipQueryRequest = z.infer<
  typeof taskGroupMembershipQueryRequestSchema
>;

/**
 * R-5 任务记录标记条目（裁决修订 D-1 / §11.4）：groupRole / groupId 与既有
 * MyTaskItem 同源，未加入 ACTIVE 聚合组时同为空；publishedRecordCount 与
 * R-1 成员项、R-3 列表项同一口径（按 change_records 计数），无记录为 0；
 * hasLeftoverSource 与 R-3 列表项同源同口径（裁决修订 D-2）。
 */
export const taskGroupMembershipItemSchema = z
  .object({
    taskId: id,
    groupId: id.nullable(),
    groupRole: z.enum(["MAIN", "SOURCE"]).nullable(),
    publishedRecordCount: z.number().int().nonnegative(),
    hasLeftoverSource: z.boolean(),
  })
  .strict()
  .meta({ id: "TaskGroupMembershipItem" });

export type TaskGroupMembershipItem = z.infer<
  typeof taskGroupMembershipItemSchema
>;

/**
 * R-5 响应：items 按 taskId 升序，覆盖请求中每一个有权 taskId；
 * 无权或不存在（含跨项目）的任务不出现。
 */
export const taskGroupMembershipResponseSchema = z
  .object({
    items: z
      .array(taskGroupMembershipItemSchema)
      .max(TASK_GROUP_MEMBERSHIP_IDS_MAX),
  })
  .strict()
  .meta({ id: "TaskGroupMembershipResponse" });

export type TaskGroupMembershipResponse = z.infer<
  typeof taskGroupMembershipResponseSchema
>;
/**
 * R-6 / R-7：遗留问题与任务聚合组的跨项目聚合读列表（C 域）。
 * 两者沿用 C-006 envelope；授权范围固定为服务端 AuthorizedProjectScope，
 * projectId 只用于缩小范围（越权项目收敛为空页），非成员不产生 404。
 */

/**
 * 聚合读共用的任务引用；只含任务标识与所在位置，不复制任务实体。
 * featureId 为 null 表示模块级任务；前端据此还原任务深链。
 */
export const aggregateTaskRefSchema = z
  .object({
    taskId: id,
    code: z.string().min(1).max(64),
    projectId: id,
    moduleId: id,
    featureId: id.nullable(),
  })
  .strict()
  .meta({ id: "AggregateTaskRef" });

export type AggregateTaskRef = z.infer<typeof aggregateTaskRefSchema>;

/**
 * R-6 遗留问题列表查询参数。bucket 是展示分桶，不改变排序：
 * OPEN = 父记录 PUBLISHED 且 status ACTIVE；CLOSED = status CONVERTED / RESOLVED
 * 或父记录 VOID（对外派生 VOIDED）；
 * 缺省表示不按分桶过滤。排序固定 leftoverItemId DESC。
 */
export const leftoverListQueryRequestSchema = z
  .object({
    cursor: z.string().min(1).max(AGGREGATE_READ_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGGREGATE_READ_PAGE_LIMIT_MAX)
      .optional(),
    projectId: z.coerce.number().int().positive().max(2147483647).optional(),
    bucket: z.enum(["OPEN", "CLOSED"]).optional(),
  })
  .strict()
  .meta({ id: "LeftoverListQueryRequest" });

export type LeftoverListQueryRequest = z.infer<
  typeof leftoverListQueryRequestSchema
>;

/**
 * R-6 列表项：内容取该遗留项最新版本快照；sourceTask 为来源任务（独立记录为
 * null），followupTask 为已生成跟进任务（未转换 / 已解决时为 null）。记录只含
 * PUBLISHED 与 VOID（Q-13）；父记录为 VOID 时遗留项有效状态派生为 VOIDED，
 * 不持久化、恢复记录后回到原状态。author 为记录作者，不暴露登录名或邮箱。
 */
export const leftoverListItemSchema = z
  .object({
    leftoverItemId: id,
    recordId: id,
    recordCode: z.string().min(1).max(64),
    recordTitle: z.string().min(1).max(500),
    projectId: id,
    projectName: z.string().min(1).max(200),
    moduleId: id,
    moduleName: z.string().min(1).max(200),
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    author: userRefSchema,
    publishedAt: z.iso.datetime(),
    content: z.string().min(1).max(10000),
    status: z.enum(["ACTIVE", "CONVERTED", "RESOLVED", "VOIDED"]),
    sourceTask: aggregateTaskRefSchema.nullable(),
    followupTask: aggregateTaskRefSchema.nullable(),
  })
  .strict()
  .meta({ id: "LeftoverListItem" });

export type LeftoverListItem = z.infer<typeof leftoverListItemSchema>;

/** R-6 分页响应（C-006 envelope）。 */
export const leftoverItemPageSchema = z
  .object({
    items: z.array(leftoverListItemSchema).max(AGGREGATE_READ_PAGE_LIMIT_MAX),
    nextCursor: z
      .string()
      .min(1)
      .max(AGGREGATE_READ_CURSOR_MAX_LENGTH)
      .nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "LeftoverItemPage" });

export type LeftoverItemPage = z.infer<typeof leftoverItemPageSchema>;

/** R-7 聚合组列表查询参数；projectId 只用于缩小范围，排序固定 groupId DESC。 */
export const taskGroupListQueryRequestSchema = z
  .object({
    cursor: z.string().min(1).max(AGGREGATE_READ_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGGREGATE_READ_PAGE_LIMIT_MAX)
      .optional(),
    projectId: z.coerce.number().int().positive().max(2147483647).optional(),
  })
  .strict()
  .meta({ id: "TaskGroupListQueryRequest" });

export type TaskGroupListQueryRequest = z.infer<
  typeof taskGroupListQueryRequestSchema
>;

/**
 * R-7 聚合组分支：只含当前生效（ACTIVE）成员，主任务在前、来源任务按
 * joinedAt 与 taskId 升序；sourceKind 的可空性由 role 决定（MAIN 恒为 null）。
 * priority 是分支任务自身优先级（2026-09-21 产品要求）：组卡片的组优先级与
 * 完成态由客户端按「未完成分支中的最高优先级」派生，服务端只透传事实字段。
 * moduleId / moduleName 与 featureId / featureName 是任务所在位置
 * （featureId 与 featureName 同为 null 表示模块级任务）。
 * dueAt 是分支任务自身截止时间（null = 未设置），publishedRecordCount 是该任务
 * PUBLISHED 正式记录数（与 R-1 成员项、R-3 列表项同一口径，2026-09-22 产品要求）：
 * 列表行的「归属 / 截止 / 迭代」三列同样由客户端按事实派生（归属取主任务、截止取
 * 未完成分支中最快到期的、迭代取全部活跃分支之和），服务端不算派生结果。
 * 已解除（DETACHED）成员不出现在列表摘要中，仍由 R-1 详情页展示。
 */
export const taskGroupListBranchSchema = z
  .object({
    taskId: id,
    taskCode: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    role: z.enum(["MAIN", "SOURCE"]),
    sourceKind: z.enum(["ACTIVE", "HISTORICAL"]).nullable(),
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]),
    priority: z.enum(TASK_PRIORITIES),
    moduleId: id,
    moduleName: z.string().min(1).max(200),
    featureId: id.nullable(),
    featureName: z.string().min(1).max(500).nullable(),
    dueAt: z.iso.datetime().nullable(),
    publishedRecordCount: z.number().int().nonnegative(),
    assignee: userRefSchema,
  })
  .strict()
  .meta({ id: "TaskGroupListBranch" });

export type TaskGroupListBranch = z.infer<typeof taskGroupListBranchSchema>;

/** R-7 列表项：组标识、项目名与当前生效分支；mainTask 为活跃主任务引用。 */
export const taskGroupListItemSchema = z
  .object({
    groupId: id,
    projectId: id,
    projectName: z.string().min(1).max(200),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(500),
    status: z.enum(["ACTIVE", "CLOSED"]),
    mainTask: aggregateTaskRefSchema.nullable(),
    branches: z.array(taskGroupListBranchSchema).max(1000),
  })
  .strict()
  .meta({ id: "TaskGroupListItem" });

export type TaskGroupListItem = z.infer<typeof taskGroupListItemSchema>;

/** R-7 分页响应（C-006 envelope）。 */
export const taskGroupListPageSchema = z
  .object({
    items: z.array(taskGroupListItemSchema).max(AGGREGATE_READ_PAGE_LIMIT_MAX),
    nextCursor: z
      .string()
      .min(1)
      .max(AGGREGATE_READ_CURSOR_MAX_LENGTH)
      .nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "TaskGroupListPage" });

export type TaskGroupListPage = z.infer<typeof taskGroupListPageSchema>;

export const taskCenterQuerySchema = myTasksQueryRequestSchema
  .extend({
    scope: z.enum(["mine", "created", "project", "all"]).default("mine"),
    overdue: queryBoolean.optional(),
  })
  .refine((v) => v.scope !== "project" || v.projectId !== undefined, {
    message: "按项目查看必须选择项目",
  })
  .meta({ id: "TaskCenterQuery" });
export type TaskCenterQuery = z.infer<typeof taskCenterQuerySchema>;
