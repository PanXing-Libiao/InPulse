import { z } from "zod";

const id = z.number().int().positive().max(2147483647);
export const moduleProjectPathSchema = z
  .object({ projectId: z.coerce.number().int().positive().max(2147483647) })
  .strict()
  .meta({ id: "ModuleProjectPath" });
export const moduleResourcePathSchema = moduleProjectPathSchema
  .extend({ moduleId: z.coerce.number().int().positive().max(2147483647) })
  .meta({ id: "ModuleResourcePath" });
export const moduleEditRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(20000).default(""),
  })
  .strict()
  .meta({ id: "ModuleEditRequest" });
export const moduleMutationHeadersSchema = z
  .object({ "x-csrf-token": z.string().length(43) })
  .strict()
  .meta({ id: "ModuleMutationHeaders" });
export const moduleVersionHeadersSchema = moduleMutationHeadersSchema
  .extend({ "if-match": z.string().regex(/^"[1-9][0-9]{0,9}"$/) })
  .meta({ id: "ModuleVersionHeaders" });
/**
 * ADR-044：模块层面已下线归档，模块没有生命周期状态，因此 ModuleItem 不再有
 * `status` / `archivedAt`；模块列表的「进行中 / 未开始」由 stats.completedTaskCount 推导。
 */
/**
 * 模块卡统计：openTaskCount 与项目卡同口径（work_status = TODO，排除 INVALID
 * 与历史来源分支），统计范围是模块下全部直属任务；completedTaskCount 是同一
 * 口径下 work_status = DONE 的任务数，前端据此显示「未开始」标签。
 */
export const moduleStatsSchema = z
  .object({
    openTaskCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "ModuleStats" });

export type ModuleStats = z.infer<typeof moduleStatsSchema>;

export const moduleItemSchema = z
  .object({
    id,
    projectId: id,
    code: z.string().max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(20000),
    kind: z.enum(["NORMAL", "UNCLASSIFIED"]),
    sortOrder: z.number().int().nonnegative(),
    rowVersion: id,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    stats: moduleStatsSchema,
  })
  .strict()
  .meta({ id: "ModuleItem" });
export const moduleListResponseSchema = z
  .object({ items: z.array(moduleItemSchema) })
  .strict()
  .meta({ id: "ModuleListResponse" });
export const moduleReplayContextSchema = z
  .object({ projectId: id, moduleId: id })
  .strict()
  .meta({ id: "ModuleReplayContext" });
export type ModuleItem = z.infer<typeof moduleItemSchema>;
export type ModuleEditRequest = z.infer<typeof moduleEditRequestSchema>;

export const moduleSchemas = {
  ModuleProjectPath: {
    schema: moduleProjectPathSchema,
    summary: "模块所属项目参数",
    sensitiveFieldPaths: [],
  },
  ModuleResourcePath: {
    schema: moduleResourcePathSchema,
    summary: "模块真实归属参数",
    sensitiveFieldPaths: [],
  },
  ModuleEditRequest: {
    schema: moduleEditRequestSchema,
    summary: "普通或未分类模块名称描述",
    sensitiveFieldPaths: [],
  },
  ModuleMutationHeaders: {
    schema: moduleMutationHeadersSchema,
    summary: "模块创建安全头",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ModuleVersionHeaders: {
    schema: moduleVersionHeadersSchema,
    summary: "模块版本与安全头",
    sensitiveFieldPaths: ["x-csrf-token"],
  },
  ModuleItem: {
    schema: moduleItemSchema,
    summary: "模块公开摘要",
    sensitiveFieldPaths: [],
  },
  ModuleListResponse: {
    schema: moduleListResponseSchema,
    summary: "项目全部模块列表",
    sensitiveFieldPaths: [],
  },
  ModuleReplayContext: {
    schema: moduleReplayContextSchema,
    summary: "模块重放结果资源",
    sensitiveFieldPaths: [],
  },
};
