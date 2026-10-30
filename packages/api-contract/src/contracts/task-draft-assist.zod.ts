import { z } from "zod";

import {
  AI_ASSIST_MAX_IMAGES,
  aiAssistImageSchema,
} from "./ai-assist-image.zod.js";

/** 单条对话消息上限：任务描述通常一两句话，留足粘贴需求正文的空间。 */
export const TASK_DRAFT_ASSIST_MAX_MESSAGE_LENGTH = 2_000;
/** 只带最近 10 轮，避免上下文无限增长，也避免把无关对话喂给模型。 */
export const TASK_DRAFT_ASSIST_MAX_HISTORY_ITEMS = 10;
export const TASK_DRAFT_ASSIST_MAX_TITLE_LENGTH = 500;
export const TASK_DRAFT_ASSIST_MAX_DESCRIPTION_LENGTH = 20_000;
export const TASK_DRAFT_ASSIST_MAX_NOTES = 8;
const MAX_ID = 2_147_483_647;

/**
 * 对话历史只保留用户与助手的纯文本，不带结构化草稿：
 * 每次请求都由模型重新输出完整草稿，服务端与前端不信任历史里的旧 ID。
 */
export const taskDraftAssistHistoryItemSchema = z
  .object({
    role: z.enum(["USER", "ASSISTANT"]),
    text: z.string().trim().min(1).max(TASK_DRAFT_ASSIST_MAX_MESSAGE_LENGTH),
  })
  .strict()
  .meta({ id: "TaskDraftAssistHistoryItem" });

/** 当前已选归属只用于收窄候选；为空表示让模型从整个项目里判断。 */
export const taskDraftAssistRequestSchema = z
  .object({
    message: z
      .string()
      .trim()
      .max(TASK_DRAFT_ASSIST_MAX_MESSAGE_LENGTH)
      .describe("用户这一次说的一句话，可以是模糊描述；只粘贴截图时可为空"),
    images: z
      .array(aiAssistImageSchema)
      .max(AI_ASSIST_MAX_IMAGES)
      .optional()
      .describe(
        "聊天记录等截图（base64，不含 data: 前缀）；只用于本次识别，不落库",
      ),
    history: z
      .array(taskDraftAssistHistoryItemSchema)
      .max(TASK_DRAFT_ASSIST_MAX_HISTORY_ITEMS)
      .default([])
      .describe("最近的对话，按时间正序；不含本轮"),
    moduleId: z
      .number()
      .int()
      .positive()
      .max(MAX_ID)
      .nullable()
      .optional()
      .describe("左侧当前已选模块，仅用于收窄功能候选"),
    featureId: z
      .number()
      .int()
      .positive()
      .max(MAX_ID)
      .nullable()
      .optional()
      .describe("左侧当前已选功能，仅作为上下文，不保证沿用"),
  })
  .strict()
  .refine(
    (value) => value.message.length > 0 || (value.images?.length ?? 0) > 0,
    {
      message: "至少提供一句话或一张图片",
      path: ["message"],
    },
  )
  .meta({ id: "TaskDraftAssistRequest" });

const taskPrioritySchema = z.enum(["NORMAL", "HIGH", "URGENT"]);
const taskDraftConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);

/**
 * 草稿字段全部可空：识别不出就留空，前端只填非空且未手填的字段。
 * assigneeIds / moduleId / featureId 已由服务端按真实清单匹配，模型不直接产出 ID。
 */
export const taskDraftAssistDraftSchema = z
  .object({
    title: z.string().max(TASK_DRAFT_ASSIST_MAX_TITLE_LENGTH).nullable(),
    description: z
      .string()
      .max(TASK_DRAFT_ASSIST_MAX_DESCRIPTION_LENGTH)
      .nullable(),
    priority: taskPrioritySchema.nullable(),
    dueAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .describe("ISO 8601 带时区；模型只给日期时由服务端补 18:00 +08:00"),
    assigneeIds: z.array(z.number().int().positive().max(MAX_ID)).max(20),
    assigneeNames: z
      .array(z.string().max(100))
      .max(20)
      .describe("已匹配成员的姓名，仅用于对话展示；创建仍使用 assigneeIds"),
    moduleId: z.number().int().positive().max(MAX_ID).nullable(),
    moduleName: z.string().max(200).nullable(),
    featureId: z.number().int().positive().max(MAX_ID).nullable(),
    featureName: z.string().max(500).nullable(),
  })
  .strict()
  .meta({ id: "TaskDraftAssistDraft" });

export const taskDraftAssistResponseSchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(600)
      .describe("给用户的 1-3 句中文回复，说明识别结果与需要确认的点"),
    draft: taskDraftAssistDraftSchema,
    confidence: taskDraftConfidenceSchema.describe(
      "整体置信度；LOW 时服务端已清空归属与负责人，避免猜错",
    ),
    notes: z
      .array(z.string().max(200))
      .max(TASK_DRAFT_ASSIST_MAX_NOTES)
      .describe("需要用户确认的短提示，例如日期推算依据、名字未匹配"),
  })
  .strict()
  .meta({ id: "TaskDraftAssistResponse" });

export type TaskDraftAssistHistoryItem = z.infer<
  typeof taskDraftAssistHistoryItemSchema
>;
export type TaskDraftAssistRequest = z.infer<
  typeof taskDraftAssistRequestSchema
>;
export type TaskDraftAssistDraft = z.infer<typeof taskDraftAssistDraftSchema>;
export type TaskDraftAssistResponse = z.infer<
  typeof taskDraftAssistResponseSchema
>;

export const taskDraftAssistSchemas = {
  TaskDraftAssistHistoryItem: {
    schema: taskDraftAssistHistoryItemSchema,
    summary: "新建任务 AI 助手的一轮对话消息",
    sensitiveFieldPaths: [],
  },
  TaskDraftAssistRequest: {
    schema: taskDraftAssistRequestSchema,
    summary: "新建任务 AI 识别请求：本轮描述、最近对话与当前归属",
    sensitiveFieldPaths: [],
  },
  TaskDraftAssistDraft: {
    schema: taskDraftAssistDraftSchema,
    summary: "新建任务 AI 识别出的草稿字段，全部可空且只用于预填",
    sensitiveFieldPaths: [],
  },
  TaskDraftAssistResponse: {
    schema: taskDraftAssistResponseSchema,
    summary: "新建任务 AI 识别响应：对话回复、草稿、置信度与确认提示",
    sensitiveFieldPaths: [],
  },
} as const;
