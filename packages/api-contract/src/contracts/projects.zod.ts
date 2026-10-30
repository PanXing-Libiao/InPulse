import { z } from "zod";

/** 项目编码：与 projects.code CHECK 一致 */
export const projectCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
  .meta({ id: "ProjectCode" });

const projectPositiveId = z.number().int().positive().max(2147483647);

/** 项目读取路径参数；只接受服务端路由解析后的正整数。 */
export const projectPathSchema = z
  .object({
    projectId: z.coerce.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "ProjectPath" });

export type ProjectPath = z.infer<typeof projectPathSchema>;

/**
 * 项目卡统计：与 R-2 项目概览（projectOverviewStatsSchema）同名同口径——
 * activeModuleCount 只计行自身 status = ACTIVE，
 * openTaskCount 只计有效任务的 work_status = TODO（排除 INVALID、CANCELED 与历史来源分支）；
 * completedTaskCount 是同一有效任务口径下 work_status = DONE 的任务数。项目标签自
 * 四态改造起读存储 status，不再由该计数推导；模块的「未开始 / 进行中」仍按该计数推导。
 * 列表接口一次返回，项目卡无需按项目逐个再请求概览。
 */
export const projectStatsSchema = z
  .object({
    activeModuleCount: z.number().int().nonnegative(),
    openTaskCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "ProjectStats" });

export type ProjectStats = z.infer<typeof projectStatsSchema>;

/**
 * 项目生命周期三态：与 app.projects 的 projects_status_check 一致。
 *
 * 2026-09-23 定案：项目层面不再有「归档」这一说、也不再需要归档申请，只剩三态；
 * 归档概念只保留在模块 / 任务上，项目自身只表达进度。
 *
 * - `NOT_STARTED`（未开始）：项目下还没有任何已完成任务；
 * - `ACTIVE`（进行中）：项目已开工，含手动置为进行中、首次有任务完成后的自动升级
 *   与维护中项目任务重新变为未收尾后的自动回退（ADR-056 / ADR-057）；
 * - `MAINTENANCE`（维护中）：项目主体已完成、只做小修小补。进入前要求项目下任务
 *   全部收尾（不存在 `lifecycle_status = 'ACTIVE'` 且 `work_status = 'TODO'` 的任务），
 *   否则 409 `PROJECT_MAINTENANCE_TASKS_OPEN`；进入后只要有任务重新变为未收尾
 *   （新建、重新打开或恢复），会在同一事务内回到进行中。
 *
 * 未开始与维护中之间禁止直接互改（409 `PROJECT_STATUS_LEVEL_SKIP`）；
 * 项目内出现过已完成任务后不可回退未开始（409 `PROJECT_STATUS_NOT_STARTED_LOCKED`）。
 */
export const projectStatusSchema = z
  .enum(["NOT_STARTED", "ACTIVE", "MAINTENANCE"])
  .meta({ id: "ProjectStatus" });

export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/** 项目公开摘要；包含生命周期状态、当前活跃成员数与项目卡统计，不暴露成员名单或内部字段。 */
export const projectItemSchema = z
  .object({
    id: projectPositiveId,
    code: projectCodeSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(20000),
    status: projectStatusSchema,
    /**
     * 粘性标记：项目内出现过已完成任务后恒为 true，永不回落。
     * 前端据此置灰「未开始」选项；服务端独立校验并返回 409。
     */
    hasCompletedTask: z.boolean(),
    rowVersion: projectPositiveId,
    createdBy: projectPositiveId,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    memberCount: z.number().int().nonnegative(),
    stats: projectStatsSchema,
  })
  .strict()
  .meta({ id: "ProjectItem" });

export type ProjectItem = z.infer<typeof projectItemSchema>;

/** ADR-033/ADR-039：项目内角色（组长或普通成员）；成员被移除即失效，重新加入从 MEMBER 开始。 */
export const projectMemberRoleSchema = z.enum(["MEMBER", "LEADER"]);

export type ProjectMemberRole = z.infer<typeof projectMemberRoleSchema>;

/** 项目详情响应；缺失或无权限统一 404。 */
export const projectDetailResponseSchema = z
  .object({
    project: projectItemSchema,
    /**
     * ADR-033：当前用户在本项目的成员角色；非成员不会出现（404）。
     * 服务端恒下发，字段标记 optional 仅为兼容既有客户端形状。
     */
    currentUserRole: projectMemberRoleSchema.nullable().optional(),
  })
  .strict()
  .meta({ id: "ProjectDetailResponse" });

export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;

/** 项目成员集合路径；只接受服务端路由解析后的正整数。 */
export const projectMemberCollectionPathSchema = z
  .object({
    projectId: z.coerce.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "ProjectMemberCollectionPath" });

export type ProjectMemberCollectionPath = z.infer<
  typeof projectMemberCollectionPathSchema
>;

/** 项目成员资源路径。 */
export const projectMemberPathSchema = projectMemberCollectionPathSchema
  .extend({
    userId: z.coerce.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "ProjectMemberPath" });

export type ProjectMemberPath = z.infer<typeof projectMemberPathSchema>;

/** 项目成员历史记录，包含用户脱敏展示字段与加入/移除时间。 */
export const projectMemberRecordItemSchema = z
  .object({
    membershipId: projectPositiveId,
    projectId: projectPositiveId,
    userId: projectPositiveId,
    name: z.string().min(1).max(200),
    avatarUrl: z.string().max(2048).nullable(),
    status: z.enum(["ACTIVE", "REMOVED"]),
    role: projectMemberRoleSchema,
    joinedAt: z.iso.datetime(),
    removedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .meta({ id: "ProjectMemberRecordItem" });

export type ProjectMemberRecordItem = z.infer<
  typeof projectMemberRecordItemSchema
>;

/** 系统管理员成员历史列表。 */
export const projectMembersListResponseSchema = z
  .object({
    items: z.array(projectMemberRecordItemSchema),
  })
  .strict()
  .meta({ id: "ProjectMembersListResponse" });

export type ProjectMembersListResponse = z.infer<
  typeof projectMembersListResponseSchema
>;

/**
 * ADR-033：普通成员只读成员视图可见字段。授权范围与任务指派人相同
 * （项目活跃成员或系统管理员），额外带项目内角色与加入时间供身份徽标展示；
 * 不含移除时间等成员历史。
 */
export const activeProjectMemberItemSchema = z
  .object({
    id: projectPositiveId,
    name: z.string().min(1).max(200),
    avatarUrl: z.string().max(2048).nullable(),
    role: projectMemberRoleSchema,
    joinedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "ActiveProjectMemberItem" });

export type ActiveProjectMemberItem = z.infer<
  typeof activeProjectMemberItemSchema
>;

export const activeProjectMembersResponseSchema = z
  .object({ items: z.array(activeProjectMemberItemSchema) })
  .strict()
  .meta({ id: "ActiveProjectMembersResponse" });

export type ActiveProjectMembersResponse = z.infer<
  typeof activeProjectMembersResponseSchema
>;

/** 添加项目成员请求；目标用户由服务端校验必须为启用状态。 */
export const addProjectMemberRequestSchema = z
  .object({
    userId: projectPositiveId,
  })
  .strict()
  .meta({ id: "AddProjectMemberRequest" });

export type AddProjectMemberRequest = z.infer<
  typeof addProjectMemberRequestSchema
>;

/** 写接口安全头；高风险管理员操作由服务端在同事务内再次校验管理员身份与 CSRF。 */
export const projectMemberMutationHeadersSchema = z
  .object({
    "x-csrf-token": z.string().min(43).max(43),
  })
  .strict()
  .meta({ id: "ProjectMemberMutationHeaders" });

export type ProjectMemberMutationHeaders = z.infer<
  typeof projectMemberMutationHeadersSchema
>;

/** 项目成员未完成任务读模型；供移除前提示与真实改派参数。 */
export const projectMemberUnfinishedTaskItemSchema = z
  .object({
    taskId: projectPositiveId,
    projectId: projectPositiveId,
    moduleId: projectPositiveId,
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    description: z.string().max(50000),
    priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
    dueAt: z.iso.datetime().nullable(),
    workStatus: z.literal("TODO"),
    assigneeId: projectPositiveId,
    rowVersion: projectPositiveId,
  })
  .strict()
  .meta({ id: "ProjectMemberUnfinishedTaskItem" });

export type ProjectMemberUnfinishedTaskItem = z.infer<
  typeof projectMemberUnfinishedTaskItemSchema
>;

export const projectMemberUnfinishedTasksResponseSchema = z
  .object({
    items: z.array(projectMemberUnfinishedTaskItemSchema),
  })
  .strict()
  .meta({ id: "ProjectMemberUnfinishedTasksResponse" });

export type ProjectMemberUnfinishedTasksResponse = z.infer<
  typeof projectMemberUnfinishedTasksResponseSchema
>;

/**
 * 单项成员移除时的任务改派；rowVersion 用于防止覆盖并发任务编辑。
 * 2026-09-24：改派目标由单人 `assigneeId` 改为集合 `assigneeIds`（至少一人、至多 20 人，
 * 去重升序），与 ADR-040 的任务多负责人口径一致；承接人只在被移除成员是唯一负责人时
 * 顶上，其余成员继续负责。
 */
export const projectMemberReassignmentItemSchema = z
  .object({
    taskId: projectPositiveId,
    moduleId: projectPositiveId,
    rowVersion: projectPositiveId,
    assigneeIds: z
      .array(projectPositiveId)
      .min(1)
      .max(20)
      .overwrite((values) => [...new Set(values)].sort((a, b) => a - b)),
  })
  .strict()
  .meta({ id: "ProjectMemberReassignmentItem" });

export type ProjectMemberReassignmentItem = z.infer<
  typeof projectMemberReassignmentItemSchema
>;

const defaultReassignments = z
  .array(projectMemberReassignmentItemSchema)
  .max(1000)
  .overwrite((values) =>
    [...new Map(values.map((item) => [item.taskId, item])).values()].sort(
      (a, b) => a.taskId - b.taskId,
    ),
  );

/** 移除成员请求；未完成任务默认保留原负责人并失去继续处理权限。 */
export const removeProjectMemberRequestSchema = z
  .object({
    reassignments: defaultReassignments.default([]),
  })
  .strict()
  .meta({ id: "RemoveProjectMemberRequest" });

export type RemoveProjectMemberRequest = z.infer<
  typeof removeProjectMemberRequestSchema
>;

/** 添加成员成功响应；成员为新增或重新加入后的最新 ACTIVE 历史记录。 */
export const addProjectMemberResponseSchema = z
  .object({
    member: projectMemberRecordItemSchema,
  })
  .strict()
  .meta({ id: "AddProjectMemberResponse" });

export type AddProjectMemberResponse = z.infer<
  typeof addProjectMemberResponseSchema
>;

/** 移除成员成功响应；reassignedTaskIds 为本次已改派任务。 */
export const removeProjectMemberResponseSchema = z
  .object({
    member: projectMemberRecordItemSchema,
    reassignedTaskIds: z.array(projectPositiveId),
    unfinishedTaskCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "RemoveProjectMemberResponse" });

export type RemoveProjectMemberResponse = z.infer<
  typeof removeProjectMemberResponseSchema
>;

/** 成员写操作幂等重放的最小结果资源上下文。 */
export const projectMemberReplayContextSchema = z
  .object({
    projectId: projectPositiveId,
    memberUserId: projectPositiveId,
  })
  .strict()
  .meta({ id: "ProjectMemberReplayContext" });

export type ProjectMemberReplayContext = z.infer<
  typeof projectMemberReplayContextSchema
>;

/**
 * ADR-033/ADR-039：任命/撤销组长。请求只携带目标角色（MEMBER 或 LEADER）；
 * 谁能设哪些角色由服务端门禁决定（仅系统管理员可调用，用于转移或撤销组长）。
 */
export const setProjectMemberRoleRequestSchema = z
  .object({
    role: projectMemberRoleSchema,
  })
  .strict()
  .meta({ id: "SetProjectMemberRoleRequest" });

export type SetProjectMemberRoleRequest = z.infer<
  typeof setProjectMemberRoleRequestSchema
>;

export const setProjectMemberRoleResponseSchema = z
  .object({
    member: projectMemberRecordItemSchema,
  })
  .strict()
  .meta({ id: "SetProjectMemberRoleResponse" });

export type SetProjectMemberRoleResponse = z.infer<
  typeof setProjectMemberRoleResponseSchema
>;

/**
 * 创建项目请求。创建者由服务端从认证 Session 解析，不接收客户端提交的
 * createdBy；memberIds 为可选项目成员（不含创建者），服务端校验其 ACTIVE 状态。
 */
export const createProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: projectCodeSchema.optional(),
    description: z.string().max(20000).default(""),
    memberIds: z.array(z.number().int().positive()).max(1000).default([]),
  })
  .strict()
  .meta({ id: "CreateProjectRequest" });

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** CSRF 同步 Token；写接口要求。 */
export const createProjectHeadersSchema = z
  .object({
    "x-csrf-token": z.string().min(43).max(43),
  })
  .strict()
  .meta({ id: "CreateProjectHeaders" });

export type CreateProjectHeaders = z.infer<typeof createProjectHeadersSchema>;

/** 项目成员摘要（幂等重放与响应共享）。 */
export const projectMemberItemSchema = z
  .object({
    userId: z.number().int().positive(),
    status: z.enum(["ACTIVE", "REMOVED"]),
    role: projectMemberRoleSchema,
    joinedAt: z.string().min(1).max(64),
  })
  .strict()
  .meta({ id: "ProjectMemberItem" });

export type ProjectMemberItem = z.infer<typeof projectMemberItemSchema>;

/** 创建项目响应（成功状态码 200）；新建项目从未开始起步，首次有任务完成时自动升级为进行中。 */
export const createProjectResponseSchema = z
  .object({
    project: z
      .object({
        id: z.number().int().positive(),
        code: projectCodeSchema,
        name: z.string().min(1).max(200),
        description: z.string().max(20000),
        status: z.literal("NOT_STARTED"),
        rowVersion: z.number().int().positive(),
        createdBy: z.number().int().positive(),
        createdAt: z.string().min(1).max(64),
        updatedAt: z.string().min(1).max(64),
      })
      .strict(),
    members: z.array(projectMemberItemSchema),
  })
  .strict()
  .meta({ id: "CreateProjectResponse" });

export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

/** 幂等重放授权上下文：结果资源为新建项目及其成员。 */
export const createProjectReplayContextSchema = z
  .object({
    projectId: z.number().int().positive(),
    actorUserId: z.number().int().positive(),
  })
  .strict()
  .meta({ id: "CreateProjectReplayContext" });

export type CreateProjectReplayContext = z.infer<
  typeof createProjectReplayContextSchema
>;

/**
 * 项目编辑请求；编码创建后不可修改，名称与描述为完整替换值，
 * 服务端以 If-Match 版本做乐观锁并整笔覆盖。
 */
export const projectEditRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(20000).default(""),
  })
  .strict()
  .meta({ id: "ProjectEditRequest" });

export type ProjectEditRequest = z.infer<typeof projectEditRequestSchema>;

/**
 * 项目状态变更请求（F-06.3）。三态即全部目标态；进入维护中要求项目下任务全部收尾，
 * 否则 409 `PROJECT_MAINTENANCE_TASKS_OPEN`。
 * 目标态等于当前态视为无变化并返回 409 `PROJECT_STATE_CONFLICT`。
 */
export const projectStatusChangeRequestSchema = z
  .object({
    status: z.enum(["NOT_STARTED", "ACTIVE", "MAINTENANCE"]),
  })
  .strict()
  .meta({ id: "ProjectStatusChangeRequest" });

export type ProjectStatusChangeRequest = z.infer<
  typeof projectStatusChangeRequestSchema
>;

/** 项目写请求安全头；要求同步 CSRF Token。 */
export const projectMutationHeadersSchema = z
  .object({
    "x-csrf-token": z.string().min(43).max(43),
  })
  .strict()
  .meta({ id: "ProjectMutationHeaders" });

export type ProjectMutationHeaders = z.infer<
  typeof projectMutationHeadersSchema
>;

/** 项目编辑版本头；If-Match 防止覆盖并发编辑。 */
export const projectVersionHeadersSchema = projectMutationHeadersSchema
  .extend({
    "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/),
  })
  .meta({ id: "ProjectVersionHeaders" });

export type ProjectVersionHeaders = z.infer<typeof projectVersionHeadersSchema>;

/** 项目写操作幂等重放的最小结果资源上下文。 */
export const projectReplayContextSchema = z
  .object({
    projectId: z.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "ProjectReplayContext" });

export type ProjectReplayContext = z.infer<typeof projectReplayContextSchema>;

/**
 * F-06.2 项目列表条目：在项目摘要之上补充当前用户在本项目的成员角色。
 * 2026-09-23 起不再携带待审归档申请（项目归档与归档申请整体下线）。
 */
export const projectListItemSchema = projectItemSchema
  .extend({
    currentUserRole: projectMemberRoleSchema.nullable(),
  })
  .meta({ id: "ProjectListItem" });

export type ProjectListItem = z.infer<typeof projectListItemSchema>;

/** 当前用户可见项目列表；系统管理员返回全部项目。归档概念下线后列表只按生命周期分档。 */
export const projectListResponseSchema = z
  .object({ items: z.array(projectListItemSchema) })
  .strict()
  .meta({ id: "ProjectListResponse" });

export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
