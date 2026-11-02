import { z } from "zod";

/**
 * 聊天记录等截图附件：只随单次 AI 请求转发，不落库、不进日志正文。
 * 不按张数限制用户，20 只是防滥用的保护上限；真正的传输约束是 1 MiB JSON，
 * 前端会按总预算逐张压缩，超出时提示移除部分截图。
 */
export const AI_ASSIST_MAX_IMAGES = 20;
export const AI_ASSIST_MAX_IMAGE_BASE64_LENGTH = 200_000;
/** 带图时文本上限调低，保证 text + images 仍落在 API 的 1 MiB JSON 传输上限内。 */
export const AI_ASSIST_IMAGE_TEXT_LIMIT = 120_000;

export const aiAssistImageSchema = z
  .object({
    mimeType: z
      .enum(["image/png", "image/jpeg", "image/webp"])
      .describe("图片 MIME 类型，只接受浏览器截图常见的三种"),
    data: z
      .string()
      .min(1)
      .max(AI_ASSIST_MAX_IMAGE_BASE64_LENGTH)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "图片必须是标准 base64")
      .describe("图片文件的 base64（不含 data: 前缀）"),
  })
  .strict()
  .meta({ id: "AiAssistImage" });

export type AiAssistImage = z.infer<typeof aiAssistImageSchema>;

export const aiAssistImageSchemas = {
  AiAssistImage: {
    schema: aiAssistImageSchema,
    summary: "AI 助手图片附件：base64 编码的聊天记录截图",
    sensitiveFieldPaths: [],
  },
} as const;
