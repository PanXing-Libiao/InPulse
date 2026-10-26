import { z } from "zod";

const id = z.number().int().positive().max(2147483647);

/** 组织来源：LOCAL 由管理员维护，CASDOOR 由 SSO 群组同步且本地只读。 */
export const organizationSourceSchema = z.enum(["LOCAL", "CASDOOR"]);

/** 用户所属组织的最小摘要；同一用户可同时属于多个 Casdoor 群组。 */
export const organizationMembershipSummarySchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    source: organizationSourceSchema,
    groupPath: z.string().min(3).max(512).nullable(),
  })
  .strict()
  .meta({ id: "OrganizationMembershipSummary" });

export type OrganizationMembershipSummary = z.infer<
  typeof organizationMembershipSummarySchema
>;

/**
 * ADR-081 组织条目：全局平铺列表的一条。名称为 btrim 后 1～100 字符，
 * 数据库按 lower(btrim(name)) 函数唯一索引去重（同名不同大小写 / 前后空白视为冲突）。
 */
export const organizationItemSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    source: organizationSourceSchema,
    groupPath: z.string().min(3).max(512).nullable(),
    parentId: id.nullable(),
    rowVersion: id,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "OrganizationItem" });

export type OrganizationItem = z.infer<typeof organizationItemSchema>;

/** 组织列表响应；一次返回全部组织，按 id 升序。 */
export const organizationListResponseSchema = z
  .object({ items: z.array(organizationItemSchema) })
  .strict()
  .meta({ id: "OrganizationListResponse" });

export type OrganizationListResponse = z.infer<
  typeof organizationListResponseSchema
>;

/** 新建组织请求；名称在服务端 btrim 并校验 1～100 字符。 */
export const organizationCreateRequestSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict()
  .meta({ id: "OrganizationCreateRequest" });

export type OrganizationCreateRequest = z.infer<
  typeof organizationCreateRequestSchema
>;

/** 改名请求：整笔替换 name。 */
export const organizationUpdateRequestSchema =
  organizationCreateRequestSchema.meta({ id: "OrganizationUpdateRequest" });

export type OrganizationUpdateRequest = z.infer<
  typeof organizationUpdateRequestSchema
>;

/** 组织写请求头；所有管理员写操作都必须携带同步 CSRF Token。 */
export const organizationMutationHeadersSchema = z
  .object({ "x-csrf-token": z.string().length(43) })
  .strict()
  .meta({ id: "OrganizationMutationHeaders" });

export type OrganizationMutationHeaders = z.infer<
  typeof organizationMutationHeadersSchema
>;

/** 需要乐观锁的组织写请求头。 */
export const organizationVersionHeadersSchema =
  organizationMutationHeadersSchema
    .extend({ "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/) })
    .meta({ id: "OrganizationVersionHeaders" });

export type OrganizationVersionHeaders = z.infer<
  typeof organizationVersionHeadersSchema
>;

/**
 * 组织 CRUD 幂等重放的最小授权上下文（actorOnly）：组织行可能在重放前被
 * 改名或删除，只复核当前有效的完整管理员会话。
 */
export const organizationReplayContextSchema = z
  .object({ actorUserId: id, organizationId: id.nullable() })
  .strict()
  .meta({ id: "OrganizationReplayContext" });

export type OrganizationReplayContext = z.infer<
  typeof organizationReplayContextSchema
>;

/**
 * 批量调整成员组织归属请求：1～200 个用户 ID（服务端去重并按 id 升序处理），
 * organizationId 为 null 表示移出组织（未分配）。
 */
export const organizationAssignRequestSchema = z
  .object({
    userIds: z.array(id).min(1).max(200),
    organizationId: id.nullable(),
  })
  .strict()
  .meta({ id: "OrganizationAssignRequest" });

export type OrganizationAssignRequest = z.infer<
  typeof organizationAssignRequestSchema
>;

/** 批量归属结果：仅统计实际发生变化的行数（重复调用为 0）。 */
export const organizationAssignResponseSchema = z
  .object({ updatedCount: z.number().int().min(0).max(2147483647) })
  .strict()
  .meta({ id: "OrganizationAssignResponse" });

export type OrganizationAssignResponse = z.infer<
  typeof organizationAssignResponseSchema
>;

/** 批量归属幂等重放的授权上下文（actorOnly，同组织 CRUD）。 */
export const organizationAssignReplayContextSchema = z
  .object({
    actorUserId: id,
    organizationId: id.nullable(),
    userIds: z.array(id).min(1).max(200),
  })
  .strict()
  .meta({ id: "OrganizationAssignReplayContext" });

export type OrganizationAssignReplayContext = z.infer<
  typeof organizationAssignReplayContextSchema
>;

/**
 * 同组织成员条目：与 getUserDirectory 相同的脱敏口径，不返回登录名、
 * 邮箱、停用状态或任何认证材料。
 */
export const myOrganizationMemberItemSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    avatarUrl: z.string().min(1).max(2048).nullable(),
    isAdmin: z.boolean(),
    organizationIds: z.array(id),
  })
  .strict()
  .meta({ id: "MyOrganizationMemberItem" });

export type MyOrganizationMemberItem = z.infer<
  typeof myOrganizationMemberItemSchema
>;

/** 当前用户所属全部组织与去重后的同组织 ACTIVE 成员列表。 */
export const myOrganizationMembersResponseSchema = z
  .object({
    organizations: z.array(organizationMembershipSummarySchema),
    items: z.array(myOrganizationMemberItemSchema),
  })
  .strict()
  .meta({ id: "MyOrganizationMembersResponse" });

export type MyOrganizationMembersResponse = z.infer<
  typeof myOrganizationMembersResponseSchema
>;

/** 组织路径参数。 */
export const organizationPathSchema = z
  .object({
    organizationId: z.coerce.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "OrganizationPath" });

export type OrganizationPath = z.infer<typeof organizationPathSchema>;

export const organizationSchemas = {
  OrganizationMembershipSummary: {
    schema: organizationMembershipSummarySchema,
    summary: "用户所属组织摘要；包含来源与 Casdoor 完整群组路径",
    sensitiveFieldPaths: [],
  },
  OrganizationItem: {
    schema: organizationItemSchema,
    summary: "组织条目：名称、来源、群组路径、父级、行版本与时间戳",
    sensitiveFieldPaths: [],
  },
  OrganizationPath: {
    schema: organizationPathSchema,
    summary: "组织路径参数（organizationId）",
    sensitiveFieldPaths: [],
  },
  OrganizationListResponse: {
    schema: organizationListResponseSchema,
    summary: "组织列表；按 id 升序，响应 no-store",
    sensitiveFieldPaths: [],
  },
  OrganizationCreateRequest: {
    schema: organizationCreateRequestSchema,
    summary: "新建组织请求；名称 1～100 字符",
    sensitiveFieldPaths: [],
  },
  OrganizationUpdateRequest: {
    schema: organizationUpdateRequestSchema,
    summary: "组织改名请求；整笔替换 name",
    sensitiveFieldPaths: [],
  },
  OrganizationMutationHeaders: {
    schema: organizationMutationHeadersSchema,
    summary: "组织写请求头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  OrganizationVersionHeaders: {
    schema: organizationVersionHeadersSchema,
    summary: "组织版本写请求头，要求同步 CSRF Token 与 If-Match",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  OrganizationReplayContext: {
    schema: organizationReplayContextSchema,
    summary: "组织 CRUD 幂等重放的最小授权上下文（actorOnly）",
    sensitiveFieldPaths: [],
  },
  OrganizationAssignRequest: {
    schema: organizationAssignRequestSchema,
    summary: "批量调整成员组织归属请求；organizationId 为 null 表示移出组织",
    sensitiveFieldPaths: [],
  },
  OrganizationAssignResponse: {
    schema: organizationAssignResponseSchema,
    summary: "批量归属结果；只统计实际变化行数",
    sensitiveFieldPaths: [],
  },
  OrganizationAssignReplayContext: {
    schema: organizationAssignReplayContextSchema,
    summary: "批量归属幂等重放的授权上下文（actorOnly）",
    sensitiveFieldPaths: [],
  },
  MyOrganizationMemberItem: {
    schema: myOrganizationMemberItemSchema,
    summary:
      "同组织成员条目；脱敏字段（id / name / avatarUrl / isAdmin / organizationIds）",
    sensitiveFieldPaths: [],
  },
  MyOrganizationMembersResponse: {
    schema: myOrganizationMembersResponseSchema,
    summary: "当前用户所属全部组织与去重后的同组织成员列表；响应 no-store",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
