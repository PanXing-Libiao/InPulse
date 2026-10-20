import { z } from "zod";
import {
  recordDraftContentSchema,
  recordDraftItemSchema,
  recordDraftResourcePathSchema,
} from "./record-drafts.zod.js";
import {
  RECORD_CURSOR_MAX_LENGTH,
  RECORD_PAGE_LIMIT_MAX,
  recordListCursorSchema,
  recordListLimitSchema,
} from "./record-pagination.zod.js";
const id = z.number().int().positive().max(2147483647);
export const recordVersionLeftoverSchema = z
  .object({ id, content: z.string().min(1).max(10000) })
  .strict();
export const publishedRecordContentSchema = recordDraftContentSchema
  .extend({
    confirmLeftoverResolved: z.boolean(),
  })
  .meta({ id: "PublishedRecordContent" });
export const recordPublicationReplayContextSchema = z
  .object({
    projectId: id,
    recordId: id,
    moduleId: id,
    featureId: id.nullable(),
    taskId: id.nullable(),
    impactFeatureIds: z.array(id),
    leftoverItemIds: z.array(id),
  })
  .strict()
  .meta({ id: "RecordPublicationReplayContext" });
export const publishedRecordSchema = recordDraftItemSchema
  .extend({
    status: z.literal("PUBLISHED"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}-CR-[1-9][0-9]*$/),
    currentVersion: id,
    publishedAt: z.iso.datetime(),
    leftovers: z.array(
      recordVersionLeftoverSchema.extend({
        status: z.enum(["ACTIVE", "CONVERTED", "RESOLVED", "VOIDED"]),
        rowVersion: id,
        linkedTaskId: id.nullable(),
      }),
    ),
  })
  .meta({ id: "PublishedRecord" });
export const voidedRecordSchema = publishedRecordSchema
  .extend({
    status: z.literal("VOID"),
    voidedAt: z.iso.datetime(),
    voidReason: z.string().trim().min(1),
  })
  .meta({ id: "VoidedRecord" });
export const readableRecordSchema = z
  .discriminatedUnion("status", [publishedRecordSchema, voidedRecordSchema])
  .meta({ id: "ReadableRecord" });
export type ReadableRecord = z.infer<typeof readableRecordSchema>;
export const readableRecordPageSchema = z
  .object({
    items: z.array(readableRecordSchema).max(RECORD_PAGE_LIMIT_MAX),
    nextCursor: z.string().min(1).max(RECORD_CURSOR_MAX_LENGTH).nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ id: "ReadableRecordPage" });
export type ReadableRecordPage = z.infer<typeof readableRecordPageSchema>;
export const changeRecordVersionSchema = recordDraftContentSchema
  .extend({
    recordId: id,
    projectId: id,
    versionNo: id,
    createdBy: id,
    createdAt: z.iso.datetime(),
    leftovers: z.array(recordVersionLeftoverSchema),
  })
  .meta({ id: "ChangeRecordVersion" });
export const addRecordLeftoverRequestSchema = z
  .object({ content: z.string().trim().min(1).max(10000) })
  .strict()
  .meta({ id: "AddRecordLeftoverRequest" });
export type AddRecordLeftoverRequest = z.infer<
  typeof addRecordLeftoverRequestSchema
>;
export const publishedRecordSchemas = {
  RecordLifecycleRequest: {
    schema: z
      .object({ reason: z.string().trim().min(1).max(10000) })
      .strict()
      .meta({ id: "RecordLifecycleRequest" }),
    summary: "管理员作废或恢复原因",
    sensitiveFieldPaths: [],
  },
  RecordLifecycleResult: {
    schema: z
      .object({
        id,
        projectId: id,
        status: z.enum(["PUBLISHED", "VOID"]),
        rowVersion: id,
      })
      .strict()
      .meta({ id: "RecordLifecycleResult" }),
    summary: "生命周期状态，不缓存原因或正文",
    sensitiveFieldPaths: [],
  },
  RecordLifecycleReplayContext: {
    schema: z
      .object({ projectId: id, recordId: id })
      .strict()
      .meta({ id: "RecordLifecycleReplayContext" }),
    summary: "生命周期结果资源",
    sensitiveFieldPaths: [],
  },
  ReadableRecord: {
    schema: readableRecordSchema,
    summary: "成员 PUBLISHED 或管理员 VOID 详情",
    sensitiveFieldPaths: [],
  },
  ReadableRecordPage: {
    schema: readableRecordPageSchema,
    summary: "显式状态筛选的记录分页（items/nextCursor/hasMore）",
    sensitiveFieldPaths: [],
  },
  RecordListQuery: {
    schema: z
      .object({
        status: z.enum(["PUBLISHED", "VOID"]).optional(),
        cursor: recordListCursorSchema,
        limit: recordListLimitSchema,
      })
      .strict()
      .meta({ id: "RecordListQuery" }),
    summary: "默认 PUBLISHED，VOID 仅管理员；签名游标与 limit 1..100 默认 20",
    sensitiveFieldPaths: [],
  },
  PublishedRecordContent: {
    schema: publishedRecordContentSchema,
    summary: "正式记录内容与清空遗留项确认",
    sensitiveFieldPaths: [],
  },
  AddRecordLeftoverRequest: {
    schema: addRecordLeftoverRequestSchema,
    summary: "详情页在已有正式记录上追加一条遗留问题，仍形成一次记录版本",
    sensitiveFieldPaths: [],
  },
  PublishRecordRequest: {
    schema: z.object({}).strict().meta({ id: "PublishRecordRequest" }),
    summary: "发布已保存草稿，不接受客户端身份或状态",
    sensitiveFieldPaths: [],
  },
  PublishedRecordVersionHeaders: {
    schema: z
      .object({
        "x-csrf-token": z.string().length(43),
        "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/),
        "x-record-version": z.string().regex(/^[1-9][0-9]{0,9}$/),
      })
      .strict()
      .meta({ id: "PublishedRecordVersionHeaders" }),
    summary: "记录行版本及正式版本",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  RecordPublicationReplayContext: {
    schema: recordPublicationReplayContextSchema,
    summary: "正式记录及稳定遗留项结果授权",
    sensitiveFieldPaths: [],
  },
  PublishedRecord: {
    schema: publishedRecordSchema,
    summary: "正式记录当前内容与稳定遗留项",
    sensitiveFieldPaths: [],
  },
  PublishedRecordList: {
    schema: z
      .object({ items: z.array(publishedRecordSchema) })
      .strict()
      .meta({ id: "PublishedRecordList" }),
    summary: "有权项目内已发布记录",
    sensitiveFieldPaths: [],
  },
  ChangeRecordVersion: {
    schema: changeRecordVersionSchema,
    summary: "正式记录不可变版本与遗留内容快照",
    sensitiveFieldPaths: [],
  },
  ChangeRecordVersionList: {
    schema: z
      .object({ items: z.array(changeRecordVersionSchema) })
      .strict()
      .meta({ id: "ChangeRecordVersionList" }),
    summary: "正式记录历史版本",
    sensitiveFieldPaths: [],
  },
  ChangeRecordVersionPath: {
    schema: recordDraftResourcePathSchema
      .extend({ versionNo: z.coerce.number().int().positive().max(2147483647) })
      .meta({ id: "ChangeRecordVersionPath" }),
    summary: "指定记录历史版本",
    sensitiveFieldPaths: [],
  },
};
export type PublishedRecord = z.infer<typeof publishedRecordSchema>;
export type ChangeRecordVersion = z.infer<typeof changeRecordVersionSchema>;

export type PublishedRecordContent = z.infer<
  typeof publishedRecordContentSchema
>;
