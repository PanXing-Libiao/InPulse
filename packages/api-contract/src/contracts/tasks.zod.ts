import { z } from "zod";

const id = z.number().int().positive().max(2147483647);
const pathId = z.coerce.number().int().positive().max(2147483647);
/**
 * 任务负责人集合（ADR-040）：至少一人、至多 20 人，去重后按 ID 升序规范化。
 */
const assigneeIds = z
  .array(id)
  .min(1)
  .max(20)
  .overwrite((values) => [...new Set(values)].sort((a, b) => a - b));
export const taskCollectionPathSchema = z
  .object({ projectId: pathId, moduleId: pathId, featureId: pathId })
  .strict()
  .meta({ id: "TaskCollectionPath" });
export const taskResourcePathSchema = taskCollectionPathSchema
  .extend({ taskId: pathId })
  .meta({ id: "TaskResourcePath" });
export const taskEditRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(50000),
    priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
    assigneeIds,
    dueAt: z.iso.datetime().nullable(),
  })
  .strict()
  .meta({ id: "TaskEditRequest" });
export const taskMutationHeadersSchema = z
  .object({ "x-csrf-token": z.string().length(43) })
  .strict()
  .meta({ id: "TaskMutationHeaders" });
export const taskVersionHeadersSchema = taskMutationHeadersSchema
  .extend({ "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/) })
  .meta({ id: "TaskVersionHeaders" });
export const taskItemSchema = taskEditRequestSchema
  .extend({
    id,
    projectId: id,
    moduleId: id,
    featureId: id,
    scopeType: z.literal("FEATURE"),
    code: z.string().max(64),
    /**
     * 派生展示字段：恒等于 assigneeIds[0]，与 assigneeIds 同源同口径（ADR-040）。
     * 集合本身是唯一真相，取值不一致时以 assigneeIds 为准。
     */
    assigneeId: id,
    creatorId: id,
    /** 服务端派生展示名；墓碑账号固定为「删除用户」，不依赖前端活跃目录。 */
    creatorName: z.string().min(1).max(200).optional(),
    assigneeNames: z.array(z.string().min(1).max(200)).max(20).optional(),
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]),
    // ADR-054：任务层面下线归档，ARCHIVED 不可达；INVALID 保留「标记无效」语义。
    lifecycleStatus: z.enum(["ACTIVE", "INVALID"]),
    rowVersion: id,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: "TaskItem" });
export const moduleTaskCollectionPathSchema = taskCollectionPathSchema
  .omit({ featureId: true })
  .meta({ id: "ModuleTaskCollectionPath" });
export const moduleTaskResourcePathSchema = moduleTaskCollectionPathSchema
  .extend({ taskId: pathId })
  .meta({ id: "ModuleTaskResourcePath" });
const impactIds = z
  .array(id)
  .max(1000)
  .overwrite((values) => [...new Set(values)].sort((a, b) => a - b));
export const moduleTaskEditRequestSchema = taskEditRequestSchema
  .extend({ impactFeatureIds: impactIds })
  .meta({ id: "ModuleTaskEditRequest" });
export const moduleTaskItemSchema = taskItemSchema
  .extend({
    scopeType: z.literal("MODULE"),
    featureId: z.null(),
    impactFeatureIds: impactIds,
  })
  .meta({ id: "ModuleTaskItem" });
export const moduleTaskListResponseSchema = z
  .object({ items: z.array(moduleTaskItemSchema) })
  .strict()
  .meta({ id: "ModuleTaskListResponse" });
export const moduleTaskReplayContextSchema = z
  .object({
    projectId: id,
    moduleId: id,
    taskId: id,
    impactFeatureIds: impactIds,
  })
  .strict()
  .meta({ id: "ModuleTaskReplayContext" });
export type ModuleTaskItem = z.infer<typeof moduleTaskItemSchema>;
export type ModuleTaskEditRequest = z.infer<typeof moduleTaskEditRequestSchema>;
export const taskListResponseSchema = z
  .object({ items: z.array(z.union([taskItemSchema, moduleTaskItemSchema])) })
  .strict()
  .meta({ id: "TaskListResponse" });
export const taskReplayContextSchema = z
  .object({ projectId: id, moduleId: id, featureId: id, taskId: id })
  .strict()
  .meta({ id: "TaskReplayContext" });
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskEditRequest = z.infer<typeof taskEditRequestSchema>;
export const taskAssigneesResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          id,
          name: z.string().max(200),
          avatarUrl: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: "TaskAssigneesResponse" });
export const taskStatusRequestSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("COMPLETE"),
        mode: z.literal("WITHOUT_RECORD"),
        completionReason: z.enum([
          "测试验证",
          "技术调研",
          "文档补充",
          "环境配置",
          "沟通协调",
          "其他",
        ]),
        note: z.string().trim().max(9800),
      })
      .strict(),
    z
      .object({
        action: z.enum(["REOPEN", "CANCEL", "RESTORE"]),
        reason: z.string().trim().min(1).max(10000).nullable(),
      })
      .strict(),
  ])
  .meta({ id: "TaskStatusRequest" });
export type TaskStatusRequest = z.infer<typeof taskStatusRequestSchema>;
export const taskStatusHistoryResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().regex(/^[1-9][0-9]*$/),
          fromWorkStatus: z.enum(["TODO", "DONE", "CANCELED"]).nullable(),
          toWorkStatus: z.enum(["TODO", "DONE", "CANCELED"]),
          completedAtSnapshot: z.iso.datetime().nullable(),
          completionNoteSnapshot: z.string().max(10000).nullable(),
          reason: z.string().max(10000).nullable(),
          changedBy: id,
          changedByName: z.string().min(1).max(200),
          changedAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: "TaskStatusHistoryResponse" });
export const taskSchemas = {
  TaskStatusRequest: {
    schema: taskStatusRequestSchema,
    summary: "任务状态命令；完成仅支持无功能变化",
    sensitiveFieldPaths: [],
  },
  TaskStatusHistoryResponse: {
    schema: taskStatusHistoryResponseSchema,
    summary: "不可变任务状态历史和完成快照",
    sensitiveFieldPaths: [],
  },
  ModuleTaskCollectionPath: {
    schema: moduleTaskCollectionPathSchema,
    summary: "模块级任务父级",
    sensitiveFieldPaths: [],
  },
  ModuleTaskResourcePath: {
    schema: moduleTaskResourcePathSchema,
    summary: "模块级任务资源",
    sensitiveFieldPaths: [],
  },
  ModuleTaskEditRequest: {
    schema: moduleTaskEditRequestSchema,
    summary: "模块任务及去重影响功能集合",
    sensitiveFieldPaths: [],
  },
  ModuleTaskItem: {
    schema: moduleTaskItemSchema,
    summary: "单份模块任务及当前影响集合",
    sensitiveFieldPaths: [],
  },
  ModuleTaskListResponse: {
    schema: moduleTaskListResponseSchema,
    summary: "模块任务列表",
    sensitiveFieldPaths: [],
  },
  ModuleTaskReplayContext: {
    schema: moduleTaskReplayContextSchema,
    summary: "模块任务重放资源与影响功能",
    sensitiveFieldPaths: [],
  },
  TaskAssigneesResponse: {
    schema: taskAssigneesResponseSchema,
    summary: "当前项目可指派成员",
    sensitiveFieldPaths: [],
  },
  TaskCollectionPath: {
    schema: taskCollectionPathSchema,
    summary: "任务真实父级归属",
    sensitiveFieldPaths: [],
  },
  TaskResourcePath: {
    schema: taskResourcePathSchema,
    summary: "任务资源归属",
    sensitiveFieldPaths: [],
  },
  TaskEditRequest: {
    schema: taskEditRequestSchema,
    summary: "任务可编辑字段",
    sensitiveFieldPaths: [],
  },
  TaskMutationHeaders: {
    schema: taskMutationHeadersSchema,
    summary: "任务创建安全头",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  TaskVersionHeaders: {
    schema: taskVersionHeadersSchema,
    summary: "任务版本安全头",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  TaskItem: {
    schema: taskItemSchema,
    summary: "功能级任务",
    sensitiveFieldPaths: [],
  },
  TaskListResponse: {
    schema: taskListResponseSchema,
    summary: "功能内任务与模块级引用，每个任务只返回一次",
    sensitiveFieldPaths: [],
  },
  TaskReplayContext: {
    schema: taskReplayContextSchema,
    summary: "任务重放授权资源",
    sensitiveFieldPaths: [],
  },
};
