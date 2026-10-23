import { z } from "zod";

const id = z.number().int().positive().max(2147483647);
const reason = z.string().trim().min(1).max(10000).nullable();

/**
 * ADR-096：功能删除。功能本体、其下全部任务、这些任务的全部迭代记录，以及归属于
 * 该功能的全部记录、版本、遗留项与链接关联会被永久删除；所属模块保留。只保留审计
 * 日志、项目动态与 `feature.delete` 删除事件。
 *
 * 仅「受影响」本功能的模块级任务（`scope_type = 'MODULE'` 且出现在
 * `task_feature_impacts`）**不**随之删除，但指向本功能的影响关系会被清理。
 */
export const deleteFeatureRequestSchema = z
  .object({ reason })
  .strict()
  .meta({ id: "DeleteFeatureRequest" });

/** 删除结果只回述调用方需要确认的影响面；功能正文与审计细节留在各自读路由里。 */
export const featureDeletionResponseSchema = z
  .object({
    id,
    projectId: id,
    moduleId: id,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(500),
    /** 同事务物理删除的功能自身任务数。 */
    deletedTaskCount: z.number().int().min(0),
    /** 同事务物理删除的迭代记录数（功能级与任务级之和）。 */
    deletedRecordCount: z.number().int().min(0),
    /** 同事务删除的外部链接关联数（含级联任务自身关联）。 */
    removedLinkCount: z.number().int().min(0),
  })
  .strict()
  .meta({ id: "FeatureDeletionResponse" });

/**
 * 删除后功能不再可读，因此重放授权只回述「哪个功能在哪个归属下被删除」，
 * 实时门禁在重放时重新判定当前认证、当前成员关系与项目可写性。
 */
export const featureDeletionReplayContextSchema = z
  .object({ projectId: id, moduleId: id, featureId: id })
  .strict()
  .meta({ id: "FeatureDeletionReplayContext" });

export type DeleteFeatureRequest = z.infer<typeof deleteFeatureRequestSchema>;
export type FeatureDeletionResponse = z.infer<
  typeof featureDeletionResponseSchema
>;
export type FeatureDeletionReplayContext = z.infer<
  typeof featureDeletionReplayContextSchema
>;

export const featureDeletionSchemas = {
  DeleteFeatureRequest: {
    schema: deleteFeatureRequestSchema,
    summary: "删除功能的去重原因与非空命令体",
    sensitiveFieldPaths: [],
  },
  FeatureDeletionResponse: {
    schema: featureDeletionResponseSchema,
    summary: "删除功能结果与同事务物理级联的影响面计数",
    sensitiveFieldPaths: [],
  },
  FeatureDeletionReplayContext: {
    schema: featureDeletionReplayContextSchema,
    summary: "删除功能的实时归属授权资源",
    sensitiveFieldPaths: [],
  },
};
