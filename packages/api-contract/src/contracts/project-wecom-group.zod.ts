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
 * ADR-077 项目企微群绑定三态：
 * UNBOUND 未绑定且无待用码；PENDING 已生成待用绑定码；BOUND 已绑定。
 * 已绑定且同时存在新待用码（准备换绑）时 state 优先 BOUND，
 * codeExpiresAt 仍独立返回便于页面提示「换绑中」。
 */
export const projectWecomGroupStateSchema = z.enum([
  "UNBOUND",
  "PENDING",
  "BOUND",
]);

/** 项目企微群绑定状态（GET 响应）。 */
export const projectWecomGroupStatusSchema = z
  .object({
    state: projectWecomGroupStateSchema.describe(
      "UNBOUND 未绑定且无待用码；PENDING 有待用绑定码；BOUND 已绑定（可能同时存在换绑待用码）",
    ),
    codeExpiresAt: z.iso
      .datetime()
      .nullable()
      .describe("当前待用绑定码的过期时间；无待用码为 null"),
    boundAt: z.iso
      .datetime()
      .nullable()
      .describe("当前 ACTIVE 绑定的时间；未绑定为 null"),
    boundByName: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .describe("完成绑定的操作人姓名；未绑定为 null"),
    lastDeliveryError: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .describe("桥接侧最近一次投递失败原因（超限截断）；无异常为 null"),
    botProfileUrl: z
      .string()
      .min(1)
      .max(512)
      .nullable()
      .describe(
        "管理员配置的机器人资料链接；未配置为 null；用于指引成员在企业微信中打开机器人",
      ),
    notificationOptions: projectWecomGroupNotificationOptionsSchema.describe(
      "项目群推送开关；只影响此后物化的群消息",
    ),
  })
  .strict()
  .meta({ id: "ProjectWecomGroupStatus" });

/**
 * 新签发的一次性项目群绑定码（POST 响应）。明文码只在本响应返回一次：
 * 服务端只保存 SHA-256 Hash，10 分钟有效、一次性消费（ADR-077）。
 */
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

/** 项目群绑定写请求头；CSRF 同步 Token 必填。 */
export const projectWecomGroupMutationHeadersSchema = z
  .object({ "x-csrf-token": z.string().length(43) })
  .strict()
  .meta({ id: "ProjectWecomGroupMutationHeaders" });

/** 解绑幂等重放授权上下文：只涉及目标项目本身。 */
export const projectWecomGroupReplayContextSchema = z
  .object({ projectId: id })
  .strict()
  .meta({ id: "ProjectWecomGroupReplayContext" });

export type ProjectWecomGroupState = z.infer<
  typeof projectWecomGroupStateSchema
>;
export type ProjectWecomGroupStatus = z.infer<
  typeof projectWecomGroupStatusSchema
>;
export type ProjectWecomGroupCode = z.infer<typeof projectWecomGroupCodeSchema>;
export type ProjectWecomGroupNotificationOptions = z.infer<
  typeof projectWecomGroupNotificationOptionsSchema
>;
export type ProjectWecomGroupReplayContext = z.infer<
  typeof projectWecomGroupReplayContextSchema
>;

export const projectWecomGroupSchemas = {
  ProjectWecomGroupStatus: {
    schema: projectWecomGroupStatusSchema,
    summary: "项目企微群绑定状态、待用码过期时间、绑定人、投递异常与机器人链接",
    sensitiveFieldPaths: [],
  },
  ProjectWecomGroupCode: {
    schema: projectWecomGroupCodeSchema,
    summary: "一次性项目群绑定码；明文只返回一次，服务端只存 Hash",
    sensitiveFieldPaths: ["code"],
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
  ProjectWecomGroupMutationHeaders: {
    schema: projectWecomGroupMutationHeadersSchema,
    summary: "项目群绑定写请求头，要求同步 CSRF Token",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ProjectWecomGroupReplayContext: {
    schema: projectWecomGroupReplayContextSchema,
    summary: "项目群解绑幂等重放的最小授权上下文（仅目标项目）",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
