import { z } from "zod";
import { userRefSchema } from "./aggregate-read.zod.js";
import { readableRecordSchema } from "./published-records.zod.js";
import { recordDraftItemSchema } from "./record-drafts.zod.js";
import {
  RECORD_CURSOR_MAX_LENGTH,
  RECORD_PAGE_LIMIT_MAX,
  recordListCursorSchema,
  recordListLimitSchema,
} from "./record-pagination.zod.js";
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
} from "./search.zod.js";

/**
 * B-3b 跨项目记录清单（listRecordFeed · GET /api/v1/change-records）。
 *
 * 状态口径：PUBLISHED / VOID / ALL，status 是可见性真相。非系统管理员请求
 * VOID 或 ALL 时收敛为只返回 PUBLISHED 行（不返回 403，也不泄露其他项目
 * 是否存在作废记录）；非成员项目不返回 404 而是被 AuthorizedProjectScope
 * 静默排除（与 R-6 / R-7 同族）。
 * 来源口径与设计师稿一致：MAIN = 未入聚合组的任务与聚合组主任务，
 * SOURCE = ACTIVE 聚合组的来源任务（已解除成员按普通任务处理），
 * MODULE = 无任务的模块级记录。
 * q 复用 CHANGE_RECORD 全文投影；最短 1、最长 200 字（单字可搜），归一化后为空返回 422。
 * 排序固定 published_at DESC, id DESC（与单项目列表 listChangeRecords 一致）；
 * 游标为服务端 HMAC 签名，绑定 actor、命名空间与 projectId（null = 全部项目），
 * TTL 15 分钟；游标不得跨接口或跨项目复用。
 */
export const RECORD_FEED_STATUSES = ["PUBLISHED", "VOID", "ALL"] as const;
export const RECORD_FEED_SOURCES = ["ALL", "MAIN", "SOURCE", "MODULE"] as const;

export const recordFeedQueryRequestSchema = z
  .object({
    projectId: z.coerce.number().int().positive().max(2147483647).optional(),
    status: z.enum(RECORD_FEED_STATUSES).optional(),
    source: z.enum(RECORD_FEED_SOURCES).optional(),
    q: z
      .string()
      .min(SEARCH_QUERY_MIN_LENGTH)
      .max(SEARCH_QUERY_MAX_LENGTH)
      .optional(),
    cursor: recordListCursorSchema,
    limit: recordListLimitSchema,
  })
  .strict()
  .meta({ id: "RecordFeedQueryRequest" });

export type RecordFeedQueryRequest = z.infer<
  typeof recordFeedQueryRequestSchema
>;

/**
 * 名称回填：记录本体保持 B-1 的 ReadableRecord 形状（含三段正文、遗留项与
 * 作废快照），项目 / 模块 / 作者显示名由服务端按本页可见范围批量补齐，
 * 客户端不再逐条回查；author 只含姓名与头像，不暴露登录名或邮箱。
 */
export const recordFeedItemSchema = z
  .object({
    record: readableRecordSchema,
    projectName: z.string().min(1).max(200),
    moduleName: z.string().min(1).max(200),
    author: userRefSchema,
  })
  .strict()
  .meta({ id: "RecordFeedItem" });

export type RecordFeedItem = z.infer<typeof recordFeedItemSchema>;

export const recordFeedPageSchema = z
  .object({
    items: z.array(recordFeedItemSchema).max(RECORD_PAGE_LIMIT_MAX),
    nextCursor: z.string().min(1).max(RECORD_CURSOR_MAX_LENGTH).nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "RecordFeedPage" });

export type RecordFeedPage = z.infer<typeof recordFeedPageSchema>;

/**
 * B-3b 我的草稿（listMyRecordDrafts · GET /api/v1/me/record-drafts）：作者恒为
 * 当前 actor，服务端不接受任何他人身份参数，因此也不登记 403；草稿仍按实时
 * AuthorizedProjectScope 过滤，被移出项目后其草稿立即不可见。draft 保持 B-1 的
 * RecordDraftItem 形状（含三段正文，便于直接打开编辑），另附名称回填。
 */
export const myRecordDraftItemSchema = z
  .object({
    draft: recordDraftItemSchema,
    projectName: z.string().min(1).max(200),
    moduleName: z.string().min(1).max(200),
  })
  .strict()
  .meta({ id: "MyRecordDraftItem" });

export type MyRecordDraftItem = z.infer<typeof myRecordDraftItemSchema>;

export const myRecordDraftPageSchema = z
  .object({
    items: z.array(myRecordDraftItemSchema).max(RECORD_PAGE_LIMIT_MAX),
    nextCursor: z.string().min(1).max(RECORD_CURSOR_MAX_LENGTH).nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "MyRecordDraftPage" });

export type MyRecordDraftPage = z.infer<typeof myRecordDraftPageSchema>;

export const myRecordDraftListQuerySchema = z
  .object({
    cursor: recordListCursorSchema,
    limit: recordListLimitSchema,
  })
  .strict()
  .meta({ id: "MyRecordDraftListQuery" });

export type MyRecordDraftListQuery = z.infer<
  typeof myRecordDraftListQuerySchema
>;

export const recordFeedSchemas = {
  RecordFeedQueryRequest: {
    schema: recordFeedQueryRequestSchema,
    summary:
      "跨项目记录筛选（projectId / status / source / q）与签名游标、limit 1..100 默认 20；projectId 只收窄服务端授权范围",
    sensitiveFieldPaths: [],
  },
  RecordFeedItem: {
    schema: recordFeedItemSchema,
    summary: "记录本体（ReadableRecord）与项目 / 模块 / 作者名称回填",
    sensitiveFieldPaths: [],
  },
  RecordFeedPage: {
    schema: recordFeedPageSchema,
    summary: "跨项目记录分页（items / nextCursor / hasMore）",
    sensitiveFieldPaths: [],
  },
  MyRecordDraftItem: {
    schema: myRecordDraftItemSchema,
    summary: "本人草稿与项目 / 模块名称回填；不接受他人身份参数",
    sensitiveFieldPaths: [],
  },
  MyRecordDraftPage: {
    schema: myRecordDraftPageSchema,
    summary: "我的草稿分页（items / nextCursor / hasMore）",
    sensitiveFieldPaths: [],
  },
  MyRecordDraftListQuery: {
    schema: myRecordDraftListQuerySchema,
    summary: "我的草稿签名游标与 limit 1..100 默认 20",
    sensitiveFieldPaths: [],
  },
} satisfies Record<
  string,
  { schema: z.ZodType; summary: string; sensitiveFieldPaths: readonly string[] }
>;
