import { z } from "zod";

const id = z.number().int().positive().max(2147483647);
const reason = z.string().trim().min(1).max(10000).nullable();

/**
 * ADR-096：删除任务。任务本体、状态历史、负责人、影响关系、聚合组关系、外部链接
 * 关联，以及该任务全部迭代记录、版本和遗留项会被永久删除；只保留审计日志、项目
 * 动态与 `task.delete` 删除事件。删除不可恢复：没有还原路由，也不复用
 * `transitionTask` 的 CANCEL / RESTORE。
 */
export const deleteTaskRequestSchema = z
  .object({ reason })
  .strict()
  .meta({ id: "DeleteTaskRequest" });

/** 删除结果只回述调用方需要确认的影响面；任务正文与审计细节留在各自读路由里。 */
export const taskDeletionResponseSchema = z
  .object({
    id,
    projectId: id,
    moduleId: id,
    code: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    /** 删除时刻的工作状态快照：删除不改变状态，只把它从可见范围移除。 */
    workStatus: z.enum(["TODO", "DONE", "CANCELED"]),
    /** 同事务物理删除的迭代记录数（含草稿、已发布与历史版本）。 */
    deletedRecordCount: z.number().int().min(0),
    /** 同事务删除的任务外部链接关联数；链接主表本身保留。 */
    removedLinkCount: z.number().int().min(0),
    /** 删除时解除的聚合组身份；不在活跃聚合组中为 null。 */
    detachedGroupRole: z.enum(["MAIN", "SOURCE"]).nullable(),
  })
  .strict()
  .meta({ id: "TaskDeletionResponse" });

/**
 * 删除后任务不再可读，因此重放授权只回述「哪个任务在哪个归属下被删除」，
 * 实时门禁在重放时重新判定当前认证、当前成员关系与项目可写性。
 */
export const taskDeletionReplayContextSchema = z
  .object({
    projectId: id,
    moduleId: id,
    taskId: id,
  })
  .strict()
  .meta({ id: "TaskDeletionReplayContext" });

export type DeleteTaskRequest = z.infer<typeof deleteTaskRequestSchema>;
export type TaskDeletionResponse = z.infer<typeof taskDeletionResponseSchema>;
export type TaskDeletionReplayContext = z.infer<
  typeof taskDeletionReplayContextSchema
>;

export const taskDeletionSchemas = {
  DeleteTaskRequest: {
    schema: deleteTaskRequestSchema,
    summary: "删除任务的去重原因与非空命令体",
    sensitiveFieldPaths: [],
  },
  TaskDeletionResponse: {
    schema: taskDeletionResponseSchema,
    summary: "删除结果与同事务物理删除的影响面计数",
    sensitiveFieldPaths: [],
  },
  TaskDeletionReplayContext: {
    schema: taskDeletionReplayContextSchema,
    summary: "删除任务的实时归属授权资源",
    sensitiveFieldPaths: [],
  },
};
