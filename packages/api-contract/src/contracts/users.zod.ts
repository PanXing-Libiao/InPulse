import { z } from "zod";

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
 * 不返回密码哈希或任何认证材料。
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
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "AdminUserItem" });

export type AdminUserItem = z.infer<typeof adminUserItemSchema>;

/** 用户管理列表响应；一次返回全部用户，后续再按规模补分页。 */
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
