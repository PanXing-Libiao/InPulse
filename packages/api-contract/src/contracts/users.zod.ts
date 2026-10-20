import { z } from "zod";

import { projectCodeSchema } from "./projects.zod.js";

/** 成员选择接口一次读取的最大活跃用户数；阶段 0 面向 10～300 人规模。 */
export const USER_DIRECTORY_LIMIT = 300;

/**
 * 用户目录条目。只暴露创建项目成员选择所需的公开字段，不返回
 * `loginName`、`email`、`passwordHash` 或停用状态等敏感/内部字段；组织归属（ADR-081）用于选择器按组织分组与整组选择，未分配为 null。
 */
export const userDirectoryItemSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(200),
    avatarUrl: z.string().min(1).max(2048).nullable(),
    isAdmin: z.boolean(),
    organizationId: z.number().int().positive().max(2147483647).nullable(),
    organizationName: z.string().min(1).max(100).nullable(),
  })
  .strict()
  .meta({ id: "UserDirectoryItem" });

export type UserDirectoryItem = z.infer<typeof userDirectoryItemSchema>;

/** 用户目录响应；当前纵切片一次返回全部启用用户，不提供搜索或分页。 */
export const userDirectoryResponseSchema = z
  .object({
    items: z.array(userDirectoryItemSchema).max(USER_DIRECTORY_LIMIT),
  })
  .strict()
  .meta({ id: "UserDirectoryResponse" });

export type UserDirectoryResponse = z.infer<typeof userDirectoryResponseSchema>;

/** 管理员用户管理列表单次读取上限；当前阶段面向 10～1000 人规模。 */
export const ADMIN_USER_LIST_LIMIT = 1000;

const userIdSchema = z.number().int().positive().max(2147483647);

/** 管理员用户管理路径参数。 */
export const adminUserPathSchema = z
  .object({ userId: z.coerce.number().int().positive().max(2147483647) })
  .strict()
  .meta({ id: "AdminUserPath" });

export type AdminUserPath = z.infer<typeof adminUserPathSchema>;

/**
 * 管理员可见的用户条目。返回用户管理页面需要的登录名、状态、版本与时间，
 * 不返回密码哈希或任何认证材料。ADR-088 起 deleteUser 物理删除账号，
 * 正常列表不再出现该行；`deletedAt` 仅兼容历史墓碑数据。
 */
export const adminUserItemSchema = z
  .object({
    id: userIdSchema,
    loginName: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    email: z.string().min(3).max(320).nullable(),
    avatarUrl: z.string().min(1).max(2048).nullable(),
    isAdmin: z.boolean(),
    organizationId: z.number().int().positive().max(2147483647).nullable(),
    status: z.enum(["ACTIVE", "DISABLED"]),
    openTaskCount: z.number().int().min(0),
    rowVersion: z.number().int().positive(),
    disabledAt: z.iso.datetime().nullable(),
    /** 历史墓碑时间；ADR-088 起的新删除不会再产生该值。 */
    deletedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "AdminUserItem" });

export type AdminUserItem = z.infer<typeof adminUserItemSchema>;

/** 用户管理列表响应；只返回仍存在的账号，物理删除与历史墓碑均不进入列表。 */
export const adminUserListResponseSchema = z
  .object({ items: z.array(adminUserItemSchema).max(ADMIN_USER_LIST_LIMIT) })
  .strict()
  .meta({ id: "AdminUserListResponse" });

export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

/** 系统管理员新增用户请求；密码只在本请求中出现并立即生成 Argon2id 哈希。 */
export const adminUserCreateRequestSchema = z
  .object({
    loginName: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().min(3).max(320).nullable().optional(),
    avatarUrl: z.string().trim().min(1).max(2048).nullable().optional(),
    password: z.string().min(1).max(1024),
    isAdmin: z.boolean().default(false),
  })
  .strict()
  .meta({ id: "AdminUserCreateRequest" });

export type AdminUserCreateRequest = z.infer<
  typeof adminUserCreateRequestSchema
>;

/**
 * 编辑用户请求。字段缺省表示保持不变；`email`、`avatarUrl` 传 null 表示清空；
 * `isAdmin` 为管理员角色变更，服务端执行最后一名可用管理员保护。
 */
export const adminUserUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().min(3).max(320).nullable().optional(),
    avatarUrl: z.string().trim().min(1).max(2048).nullable().optional(),
    isAdmin: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.email !== undefined ||
      value.avatarUrl !== undefined ||
      value.isAdmin !== undefined,
    { message: "至少需要修改一个字段" },
  )
  .meta({ id: "AdminUserUpdateRequest" });

export type AdminUserUpdateRequest = z.infer<
  typeof adminUserUpdateRequestSchema
>;

/** 停用交接中的项目成员（仅启用且在项目内 ACTIVE 的成员）。 */
export const adminUserOffboardingMemberSchema = z
  .object({
    userId: userIdSchema,
    name: z.string().min(1).max(200),
    avatarUrl: z.string().min(1).max(2048).nullable(),
  })
  .strict()
  .meta({ id: "AdminUserOffboardingMember" });

export type AdminUserOffboardingMember = z.infer<
  typeof adminUserOffboardingMemberSchema
>;

/** 任务当前负责人；停用页据此展示交接前后的人员。 */
export const adminUserOffboardingAssigneeSchema = z
  .object({
    userId: userIdSchema,
    name: z.string().min(1).max(200),
  })
  .strict()
  .meta({ id: "AdminUserOffboardingAssignee" });

export type AdminUserOffboardingAssignee = z.infer<
  typeof adminUserOffboardingAssigneeSchema
>;

/**
 * 停用交接任务：只有 work_status = TODO、lifecycle_status = ACTIVE 且
 * 当前账号仍是负责人的任务才会返回。assignees 含待停用账号本身；
 * requiresHandover 表示该任务只有当前账号一个负责人。
 */
export const adminUserOffboardingTaskSchema = z
  .object({
    taskId: userIdSchema,
    projectId: userIdSchema,
    moduleId: userIdSchema,
    featureId: userIdSchema.nullable(),
    scopeType: z.enum(["FEATURE", "MODULE"]),
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    rowVersion: z.number().int().positive(),
    assignees: z.array(adminUserOffboardingAssigneeSchema).min(1).max(50),
    requiresHandover: z.boolean(),
  })
  .strict()
  .meta({ id: "AdminUserOffboardingTask" });

export type AdminUserOffboardingTask = z.infer<
  typeof adminUserOffboardingTaskSchema
>;

/** 按项目分组的停用交接清单；组长项目即使没有未完成任务也会返回。 */
export const adminUserOffboardingProjectSchema = z
  .object({
    projectId: userIdSchema,
    projectCode: projectCodeSchema,
    projectName: z.string().min(1).max(200),
    tasks: z.array(adminUserOffboardingTaskSchema).max(500),
    members: z.array(adminUserOffboardingMemberSchema).max(1000),
    /** 待停用账号仍是该项目 ACTIVE 组长时为 true，停用前必须移交。 */
    requiresLeaderTransfer: z.boolean(),
  })
  .strict()
  .meta({ id: "AdminUserOffboardingProject" });

export type AdminUserOffboardingProject = z.infer<
  typeof adminUserOffboardingProjectSchema
>;

/** 停用前的交接清单；无任务且不是任何项目组长时 projects 为空数组。 */
export const adminUserOffboardingResponseSchema = z
  .object({
    user: adminUserItemSchema,
    projects: z.array(adminUserOffboardingProjectSchema).max(1000),
  })
  .strict()
  .meta({ id: "AdminUserOffboardingResponse" });

export type AdminUserOffboardingResponse = z.infer<
  typeof adminUserOffboardingResponseSchema
>;

/**
 * 停用时的单个任务交接动作。多负责人任务默认保留其余负责人；
 * assigneeIds 为额外接手的项目成员。唯一负责人任务必须二选一：
 * 至少指定一名接手人，或 delete = true。
 */
export const adminUserDisableTaskActionSchema = z
  .object({
    projectId: userIdSchema,
    moduleId: userIdSchema,
    featureId: userIdSchema.nullable(),
    taskId: userIdSchema,
    rowVersion: z.number().int().positive(),
    assigneeIds: z
      .array(userIdSchema)
      .max(20)
      .default([])
      .refine(
        (ids) =>
          new Set(ids).size === ids.length &&
          ids.every((id, index) => index === 0 || ids[index - 1]! < id),
        { message: "接手人必须去重并按编号升序" },
      ),
    delete: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !value.delete || value.assigneeIds.length === 0, {
    message: "标记删除时不能再指定接手人",
    path: ["assigneeIds"],
  })
  .meta({ id: "AdminUserDisableTaskAction" });

export type AdminUserDisableTaskAction = z.infer<
  typeof adminUserDisableTaskActionSchema
>;

/** 停用时的组长移交动作；新组长必须是该项目当前活跃成员。 */
export const adminUserLeaderTransferSchema = z
  .object({
    projectId: userIdSchema,
    newLeaderUserId: userIdSchema,
  })
  .strict()
  .meta({ id: "AdminUserLeaderTransfer" });

export type AdminUserLeaderTransfer = z.infer<
  typeof adminUserLeaderTransferSchema
>;

/**
 * 停用请求；tasks 只列需要额外接手或删除的任务，其余任务由服务端自动保留
 * 其他负责人。leaderTransfers 列出待停用账号仍是组长的项目及新组长，缺少任何
 * 一个组长项目都会返回 422。
 */
export const adminUserDisableRequestSchema = z
  .object({
    tasks: z.array(adminUserDisableTaskActionSchema).max(500).default([]),
    leaderTransfers: z
      .array(adminUserLeaderTransferSchema)
      .max(1000)
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.tasks.map((task) => task.taskId)).size ===
      value.tasks.length,
    { message: "同一个任务不能重复提交", path: ["tasks"] },
  )
  .refine(
    (value) =>
      new Set(value.leaderTransfers.map((item) => item.projectId)).size ===
      value.leaderTransfers.length,
    { message: "同一个项目不能重复提交组长移交", path: ["leaderTransfers"] },
  )
  .meta({ id: "AdminUserDisableRequest" });

export type AdminUserDisableRequest = z.infer<
  typeof adminUserDisableRequestSchema
>;

/** 用户管理写请求头；所有管理员写操作都必须携带同步 CSRF Token。 */
export const adminUserMutationHeadersSchema = z
  .object({ "x-csrf-token": z.string().length(43) })
  .strict()
  .meta({ id: "AdminUserMutationHeaders" });

export type AdminUserMutationHeaders = z.infer<
  typeof adminUserMutationHeadersSchema
>;

/** 需要乐观锁的用户管理写请求头。 */
export const adminUserVersionHeadersSchema = adminUserMutationHeadersSchema
  .extend({ "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/) })
  .meta({ id: "AdminUserVersionHeaders" });

export type AdminUserVersionHeaders = z.infer<
  typeof adminUserVersionHeadersSchema
>;

/** 用户管理幂等重放的最小授权上下文。 */
export const adminUserReplayContextSchema = z
  .object({ actorUserId: userIdSchema, userId: userIdSchema })
  .strict()
  .meta({ id: "AdminUserReplayContext" });

export type AdminUserReplayContext = z.infer<
  typeof adminUserReplayContextSchema
>;
