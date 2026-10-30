import { z } from "zod";

const id = z.number().int().positive().max(2147483647);

/**
 * ADR-104：项目成员能力的全平台三档配置。
 * - ALL_MEMBERS：系统管理员、项目组长与普通活跃成员均可执行；
 * - LEADERS_ONLY：系统管理员或项目组长；
 * - ADMINS_ONLY：仅系统管理员，项目成员（含组长）均不可执行。
 *
 * 查看项目与动态、创建项目、个人通知与企业微信固定开放，不进入配置；
 * 迭代记录作废/恢复与系统管理固定仅系统管理员，同样不进入配置。
 */
export const projectMemberPermissionLevelSchema = z
  .enum(["ALL_MEMBERS", "LEADERS_ONLY", "ADMINS_ONLY"])
  .meta({ id: "ProjectMemberPermissionLevel" });

const permissionFields = {
  projectEdit:
    projectMemberPermissionLevelSchema.describe("编辑项目与变更项目状态"),
  projectMemberManage:
    projectMemberPermissionLevelSchema.describe("添加或移除项目成员"),
  projectLeaderTransfer:
    projectMemberPermissionLevelSchema.describe("转移项目组长身份"),
  projectDelete: projectMemberPermissionLevelSchema.describe("删除项目"),
  projectDocumentImport: projectMemberPermissionLevelSchema.describe(
    "在既有项目内导入文档与使用项目内 AI 辅助",
  ),
  moduleEdit:
    projectMemberPermissionLevelSchema.describe("创建或编辑模块与说明"),
  moduleDelete: projectMemberPermissionLevelSchema.describe("删除模块"),
  taskEdit: projectMemberPermissionLevelSchema.describe("创建、编辑或指派任务"),
  taskLifecycle:
    projectMemberPermissionLevelSchema.describe("任务状态、合并、解除与删除"),
  recordWrite: projectMemberPermissionLevelSchema.describe(
    "迭代记录、遗留问题与 GitHub 链接写入",
  ),
  projectWecomGroup: projectMemberPermissionLevelSchema.describe(
    "项目企业微信群 Webhook 添加、删除与群消息开关",
  ),
} as const;

/** 全局项目成员权限配置（GET / PUT 响应）。 */
export const projectMemberPermissionsSchema = z
  .object({
    ...permissionFields,
    rowVersion: id,
    updatedAt: z.iso.datetime().nullable(),
    updatedByName: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .meta({ id: "ProjectMemberPermissions" });

/** 系统管理员整体保存全局项目成员权限；所有能力必须显式提交。 */
export const projectMemberPermissionsUpdateRequestSchema = z
  .object(permissionFields)
  .strict()
  .meta({ id: "ProjectMemberPermissionsUpdateRequest" });

/** 全局权限配置写请求头；同步 CSRF 与 If-Match 均必填。 */
export const projectMemberPermissionMutationHeadersSchema = z
  .object({
    "x-csrf-token": z.string().length(43),
    "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/),
  })
  .strict()
  .meta({ id: "ProjectMemberPermissionMutationHeaders" });

/** 幂等重放授权上下文：单行全局配置与原始管理员。 */
export const projectMemberPermissionReplayContextSchema = z
  .object({ actorUserId: id, settingsRowId: z.literal(1) })
  .strict()
  .meta({ id: "ProjectMemberPermissionReplayContext" });

export const projectMemberPermissionCapabilities = [
  "projectEdit",
  "projectMemberManage",
  "projectLeaderTransfer",
  "projectDelete",
  "projectDocumentImport",
  "moduleEdit",
  "moduleDelete",
  "taskEdit",
  "taskLifecycle",
  "recordWrite",
  "projectWecomGroup",
] as const;

export type ProjectMemberPermissionCapability =
  (typeof projectMemberPermissionCapabilities)[number];

/** ADR-104 上线默认值：与引入配置前的既有授权完全一致。 */
export const defaultProjectMemberPermissionLevels = {
  projectEdit: "ALL_MEMBERS",
  projectMemberManage: "ALL_MEMBERS",
  projectLeaderTransfer: "LEADERS_ONLY",
  projectDelete: "LEADERS_ONLY",
  projectDocumentImport: "ALL_MEMBERS",
  moduleEdit: "ALL_MEMBERS",
  moduleDelete: "LEADERS_ONLY",
  taskEdit: "ALL_MEMBERS",
  taskLifecycle: "ALL_MEMBERS",
  recordWrite: "ALL_MEMBERS",
  projectWecomGroup: "LEADERS_ONLY",
} as const satisfies Record<
  ProjectMemberPermissionCapability,
  ProjectMemberPermissionLevel
>;

export type ProjectMemberPermissionLevel = z.infer<
  typeof projectMemberPermissionLevelSchema
>;
export type ProjectMemberPermissions = z.infer<
  typeof projectMemberPermissionsSchema
>;
export type ProjectMemberPermissionsUpdateRequest = z.infer<
  typeof projectMemberPermissionsUpdateRequestSchema
>;
export type ProjectMemberPermissionReplayContext = z.infer<
  typeof projectMemberPermissionReplayContextSchema
>;

export const projectMemberPermissionSchemas = {
  ProjectMemberPermissions: {
    schema: projectMemberPermissionsSchema,
    summary: "全平台项目成员权限配置、版本与最近保存人",
    sensitiveFieldPaths: [],
  },
  ProjectMemberPermissionsUpdateRequest: {
    schema: projectMemberPermissionsUpdateRequestSchema,
    summary: "系统管理员整体保存全平台项目成员三档权限",
    sensitiveFieldPaths: [],
  },
  ProjectMemberPermissionMutationHeaders: {
    schema: projectMemberPermissionMutationHeadersSchema,
    summary: "项目成员权限配置写请求头，要求 CSRF 与 If-Match",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectMemberPermissionReplayContext: {
    schema: projectMemberPermissionReplayContextSchema,
    summary: "项目成员权限配置幂等重放的最小结果资源上下文",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
