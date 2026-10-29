import { z } from "zod";

import { projectNotificationCategories } from "../project-notification-categories.js";

const id = z.number().int().positive().max(2147483647);

/** 项目群通知选项：disabledCategories 为关闭推送的类别，缺行等价于空数组（全开）。 */
export const projectWecomGroupNotificationOptionsSchema = z
  .object({
    disabledCategories: z
      .array(z.enum(projectNotificationCategories))
      .max(projectNotificationCategories.length)
      .overwrite((values) => [...new Set(values)].sort()),
  })
  .strict()
  .meta({ id: "ProjectWecomGroupNotificationOptions" });

/**
 * ADR-106 项目企业微信群通知状态：UNBOUND 没有任何 ACTIVE Webhook；
 * BOUND 至少有一个 ACTIVE Webhook。项目群不再支持智能机器人绑定码通道。
 */
export const projectWecomGroupStateSchema = z.enum(["UNBOUND", "BOUND"]);

/** ADR-105 / ADR-106 Webhook 目标的脱敏展示；完整 URL 永不返回客户端。 */
export const projectWecomWebhookTargetSchema = z
  .object({
    id: id.describe("项目群通知目标 id；删除时使用"),
    label: z.string().min(1).max(80).describe("用户填写的目标群标签"),
    urlHint: z
      .string()
      .min(4)
      .max(12)
      .describe("Webhook Key 尾号提示，仅用于辨别目标"),
    boundAt: z.iso.datetime().describe("目标绑定时间"),
    boundByName: z.string().min(1).max(200).describe("绑定操作人姓名快照"),
    lastDeliveryError: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .describe("桥接侧最近一次投递失败原因；无异常为 null"),
  })
  .strict()
  .meta({ id: "ProjectWecomWebhookTarget" });

/** 项目企业微信群 Webhook 状态（GET 响应）。 */
export const projectWecomGroupStatusSchema = z
  .object({
    state: projectWecomGroupStateSchema.describe(
      "UNBOUND 无 ACTIVE Webhook；BOUND 至少有一个 ACTIVE Webhook",
    ),
    webhookTargets: z
      .array(projectWecomWebhookTargetSchema)
      .max(20)
      .describe("当前 ACTIVE Webhook 目标列表；不含完整 URL 或 Key"),
    notificationOptions: projectWecomGroupNotificationOptionsSchema.describe(
      "项目群推送开关；只影响此后物化的群消息",
    ),
  })
  .strict()
  .meta({ id: "ProjectWecomGroupStatus" });

/** 项目群路径参数；项目归属由服务端反查，不信任客户端。 */
export const projectWecomGroupPathSchema = z
  .object({
    projectId: z.coerce.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "ProjectWecomGroupPath" });

/** 单个 Webhook 目标的路径参数。 */
export const projectWecomWebhookPathSchema = z
  .object({
    projectId: z.coerce.number().int().positive().max(2147483647),
    bindingId: z.coerce.number().int().positive().max(2147483647),
  })
  .strict()
  .meta({ id: "ProjectWecomWebhookPath" });

/** 项目群通知写请求头；CSRF 同步 Token 必填。 */
export const projectWecomGroupMutationHeadersSchema = z
  .object({ "x-csrf-token": z.string().length(43) })
  .strict()
  .meta({ id: "ProjectWecomGroupMutationHeaders" });

/** 添加 Webhook 目标：label 为用户可读标签，webhookUrl 只进入请求与加密逻辑。 */
export const projectWecomWebhookCreateRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    webhookUrl: z.string().trim().min(1).max(2048),
  })
  .strict()
  .meta({ id: "ProjectWecomWebhookCreateRequest" });

/** 项目群通知开关幂等重放授权上下文：只涉及目标项目本身。 */
export const projectWecomGroupReplayContextSchema = z
  .object({ projectId: id })
  .strict()
  .meta({ id: "ProjectWecomGroupReplayContext" });

/** Webhook 创建 / 删除幂等重放授权上下文：项目与目标行。 */
export const projectWecomWebhookReplayContextSchema = z
  .object({ projectId: id, bindingId: id })
  .strict()
  .meta({ id: "ProjectWecomWebhookReplayContext" });

export type ProjectWecomGroupState = z.infer<
  typeof projectWecomGroupStateSchema
>;
export type ProjectWecomGroupStatus = z.infer<
  typeof projectWecomGroupStatusSchema
>;
export type ProjectWecomWebhookTarget = z.infer<
  typeof projectWecomWebhookTargetSchema
>;
export type ProjectWecomWebhookCreateRequest = z.infer<
  typeof projectWecomWebhookCreateRequestSchema
>;
export type ProjectWecomGroupNotificationOptions = z.infer<
  typeof projectWecomGroupNotificationOptionsSchema
>;
export type ProjectWecomGroupReplayContext = z.infer<
  typeof projectWecomGroupReplayContextSchema
>;
export type ProjectWecomWebhookReplayContext = z.infer<
  typeof projectWecomWebhookReplayContextSchema
>;

export const projectWecomGroupSchemas = {
  ProjectWecomGroupStatus: {
    schema: projectWecomGroupStatusSchema,
    summary: "项目企微群 Webhook 状态、脱敏目标与项目群通知开关",
    sensitiveFieldPaths: [],
  },
  ProjectWecomWebhookTarget: {
    schema: projectWecomWebhookTargetSchema,
    summary: "脱敏后的项目 Webhook 目标，不含完整 URL 或 Key",
    sensitiveFieldPaths: [],
  },
  ProjectWecomGroupNotificationOptions: {
    schema: projectWecomGroupNotificationOptionsSchema,
    summary: "项目群通知开关；disabledCategories 为空表示五类全部推送",
    sensitiveFieldPaths: [],
  },
  ProjectWecomGroupPath: {
    schema: projectWecomGroupPathSchema,
    summary: "项目群 Webhook 路由的项目路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectWecomWebhookPath: {
    schema: projectWecomWebhookPathSchema,
    summary: "项目 Webhook 目标路由的项目与目标 id 路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectWecomGroupMutationHeaders: {
    schema: projectWecomGroupMutationHeadersSchema,
    summary: "项目群 Webhook 写请求头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectWecomWebhookCreateRequest: {
    schema: projectWecomWebhookCreateRequestSchema,
    summary:
      "添加项目 Webhook 目标；webhookUrl 含 Secret，不进入响应、审计或日志",
    sensitiveFieldPaths: ["webhookUrl"],
  },
  ProjectWecomGroupReplayContext: {
    schema: projectWecomGroupReplayContextSchema,
    summary: "项目群通知选项幂等重放的最小授权上下文（仅目标项目）",
    sensitiveFieldPaths: [],
  },
  ProjectWecomWebhookReplayContext: {
    schema: projectWecomWebhookReplayContextSchema,
    summary: "Webhook 创建 / 删除幂等重放的最小授权上下文（项目与目标 id）",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
