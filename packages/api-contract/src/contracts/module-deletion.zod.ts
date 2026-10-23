import { z } from "zod";

const id = z.number().int().positive().max(2147483647);
const reason = z.string().trim().min(1).max(10000).nullable();

/**
 * ADR-096：模块删除。模块本体、其下全部功能与任务、这些实体的全部迭代记录、
 * 版本、遗留项与链接关联会被永久删除；只保留审计日志、项目动态与
 * `module.delete` 删除事件。删除不可恢复：没有还原路由。
 *
 * 未分类模块（`kind = 'UNCLASSIFIED'`）不可删除，服务端返回 409
 * `MODULE_UNCLASSIFIED_PROTECTED`；数据库触发器继续作为最终防线。
 */
export const deleteModuleRequestSchema = z
  .object({ reason })
  .strict()
  .meta({ id: "DeleteModuleRequest" });

/** 删除结果只回述调用方需要确认的影响面；模块正文与审计细节留在各自读路由里。 */
export const moduleDeletionResponseSchema = z
  .object({
    id,
    projectId: id,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    /** 删除时刻的模块类型快照；删除不改变 kind。 */
    kind: z.enum(["NORMAL", "UNCLASSIFIED"]),
    /** 同事务物理删除的功能数。 */
    deletedFeatureCount: z.number().int().min(0),
    /** 同事务物理删除的任务数（模块级任务与其功能下的任务之和）。 */
    deletedTaskCount: z.number().int().min(0),
    /** 同事务物理删除的迭代记录数（模块级、功能级与任务级之和）。 */
    deletedRecordCount: z.number().int().min(0),
    /** 同事务删除的外部链接关联数（含级联任务自身关联）。 */
    removedLinkCount: z.number().int().min(0),
  })
  .strict()
  .meta({ id: "ModuleDeletionResponse" });

/**
 * 删除后模块不再可读，因此重放授权只回述「哪个模块在哪个归属下被删除」，
 * 实时门禁在重放时重新判定当前认证、当前成员关系与项目可写性。
 */
export const moduleDeletionReplayContextSchema = z
  .object({ projectId: id, moduleId: id })
  .strict()
  .meta({ id: "ModuleDeletionReplayContext" });

export type DeleteModuleRequest = z.infer<typeof deleteModuleRequestSchema>;
export type ModuleDeletionResponse = z.infer<
  typeof moduleDeletionResponseSchema
>;
export type ModuleDeletionReplayContext = z.infer<
  typeof moduleDeletionReplayContextSchema
>;

export const moduleDeletionSchemas = {
  DeleteModuleRequest: {
    schema: deleteModuleRequestSchema,
    summary: "删除模块的去重原因与非空命令体",
    sensitiveFieldPaths: [],
  },
  ModuleDeletionResponse: {
    schema: moduleDeletionResponseSchema,
    summary: "删除模块结果与同事务物理级联的影响面计数",
    sensitiveFieldPaths: [],
  },
  ModuleDeletionReplayContext: {
    schema: moduleDeletionReplayContextSchema,
    summary: "删除模块的实时归属授权资源",
    sensitiveFieldPaths: [],
  },
};
