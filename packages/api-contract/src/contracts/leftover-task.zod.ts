import { z } from "zod";
import { taskEditRequestSchema } from "./tasks.zod.js";
const id = z.number().int().positive().max(2147483647);
export const leftoverTaskRequestSchema = taskEditRequestSchema
  .omit({ description: true })
  .extend({
    /**
     * 2026-09-30 用户确认：转换时可补一段任务说明（选填，≤50000）。
     * 来源记录、遗留项编号与遗留原文仍由服务端拼在说明之后，留痕口径不变。
     */
    description: z.string().max(50000).optional(),
    leftoverItemId: id,
    recordVersion: id,
    expectedRowVersion: id,
    leftoverExpectedRowVersion: id,
  })
  .strict()
  .meta({ id: "LeftoverTaskRequest" });
export const leftoverTaskReferenceSchema = z
  .object({ projectId: id, moduleId: id, taskId: id })
  .strict();
export const leftoverTaskResponseSchema = leftoverTaskReferenceSchema
  .extend({
    recordId: id,
    leftoverItemId: id,
    recordVersion: id,
    recordRowVersion: id,
    leftoverRowVersion: id,
  })
  .meta({ id: "LeftoverTaskResponse" });
export const leftoverTaskPreviewSchema = z
  .object({
    recordId: id,
    recordVersion: id,
    rowVersion: id,
    leftoverItemId: id,
    leftoverRowVersion: id,
    status: z.enum(["ACTIVE", "CONVERTED", "RESOLVED"]),
    content: z.string().max(10000),
    linkedTask: leftoverTaskReferenceSchema.nullable(),
  })
  .strict()
  .meta({ id: "LeftoverTaskPreview" });
export const leftoverTaskPreviewQuerySchema = z
  .object({
    leftoverItemId: z.coerce
      .number()
      .int()
      .positive()
      .max(2147483647)
      .optional(),
  })
  .strict()
  .meta({ id: "LeftoverTaskPreviewQuery" });
export const leftoverTaskSourceSchema = z
  .object({
    source: z
      .object({ projectId: id, recordId: id, leftoverItemId: id })
      .strict()
      .nullable(),
  })
  .strict()
  .meta({ id: "LeftoverTaskSource" });
export const leftoverTaskSchemas = {
  LeftoverTaskRequest: {
    schema: leftoverTaskRequestSchema,
    summary: "当前版本稳定遗留转任务确认",
    sensitiveFieldPaths: [],
  },
  LeftoverTaskResponse: {
    schema: leftoverTaskResponseSchema,
    summary: "转换结果与已授权任务引用",
    sensitiveFieldPaths: [],
  },
  LeftoverTaskPreview: {
    schema: leftoverTaskPreviewSchema,
    summary: "服务端推导的当前遗留内容预览",
    sensitiveFieldPaths: [],
  },
  LeftoverTaskPreviewQuery: {
    schema: leftoverTaskPreviewQuerySchema,
    summary: "指定要处理的遗留项；省略时记录必须只有一条遗留问题",
    sensitiveFieldPaths: [],
  },
  LeftoverTaskSource: {
    schema: leftoverTaskSourceSchema,
    summary: "跟进任务的当前可读来源记录",
    sensitiveFieldPaths: [],
  },
  LeftoverTaskReplayContext: {
    schema: leftoverTaskResponseSchema
      .omit({
        recordVersion: true,
        recordRowVersion: true,
        leftoverRowVersion: true,
      })
      .meta({ id: "LeftoverTaskReplayContext" }),
    summary: "转换结果的最小资源引用",
    sensitiveFieldPaths: [],
  },
};
export type LeftoverTaskRequest = z.infer<typeof leftoverTaskRequestSchema>;
export type LeftoverTaskResponse = z.infer<typeof leftoverTaskResponseSchema>;
export type LeftoverTaskPreview = z.infer<typeof leftoverTaskPreviewSchema>;
