import { z } from "zod";
import { taskEditRequestSchema } from "./tasks.zod.js";
import { moduleEditRequestSchema } from "./modules.zod.js";
const id = z.number().int().positive().max(2147483647);
const existing = z.object({ kind: z.literal("existing"), id }).strict();
export const taskCreateRequestSchema = z
  .object({
    module: z.discriminatedUnion("kind", [
      existing,
      z
        .object({ kind: z.literal("new"), input: moduleEditRequestSchema })
        .strict(),
    ]),
    task: taskEditRequestSchema,
  })
  .strict()
  .meta({ id: "TaskCreateRequest" });
export const taskCreateResultSchema = z
  .object({ projectId: id, moduleId: id, taskId: id })
  .strict()
  .meta({ id: "TaskCreateResult" });
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;
export const taskCreateSchemas = {
  TaskCreateRequest: {
    schema: taskCreateRequestSchema,
    summary: "任务与模块归属联合创建",
    sensitiveFieldPaths: [],
  },
  TaskCreateResult: {
    schema: taskCreateResultSchema,
    summary: "创建结果与重放资源",
    sensitiveFieldPaths: [],
  },
};
