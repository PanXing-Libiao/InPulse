import { z } from "zod";

import {
  AI_ASSIST_IMAGE_TEXT_LIMIT,
  AI_ASSIST_MAX_IMAGES,
  aiAssistImageSchema,
} from "./ai-assist-image.zod.js";

const id = z.number().int().positive().max(2147483647);

/**
 * 文档导入的规模上限（ADR-064）。文档按字符计数，UTF-8 最坏约 600 KiB，
 * 落在 API 与网关 1 MiB JSON 传输上限内；实体上限约束单事务写入规模。
 */
export const DOCUMENT_IMPORT_MAX_TEXT_LENGTH = 200_000;
export const DOCUMENT_IMPORT_MAX_MODULES = 100;
export const DOCUMENT_IMPORT_MAX_FEATURES = 500;
export const DOCUMENT_IMPORT_MAX_TASKS = 500;
export const DOCUMENT_IMPORT_MAX_TOTAL_ENTITIES = 1_000;
export const DOCUMENT_IMPORT_TEMPLATE_VERSION = "1";
export const DOCUMENT_IMPORT_MAX_MEMBERS = 300;
/** ADR-067 AI 辅助草稿的预检问题上限：只作提示，不阻断返回草稿。 */
export const DOCUMENT_IMPORT_ASSIST_MAX_ISSUES = 50;

const digest = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe("文档规范化文本（去 BOM、CRLF→LF）的 SHA-256 十六进制摘要");

const documentText = z
  .string()
  .min(1)
  .max(DOCUMENT_IMPORT_MAX_TEXT_LENGTH)
  .describe("固定模板文档原文（UTF-8）");

/** 两种预览入口共用的请求体：只含文档原文。 */
export const projectDocumentImportPreviewRequestSchema = z
  .object({ document: documentText })
  .strict()
  .meta({ id: "ProjectDocumentImportPreviewRequest" });

/** 两种执行入口共用的请求体：文档原文 + 预览摘要，摘要不一致返回 409。 */
export const projectDocumentImportRequestSchema = z
  .object({ document: documentText, expectedDigest: digest })
  .strict()
  .meta({ id: "ProjectDocumentImportRequest" });

/** 行级问题；ERROR 阻止执行，WARNING 允许执行但需前端确认。 */
export const documentImportIssueSchema = z
  .object({
    severity: z.enum(["ERROR", "WARNING"]),
    line: z.number().int().min(1).max(1_000_000),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
  })
  .strict()
  .meta({ id: "DocumentImportIssue" });

/** 负责人令牌解析结果；token 为文档中的原文，未解析时不产生条目。 */
export const documentImportMemberRefSchema = z
  .object({
    token: z.string().min(1).max(200),
    userId: id,
    name: z.string().min(1).max(200),
  })
  .strict()
  .meta({ id: "DocumentImportMemberRef" });

/** 模块计划项：CREATE 新建，REUSE 复用项目内同名模块（不覆盖任何字段）。 */
export const documentImportModulePlanSchema = z
  .object({
    line: z.number().int().min(1),
    name: z.string().min(1).max(200),
    action: z.enum(["CREATE", "REUSE"]),
    moduleId: id.nullable(),
  })
  .strict()
  .meta({ id: "DocumentImportModulePlan" });

/** 功能计划项；REUSE 表示复用同模块内唯一同名功能。 */
export const documentImportFeaturePlanSchema = z
  .object({
    line: z.number().int().min(1),
    moduleName: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    action: z.enum(["CREATE", "REUSE"]),
    featureId: id.nullable(),
  })
  .strict()
  .meta({ id: "DocumentImportFeaturePlan" });

/** 任务计划项；全部任务一律新建。 */
export const documentImportTaskPlanSchema = z
  .object({
    line: z.number().int().min(1),
    scope: z.enum(["FEATURE", "MODULE"]),
    moduleName: z.string().min(1).max(200),
    featureName: z.string().min(1).max(500).nullable(),
    title: z.string().min(1).max(500),
    assignees: z.array(documentImportMemberRefSchema).min(1).max(20),
    priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
    dueAt: z.iso.datetime().nullable(),
  })
  .strict()
  .meta({ id: "DocumentImportTaskPlan" });
/** 整项目导入模式（模式 B）解析出的项目段；模式 A 该字段为 null。 */
export const documentImportProjectPlanSchema = z
  .object({
    name: z.string().min(1).max(200),
    code: z.string().min(2).max(32),
    description: z.string().max(20_000),
    codeAvailable: z.boolean(),
    /** 文档项目成员与任务负责人解析去重后的成员集合（含默认在内的创建者）。 */
    members: z
      .array(documentImportMemberRefSchema)
      .max(DOCUMENT_IMPORT_MAX_MEMBERS),
  })
  .strict()
  .meta({ id: "DocumentImportProjectPlan" });

export const documentImportSummarySchema = z
  .object({
    moduleCount: z
      .number()
      .int()
      .nonnegative()
      .max(DOCUMENT_IMPORT_MAX_MODULES),
    featureCount: z
      .number()
      .int()
      .nonnegative()
      .max(DOCUMENT_IMPORT_MAX_FEATURES),
    taskCount: z.number().int().nonnegative().max(DOCUMENT_IMPORT_MAX_TASKS),
    moduleCreateCount: z.number().int().nonnegative(),
    moduleReuseCount: z.number().int().nonnegative(),
    featureCreateCount: z.number().int().nonnegative(),
    featureReuseCount: z.number().int().nonnegative(),
    taskCreateCount: z.number().int().nonnegative(),
    /** 整项目导入将自动加入的成员数（含默认在内的创建者）；项目内导入恒为 0。 */
    memberAddCount: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "DocumentImportSummary" });

/** 同一摘要文档的既有导入批次；非 null 时执行将返回 409。 */
export const documentImportDuplicateSchema = z
  .object({
    projectId: id,
    importedAt: z.iso.datetime(),
    actorName: z.string().min(1).max(200),
  })
  .strict()
  .meta({ id: "DocumentImportDuplicate" });

/** 两种预览入口共用的响应：计划、问题清单与摘要信息。 */
export const projectDocumentImportPreviewResponseSchema = z
  .object({
    digest,
    templateVersion: z.literal(DOCUMENT_IMPORT_TEMPLATE_VERSION),
    project: documentImportProjectPlanSchema.nullable(),
    summary: documentImportSummarySchema,
    modules: z
      .array(documentImportModulePlanSchema)
      .max(DOCUMENT_IMPORT_MAX_MODULES),
    features: z
      .array(documentImportFeaturePlanSchema)
      .max(DOCUMENT_IMPORT_MAX_FEATURES),
    tasks: z.array(documentImportTaskPlanSchema).max(DOCUMENT_IMPORT_MAX_TASKS),
    issues: z.array(documentImportIssueSchema).max(5_000),
    canApply: z.boolean(),
    duplicate: documentImportDuplicateSchema.nullable(),
  })
  .strict()
  .meta({ id: "ProjectDocumentImportPreviewResponse" });

export const documentImportResultCountsSchema = z
  .object({
    modules: z.number().int().nonnegative(),
    features: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    reusedModules: z.number().int().nonnegative(),
    reusedFeatures: z.number().int().nonnegative(),
    addedMembers: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "DocumentImportResultCounts" });

export const documentImportResultModuleSchema = z
  .object({ id, code: z.string().min(2).max(64) })
  .strict()
  .meta({ id: "DocumentImportResultModule" });

export const documentImportResultFeatureSchema = z
  .object({ id, code: z.string().min(2).max(64), moduleId: id })
  .strict()
  .meta({ id: "DocumentImportResultFeature" });

export const documentImportResultTaskSchema = z
  .object({
    id,
    code: z.string().min(2).max(64),
    moduleId: id,
    featureId: id.nullable(),
    scopeType: z.enum(["FEATURE", "MODULE"]),
  })
  .strict()
  .meta({ id: "DocumentImportResultTask" });
/** 两种执行入口共用的响应：创建结果与重放所需的最小资源引用。 */
export const projectDocumentImportResultSchema = z
  .object({
    projectId: id,
    projectCode: z.string().min(2).max(32),
    digest,
    counts: documentImportResultCountsSchema,
    modules: z
      .array(documentImportResultModuleSchema)
      .max(DOCUMENT_IMPORT_MAX_MODULES),
    features: z
      .array(documentImportResultFeatureSchema)
      .max(DOCUMENT_IMPORT_MAX_FEATURES),
    tasks: z
      .array(documentImportResultTaskSchema)
      .max(DOCUMENT_IMPORT_MAX_TASKS),
  })
  .strict()
  .meta({ id: "ProjectDocumentImportResult" });

/** 幂等重放授权上下文：结果资源全部为本次新建/复用的稳定 ID。 */
export const projectDocumentImportReplayContextSchema = z
  .object({
    projectId: id,
    moduleIds: z.array(id).max(DOCUMENT_IMPORT_MAX_MODULES),
    featureIds: z.array(id).max(DOCUMENT_IMPORT_MAX_FEATURES),
    taskIds: z.array(id).max(DOCUMENT_IMPORT_MAX_TASKS),
  })
  .strict()
  .meta({ id: "ProjectDocumentImportReplayContext" });

/**
 * ADR-094 AI 辅助转换的 UI 目标：目标项目由当前页面上下文提供，模块 / 功能
 * 只能在该项目内逐级收窄。服务端不信任这里的归属声明，会在提示词注入前
 * 重新校验项目写权限与模块 / 功能真实归属。
 */
export const documentImportAssistTargetSchema = z
  .object({
    projectId: id,
    moduleId: id.nullable(),
    featureId: id.nullable(),
  })
  .strict()
  .refine((value) => value.featureId === null || value.moduleId !== null, {
    message: "featureId 需要同时提供 moduleId",
    path: ["featureId"],
  })
  .meta({ id: "DocumentImportAssistTarget" });

/**
 * ADR-067 AI 辅助转换：把用户自己的项目文档（任意结构）转成固定模板草稿。
 * ADR-094 增加可选的目标上下文；不传 target 时保持旧行为，传 WHOLE_PROJECT
 * 时禁止携带 target。纯校验接口：不写任何持久化状态；草稿必须经用户确认后
 * 走既有预览/导入链路。
 */
export const documentImportAssistRequestSchema = z
  .object({
    mode: z
      .enum(["IN_PROJECT", "WHOLE_PROJECT"])
      .describe(
        "IN_PROJECT 对应项目内导入（模式 A，草稿不含项目段）；WHOLE_PROJECT 对应整项目导入（模式 B，草稿必须含项目段与项目编码）",
      ),
    text: z
      .string()
      .max(DOCUMENT_IMPORT_MAX_TEXT_LENGTH)
      .describe(
        "用户原始文档抽取后的纯文本（UTF-8），不要求符合固定模板；只提供截图时可为空",
      ),
    images: z
      .array(aiAssistImageSchema)
      .max(AI_ASSIST_MAX_IMAGES)
      .optional()
      .describe(
        "聊天记录等截图（base64，不含 data: 前缀）；只用于本次识别，不落库",
      ),
    target: documentImportAssistTargetSchema
      .optional()
      .describe(
        "项目内导入时可选的 UI 目标：只带 projectId 表示项目根级；带 moduleId 表示指定模块；再带 featureId 表示指定功能。整项目导入不得携带。",
      ),
  })
  .strict()
  .refine(
    (value) => value.mode !== "WHOLE_PROJECT" || value.target === undefined,
    {
      message: "整项目导入不能携带 target",
      path: ["target"],
    },
  )
  .refine(
    (value) => value.text.trim().length > 0 || (value.images?.length ?? 0) > 0,
    {
      message: "至少提供文本或一张图片",
      path: ["text"],
    },
  )
  .refine(
    (value) =>
      (value.images?.length ?? 0) === 0 ||
      value.text.length <= AI_ASSIST_IMAGE_TEXT_LIMIT,
    {
      message: "带截图时文本不能超过 " + AI_ASSIST_IMAGE_TEXT_LIMIT + " 字符",
      path: ["text"],
    },
  )
  .meta({ id: "DocumentImportAssistRequest" });

export const documentImportAssistResponseSchema = z
  .object({
    markdown: z
      .string()
      .min(1)
      .max(DOCUMENT_IMPORT_MAX_TEXT_LENGTH)
      .describe("服务端按固定模板预检后的草稿全文，供用户确认后进入预览"),
    model: z.string().min(1).max(200).describe("实际调用并返回结果的模型标识"),
    issues: z
      .array(documentImportIssueSchema)
      .max(DOCUMENT_IMPORT_ASSIST_MAX_ISSUES)
      .describe("解析器预检问题（ERROR 不阻止返回草稿，需用户修正后预览）"),
  })
  .strict()
  .meta({ id: "DocumentImportAssistResponse" });

export type ProjectDocumentImportPreviewRequest = z.infer<
  typeof projectDocumentImportPreviewRequestSchema
>;
export type ProjectDocumentImportRequest = z.infer<
  typeof projectDocumentImportRequestSchema
>;
export type ProjectDocumentImportPreviewResponse = z.infer<
  typeof projectDocumentImportPreviewResponseSchema
>;
export type ProjectDocumentImportResult = z.infer<
  typeof projectDocumentImportResultSchema
>;
export type ProjectDocumentImportReplayContext = z.infer<
  typeof projectDocumentImportReplayContextSchema
>;
export type DocumentImportIssue = z.infer<typeof documentImportIssueSchema>;
export type DocumentImportMemberRef = z.infer<
  typeof documentImportMemberRefSchema
>;
export type DocumentImportModulePlan = z.infer<
  typeof documentImportModulePlanSchema
>;
export type DocumentImportFeaturePlan = z.infer<
  typeof documentImportFeaturePlanSchema
>;
export type DocumentImportTaskPlan = z.infer<
  typeof documentImportTaskPlanSchema
>;
export type DocumentImportProjectPlan = z.infer<
  typeof documentImportProjectPlanSchema
>;
export type DocumentImportSummary = z.infer<typeof documentImportSummarySchema>;
export type DocumentImportDuplicate = z.infer<
  typeof documentImportDuplicateSchema
>;
export type DocumentImportAssistTarget = z.infer<
  typeof documentImportAssistTargetSchema
>;
export type DocumentImportAssistRequest = z.infer<
  typeof documentImportAssistRequestSchema
>;
export type DocumentImportAssistResponse = z.infer<
  typeof documentImportAssistResponseSchema
>;

export const documentImportSchemas = {
  ProjectDocumentImportPreviewRequest: {
    schema: projectDocumentImportPreviewRequestSchema,
    summary: "文档导入预览请求：固定模板原文",
    sensitiveFieldPaths: [],
  },
  ProjectDocumentImportRequest: {
    schema: projectDocumentImportRequestSchema,
    summary: "文档导入执行请求：原文与预览摘要",
    sensitiveFieldPaths: [],
  },
  ProjectDocumentImportPreviewResponse: {
    schema: projectDocumentImportPreviewResponseSchema,
    summary: "文档导入预览：计划、问题清单与重复提示",
    sensitiveFieldPaths: [],
  },
  ProjectDocumentImportResult: {
    schema: projectDocumentImportResultSchema,
    summary: "文档导入结果：创建资源 ID/编号与计数",
    sensitiveFieldPaths: [],
  },
  ProjectDocumentImportReplayContext: {
    schema: projectDocumentImportReplayContextSchema,
    summary: "文档导入重放资源引用",
    sensitiveFieldPaths: [],
  },
  DocumentImportAssistTarget: {
    schema: documentImportAssistTargetSchema,
    summary: "AI 辅助文档转换的 UI 目标：项目、可选模块与可选功能",
    sensitiveFieldPaths: [],
  },
  DocumentImportAssistRequest: {
    schema: documentImportAssistRequestSchema,
    summary: "AI 辅助文档转换请求：模式、用户文档原文、截图与可选 UI 目标",
    sensitiveFieldPaths: [],
  },
  DocumentImportAssistResponse: {
    schema: documentImportAssistResponseSchema,
    summary: "AI 辅助文档转换响应：模板草稿、模型与预检问题",
    sensitiveFieldPaths: [],
  },
  DocumentImportIssue: {
    schema: documentImportIssueSchema,
    summary: "文档导入行级问题",
    sensitiveFieldPaths: [],
  },
  DocumentImportMemberRef: {
    schema: documentImportMemberRefSchema,
    summary: "负责人/成员令牌解析结果",
    sensitiveFieldPaths: [],
  },
  DocumentImportModulePlan: {
    schema: documentImportModulePlanSchema,
    summary: "模块计划项",
    sensitiveFieldPaths: [],
  },
  DocumentImportFeaturePlan: {
    schema: documentImportFeaturePlanSchema,
    summary: "功能计划项",
    sensitiveFieldPaths: [],
  },
  DocumentImportTaskPlan: {
    schema: documentImportTaskPlanSchema,
    summary: "任务计划项",
    sensitiveFieldPaths: [],
  },
  DocumentImportProjectPlan: {
    schema: documentImportProjectPlanSchema,
    summary: "整项目导入的项目段计划",
    sensitiveFieldPaths: [],
  },
  DocumentImportSummary: {
    schema: documentImportSummarySchema,
    summary: "文档导入计划计数",
    sensitiveFieldPaths: [],
  },
  DocumentImportDuplicate: {
    schema: documentImportDuplicateSchema,
    summary: "同摘要文档的既有导入批次",
    sensitiveFieldPaths: [],
  },
  DocumentImportResultCounts: {
    schema: documentImportResultCountsSchema,
    summary: "文档导入结果计数",
    sensitiveFieldPaths: [],
  },
  DocumentImportResultModule: {
    schema: documentImportResultModuleSchema,
    summary: "结果中的模块引用",
    sensitiveFieldPaths: [],
  },
  DocumentImportResultFeature: {
    schema: documentImportResultFeatureSchema,
    summary: "结果中的功能引用",
    sensitiveFieldPaths: [],
  },
  DocumentImportResultTask: {
    schema: documentImportResultTaskSchema,
    summary: "结果中的任务引用",
    sensitiveFieldPaths: [],
  },
} as const;

/**
 * ADR-064 固定模板全文（ADR-067 自 apps/web 迁入，唯一来源）：
 * 服务端 AI 提示词与解析器 / 模板一致性测试直接引用本常量，前端经契约生成物
 * （@generated/api）读取同一文本，漂移检查按字节守护；顶部以 > 开头的说明行
 * 会被解析器忽略，方便把格式规则与模板放在同一个文件里，也方便直接粘贴
 * 其它工具（含 AI）按此模板填写后的整段输出。
 */
export const DOCUMENT_IMPORT_TEMPLATE = [
  "> InPulse 文档导入模板（模板版本 1）",
  "> 填写说明：以下以 > 开头的行是说明行，导入时会被忽略，可以保留、也可以删除。",
  "> 1. 只认识三类行：",
  ">    - 标题行：# 项目：名称 / ## 模块：名称 / ### 功能：名称 / #### 任务：标题",
  ">    - 字段行：- 字段名：值（必须以 - 开头；冒号用全角「：」或半角「:」都可以）",
  ">    - 说明行（以 > 开头）与代码围栏行（``` 或 ~~~）会被忽略，不会导入",
  "> 2. 字段名必须与下面完全一致，不要自创、不要改名：",
  ">    项目段：- 项目编码（整项目导入时必填；大写字母开头，只用大写字母、数字、下划线，2-32 位）",
  ">            - 项目说明；- 项目成员（整项目导入时必填，逗号分隔，写登录名或姓名；须包含创建者本人与全部任务负责人）",
  ">    模块段：- 说明",
  ">    功能段：- 当前说明；- 验收标准；- 标签（逗号分隔）",
  ">    任务段：- 负责人（必填，逗号分隔，写登录名或姓名）",
  ">            - 优先级（普通 / 高 / 紧急，或 NORMAL / HIGH / URGENT；不填为普通）",
  ">            - 截止（必须 YYYY-MM-DD，例如 2026-12-31）；- 描述",
  ">            - 影响功能（只有模块级任务 ### 任务 可以写，逗号分隔）",
  "> 3. 层级：任务放在「#### 任务」下，或作为「### 任务」模块级任务；不要跳级、不要错位。",
  "> 4. 范围：从项目列表「从文档导入整项目」导入时，文档必须包含「# 项目」段；",
  ">    从模块页「从文档导入」导入已有项目时，不要写「# 项目」段。",
  "> 5. 负责人与项目成员必须是系统里已有的用户（写登录名或姓名）；整项目导入时项目成员必填，且须包含创建者本人与全部任务负责人，他们会一起成为项目成员。",
  "> 6. 没填的可选字段会按默认值处理；不要把示例放进代码块（围栏内的正文也会被解析）。",
  ">",
  "> 下面是示例结构，请把示例文字替换成你的真实内容（结构保留）：",
  "",
  "# 项目：商城系统",
  "- 项目编码：SHOP",
  "- 项目说明：一句话说明项目目标与范围",
  "- 项目成员：zhangsan, lisi",
  "",
  "## 模块：支付",
  "- 说明：支付与退款能力",
  "",
  "### 功能：微信支付退款回调",
  "- 当前说明：现在如何处理回调",
  "- 验收标准：处理完成后应满足的条件",
  "- 标签：支付, 重要",
  "",
  "#### 任务：修复重复回调",
  "- 负责人：zhangsan",
  "- 优先级：高",
  "- 截止：2026-12-31",
  "- 描述：问题背景与期望结果",
  "",
  "### 任务：模块级任务示例",
  "- 负责人：lisi",
  "- 影响功能：微信支付退款回调",
].join("\n");
