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
 * ADR-077 / ADR-105 项目企微群绑定三态：
 * UNBOUND 未绑定且无待用码；PENDING 已生成待用绑定码；BOUND 至少有一个 ACTIVE 目标。
 * 已绑定且同时存在新待用码（准备换绑机器人）时 state 优先 BOUND。
 */
export const projectWecomGroupStateSchema = z.enum([
  "UNBOUND",
  "PENDING",
  "BOUND",
]);

/** ADR-105 Webhook 目标的脱敏展示；完整 URL 永不返回客户端。 */
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

/** 项目企微群绑定状态（GET 响应）。 */
export const projectWecomGroupStatusSchema = z
  .object({
    state: projectWecomGroupStateSchema.describe(
      "UNBOUND 无任何 ACTIVE 目标且无待用码；PENDING 有待用绑定码；BOUND 至少有一个 ACTIVE 智能机器人或 Webhook 目标",
    ),
    codeExpiresAt: z.iso
      .datetime()
      .nullable()
      .describe("当前待用绑定码的过期时间；无待用码为 null"),
    boundAt: z.iso
      .datetime()
      .nullable()
      .describe("当前 ACTIVE 智能机器人目标的绑定时间；未绑定为 null"),
    boundByName: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .describe("完成智能机器人绑定的操作人姓名；未绑定为 null"),
    lastDeliveryError: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .describe("智能机器人目标最近一次投递失败原因；无异常为 null"),
    botProfileUrl: z
      .string()
      .min(1)
      .max(512)
      .nullable()
      .describe(
        "管理员配置的机器人资料链接；未配置为 null；用于指引成员在企业微信中打开机器人",
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

/** 新签发的一次性项目群绑定码（POST 响应）。 */
export const projectWecomGroupCodeSchema = z
  .object({
    code: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
      .describe(
        "16 位 Crockford Base32 绑定码（4 组 4 位，不含易混字符 I / L / O / U）；在项目企微群里 @机器人 发送完成绑定",
      ),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "ProjectWecomGroupCode" });

/** 项目群绑定路径参数；项目归属由服务端反查，不信任客户端。 */
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

/** 项目群绑定写请求头；CSRF 同步 Token 必填。 */
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

/** 智能机器人解绑幂等重放授权上下文：只涉及目标项目本身。 */
export const projectWecomGroupReplayContextSchema = z
  .object({ projectId: id })
  .strict()
  .meta({ id: "ProjectWecomGroupReplayContext" });

/** Webhook 删除幂等重放授权上下文：项目与已撤销目标行。 */
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
export type ProjectWecomGroupCode = z.infer<typeof projectWecomGroupCodeSchema>;
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
    summary:
      "项目企微群绑定状态、智能机器人信息、脱敏 Webhook 目标、投递异常与机器人链接",
    sensitiveFieldPaths: [],
  },
  ProjectWecomGroupCode: {
    schema: projectWecomGroupCodeSchema,
    summary: "一次性项目群绑定码；明文只返回一次，服务端只存 Hash",
    sensitiveFieldPaths: ["code"],
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
    summary: "项目群绑定路由的项目路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectWecomWebhookPath: {
    schema: projectWecomWebhookPathSchema,
    summary: "项目 Webhook 目标路由的项目与目标 id 路径参数",
    sensitiveFieldPaths: [],
  },
  ProjectWecomGroupMutationHeaders: {
    schema: projectWecomGroupMutationHeadersSchema,
    summary: "项目群绑定写请求头，要求同步 CSRF Token",
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
    summary: "智能机器人解绑幂等重放的最小授权上下文（仅目标项目）",
    sensitiveFieldPaths: [],
  },
  ProjectWecomWebhookReplayContext: {
    schema: projectWecomWebhookReplayContextSchema,
    summary: "Webhook 删除幂等重放的最小授权上下文（项目与目标 id）",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
