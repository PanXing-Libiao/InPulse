import { z } from "zod";

/** 技术设计 9.3：普通查询最短 1 个字符（单字可搜，含中文单字）；本纵切片登记服务端最大原始长度。 */
export const SEARCH_QUERY_MIN_LENGTH = 1;
export const SEARCH_QUERY_MAX_LENGTH = 200;
export const SEARCH_PAGE_LIMIT_MAX = 50;
export const SEARCH_CURSOR_MAX_LENGTH = 256;

/** 搜索投影允许的实体类型；客户端以此作判别字段，禁止按字符串扩展。 */
export const searchEntityTypeSchema = z.enum([
  "PROJECT",
  "MODULE",
  "TASK",
  "CHANGE_RECORD",
  "EXTERNAL_LINK",
  "TASK_GROUP",
  "LEFTOVER",
]);

const queryBoolean = z.preprocess((value) => {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}, z.boolean());

/**
 * 全局搜索查询参数。q 只接受原始文本长度范围，规范化与长度二次校验由
 * SearchQueryService 执行；cursor 是服务端签名、校验并带过期时间的不透明
 * 字符串，客户端不得解析或修改；limit 默认 20。A 已于 2026-09-08 正式确认。
 */
export const searchQueryRequestSchema = z
  .object({
    q: z.string().min(SEARCH_QUERY_MIN_LENGTH).max(SEARCH_QUERY_MAX_LENGTH),
    cursor: z.string().min(1).max(SEARCH_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_PAGE_LIMIT_MAX).optional(),
    // includeVoid 仅系统管理员显式开启时影响服务端范围，普通调用无授权提升。
    includeVoid: queryBoolean.optional(),
  })
  .strict()
  .meta({ id: "SearchQueryRequest" });

export type SearchQueryRequest = z.infer<typeof searchQueryRequestSchema>;

/**
 * 搜索结果条目；不暴露搜索投影内部 ID，只暴露客户端导航所需稳定字段。
 * `moduleId` 是打开 TASK 页面所需的模块归属；没有模块下级页面的类型为 null。
 * `recordId` 是遗留问题所属的来源记录，客户端据此
 * 打开记录页（其余类型为 null）。客户端打开结果时不得再自行推导这些归属。
 */
export const searchItemSchema = z
  .object({
    projectId: z.number().int().positive(),
    entityType: searchEntityTypeSchema,
    entityId: z.number().int().positive(),
    moduleId: z.number().int().positive().nullable(),
    recordId: z.number().int().positive().nullable(),
    title: z.string().min(1).max(500),
    summary: z.string().max(5000),
  })
  .strict()
  .meta({ id: "SearchItem" });

export type SearchItem = z.infer<typeof searchItemSchema>;

/**
 * 分页 envelope（对应 C-006）：A 已于 2026-09-08 正式确认
 * `items/nextCursor/hasMore` 与不透明游标方向，并作为 `getSearch` 正式契约。
 */
export const searchPageSchema = z
  .object({
    items: z.array(searchItemSchema).max(SEARCH_PAGE_LIMIT_MAX),
    nextCursor: z.string().min(1).max(SEARCH_CURSOR_MAX_LENGTH).nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "SearchPage" });

export type SearchPage = z.infer<typeof searchPageSchema>;
