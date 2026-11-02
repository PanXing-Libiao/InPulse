import { useCallback, useState } from "react";

/**
 * 聊天记录截图粘贴：图片只在浏览器内压缩后随单次 AI 请求转发，不落库。
 * 不再按张数限制；单条消息受 1 MiB JSON 传输上限约束，前端按总预算压缩，
 * 超出时提示先移除部分截图，而不是固定只让附 2 张。
 */
export const ASSIST_IMAGE_TOTAL_BASE64_BUDGET = 760_000;
/** 与服务端 AI_ASSIST_MAX_IMAGES 对齐的保护上限；正常使用远达不到。 */
const ASSIST_IMAGE_MAX_ATTACHMENTS = 20;
const ASSIST_IMAGE_MAX_SINGLE_BASE64_LENGTH = 180_000;
const ASSIST_IMAGE_MIN_BASE64_LENGTH = 24_000;
const ASSIST_IMAGE_ATTEMPTS: readonly (readonly [number, number])[] = [
  [1_400, 0.72],
  [1_200, 0.6],
  [1_000, 0.5],
  [900, 0.45],
  [800, 0.4],
  [700, 0.35],
  [600, 0.3],
];

export interface AssistImageAttachment {
  readonly id: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** 不含 data: 前缀的 base64，直接进请求体。 */
  readonly data: string;
  /** 仅用于界面缩略图预览的 data URL。 */
  readonly previewUrl: string;
}

export const ASSIST_IMAGE_ACCEPT: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** 从剪贴板里取图片文件；没有图片时返回空数组。 */
export function imageFilesFromClipboard(
  clipboard: DataTransfer | null | undefined,
): File[] {
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null && ASSIST_IMAGE_ACCEPT.includes(file.type)) {
      files.push(file);
    }
  }
  return files;
}

const IMAGE_READ_ERROR = "图片读取失败，请换一张截图。";

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string" && result.startsWith("data:image/")) {
        resolve(result);
        return;
      }
      reject(new Error(IMAGE_READ_ERROR));
    };
    reader.onerror = () => reject(new Error(IMAGE_READ_ERROR));
    reader.onabort = () => reject(new Error(IMAGE_READ_ERROR));
    reader.readAsDataURL(file);
  });
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const source = await readImageFile(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(IMAGE_READ_ERROR));
    image.src = source;
  });
}

function scaledBase64(
  image: HTMLImageElement,
  maxEdge: number,
  quality: number,
): string | null {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  const ratio = longest > maxEdge ? maxEdge / longest : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  // 截图通常不透明；先铺白底，避免转成 JPEG 后透明区域发黑。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const url = canvas.toDataURL("image/jpeg", quality);
  const comma = url.indexOf(",");
  return comma === -1 ? null : url.slice(comma + 1);
}

/**
 * 压缩成可上传的附件；maxBase64Length 由调用方按剩余传输预算传入。
 * 单张仍尽量保持清晰，只有附件较多时才逐步降低尺寸与质量。
 */
export async function prepareAssistImage(
  file: File,
  maxBase64Length: number = ASSIST_IMAGE_MAX_SINGLE_BASE64_LENGTH,
): Promise<AssistImageAttachment> {
  if (!ASSIST_IMAGE_ACCEPT.includes(file.type)) {
    throw new Error("只支持 PNG / JPEG / WebP 截图。");
  }
  const image = await loadImage(file);
  for (const [edge, quality] of ASSIST_IMAGE_ATTEMPTS) {
    const data = scaledBase64(image, edge, quality);
    if (data === null) break;
    if (data.length <= maxBase64Length) {
      return {
        id: "img-" + Math.random().toString(36).slice(2, 10),
        mimeType: "image/jpeg",
        data,
        previewUrl: "data:image/jpeg;base64," + data,
      };
    }
  }
  throw new Error("截图太大，请裁剪关键区域后再粘贴。");
}

export function assistImagePayload(
  attachments: readonly AssistImageAttachment[],
): readonly { mimeType: AssistImageAttachment["mimeType"]; data: string }[] {
  return attachments.map((item) => ({
    mimeType: item.mimeType,
    data: item.data,
  }));
}

/** 组件内粘贴图片的共用状态：附件列表、错误与追加/删除。 */
export function useAssistAttachments() {
  const [attachments, setAttachments] = useState<AssistImageAttachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  /**
   * 返回本次新增的附件：null 表示剪贴板里没有图片；空数组表示是图片但被
   * 总量限制或解析失败挡下（错误已写进 imageError）。调用方可直接用返回值
   * 发送本轮请求。
   */
  const addFromClipboard = useCallback(
    async (
      clipboard: DataTransfer | null | undefined,
    ): Promise<readonly AssistImageAttachment[] | null> => {
      const files = imageFilesFromClipboard(clipboard);
      if (files.length === 0) return null;
      setImageError(null);
      const used = attachments.reduce(
        (total, item) => total + item.data.length,
        0,
      );
      let remaining = ASSIST_IMAGE_TOTAL_BASE64_BUDGET - used;
      if (remaining < ASSIST_IMAGE_MIN_BASE64_LENGTH) {
        setImageError("本轮截图总量已满，请先移除几张再粘贴。");
        return [];
      }
      const prepared: AssistImageAttachment[] = [];
      for (const file of files) {
        if (
          attachments.length + prepared.length >=
          ASSIST_IMAGE_MAX_ATTACHMENTS
        ) {
          setImageError(
            "其余截图未加入：单次最多 " +
              ASSIST_IMAGE_MAX_ATTACHMENTS +
              " 张。",
          );
          break;
        }
        if (remaining < ASSIST_IMAGE_MIN_BASE64_LENGTH) {
          setImageError("其余截图未加入：本轮截图总量已满。");
          break;
        }
        try {
          const item = await prepareAssistImage(
            file,
            Math.min(ASSIST_IMAGE_MAX_SINGLE_BASE64_LENGTH, remaining),
          );
          prepared.push(item);
          remaining -= item.data.length;
        } catch (error) {
          setImageError(
            error instanceof Error ? error.message : "图片处理失败，请重试。",
          );
          break;
        }
      }
      if (prepared.length > 0) {
        setAttachments((current) => [...current, ...prepared]);
      }
      return prepared;
    },
    [attachments],
  );

  const remove = useCallback((id: string) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setImageError(null);
  }, []);

  return { attachments, imageError, addFromClipboard, remove, clear } as const;
}
