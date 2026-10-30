import { z } from "zod";
import { taskStatusRequestSchema, moduleTaskItemSchema } from "./tasks.zod.js";
import {
  publishedRecordSchema,
  publishedRecordContentSchema,
  recordPublicationReplayContextSchema,
} from "./published-records.zod.js";
const id = z.number().int().positive().max(2147483647);
export const taskCompletionRequestSchema = z
  .union([
    taskStatusRequestSchema.options[0]
      .omit({ action: true })
      .extend({ expectedRowVersion: id }),
    z
      .object({
        mode: z.literal("WITH_RECORD"),
        expectedRowVersion: id,
        record: publishedRecordContentSchema.omit({
          confirmLeftoverResolved: true,
        }),
      })
      .strict(),
    z
      .object({
        mode: z.literal("WITH_RECORD"),
        expectedRowVersion: id,
        recordDraftId: id,
        recordExpectedRowVersion: id,
      })
      .strict(),
  ])
  .meta({ id: "TaskCompletionRequest" });
export const taskCompletionResponseSchema = z
  .object({
    task: moduleTaskItemSchema,
    record: publishedRecordSchema.nullable(),
  })
  .strict()
  .meta({ id: "TaskCompletionResponse" });
export const taskCompletionReplayContextSchema = z
  .object({
    projectId: id,
    moduleId: id,
    taskId: id,
    record: recordPublicationReplayContextSchema.nullable(),
  })
  .strict()
  .meta({ id: "TaskCompletionReplayContext" });
export type TaskCompletionRequest = z.infer<typeof taskCompletionRequestSchema>;
export type TaskCompletionResponse = z.infer<
  typeof taskCompletionResponseSchema
>;
export type TaskCompletionReplayContext = z.infer<
  typeof taskCompletionReplayContextSchema
>;
export const taskCompletionSchemas = {
  TaskStatusCompatibilityReplayContext: {
    schema: taskCompletionReplayContextSchema
      .omit({ record: true })
      .extend({ completion: z.boolean() })
      .meta({ id: "TaskStatusCompatibilityReplayContext" }),
    summary: "旧状态路由完成分支的实时分支资格及结果授权",
    sensitiveFieldPaths: [],
  },
  TaskCompletionRequest: {
    schema: taskCompletionRequestSchema,
    summary: "完成任务：无实际变化或内联/明确草稿互斥发布",
    sensitiveFieldPaths: [],
  },
  TaskCompletionResponse: {
    schema: taskCompletionResponseSchema,
    summary: "同一事务完成的任务与可选正式记录",
    sensitiveFieldPaths: [],
  },
  TaskCompletionReplayContext: {
    schema: taskCompletionReplayContextSchema,
    summary: "完成及发布的实时授权资源",
    sensitiveFieldPaths: [],
  },
  TaskCompletionPath: {
    schema: z
      .object({ taskId: z.coerce.number().int().positive().max(2147483647) })
      .strict()
      .meta({ id: "TaskCompletionPath" }),
    summary: "解析任务真实归属前的标识",
    sensitiveFieldPaths: [],
  },
};
