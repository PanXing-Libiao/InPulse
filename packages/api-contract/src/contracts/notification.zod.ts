import { z } from "zod";

import { projectNotificationCategories } from "../project-notification-categories.js";

export const NOTIFICATION_PAGE_LIMIT_MAX = 50;
export const NOTIFICATION_CURSOR_MAX_LENGTH = 512;

const booleanField = z.preprocess((value) => {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}, z.boolean());

export const notificationPathSchema = z
  .object({
    notificationId: z.coerce.number().int().positive(),
  })
  .strict()
  .meta({ id: "NotificationPath" });

const mutedCategoryPattern = `(?:${projectNotificationCategories
  .map((category) => category.replaceAll(".", "\\."))
  .join("|")})`;

/**
 * 项目通知选项过滤参数：以逗号分隔的 projectId:category 对表示该浏览器
 * 关闭的项目通知类别。它只是当前用户的只读视图筛选，不参与资源授权。
 */
export const notificationMutedProjectCategoriesSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    new RegExp(
      "^(?:[1-9][0-9]*:" +
        mutedCategoryPattern +
        ")(?:,[1-9][0-9]*:" +
        mutedCategoryPattern +
        ")*$",
    ),
    "mutedProjectCategories must be comma-separated projectId:category pairs",
  )
  .meta({ id: "NotificationMutedProjectCategories" });

export const notificationQueryRequestSchema = z
  .object({
    mutedProjectCategories: notificationMutedProjectCategoriesSchema.optional(),
    cursor: z.string().min(1).max(NOTIFICATION_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(NOTIFICATION_PAGE_LIMIT_MAX)
      .optional(),
    unreadOnly: booleanField.optional(),
  })
  .strict()
  .meta({ id: "NotificationQueryRequest" });

export const notificationMuteQueryRequestSchema = z
  .object({
    mutedProjectCategories: notificationMutedProjectCategoriesSchema.optional(),
  })
  .strict()
  .meta({ id: "NotificationMuteQueryRequest" });

export const notificationItemSchema = z
  .object({
    id: z.string().min(1).max(80),
    projectId: z.number().int().positive().nullable(),
    notificationType: z.string().min(1).max(100),
    title: z.string().min(1).max(500),
    body: z.string().max(5000),
    targetPath: z.string().min(1).max(2048).nullable(),
    createdAt: z.string().min(1).max(64),
    readAt: z.string().min(1).max(64).nullable(),
  })
  .strict()
  .meta({ id: "NotificationItem" });

export const notificationPageSchema = z
  .object({
    items: z.array(notificationItemSchema).max(NOTIFICATION_PAGE_LIMIT_MAX),
    nextCursor: z
      .string()
      .min(1)
      .max(NOTIFICATION_CURSOR_MAX_LENGTH)
      .nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "NotificationPage" });

export const notificationUnreadCountResponseSchema = z
  .object({
    unreadCount: z.number().int().min(0),
  })
  .strict()
  .meta({ id: "NotificationUnreadCountResponse" });

export const notificationReplayContextSchema = z
  .object({
    notificationId: z.number().int().positive(),
    recipientId: z.number().int().positive(),
  })
  .strict()
  .meta({ id: "NotificationReplayContext" });

export type NotificationPath = z.infer<typeof notificationPathSchema>;
export type NotificationQueryRequest = z.infer<
  typeof notificationQueryRequestSchema
>;
export type NotificationMuteQueryRequest = z.infer<
  typeof notificationMuteQueryRequestSchema
>;
export type NotificationItem = z.infer<typeof notificationItemSchema>;
export type NotificationPage = z.infer<typeof notificationPageSchema>;
export type NotificationUnreadCountResponse = z.infer<
  typeof notificationUnreadCountResponseSchema
>;
export type NotificationReplayContext = z.infer<
  typeof notificationReplayContextSchema
>;
