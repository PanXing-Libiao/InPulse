import { vi } from "vitest";

/**
 * jsdom 没有 Image 解码和 canvas 编码：用最小替身让 prepareAssistImage
 * 走到真实压缩分支，返回固定的 4 字符 base64。
 */
export function stubClipboardImagePipeline(): () => void {
  const originalImage = globalThis.Image;
  const originalFileReader = globalThis.FileReader;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 800;
    naturalHeight = 600;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    readAsDataURL(_blob: Blob) {
      queueMicrotask(() => {
        this.result = "data:image/png;base64,AAAA";
        this.onload?.();
      });
    }
  }

  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: FakeImage,
  });
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    writable: true,
    value: FakeFileReader,
  });
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(
    () => "data:image/jpeg;base64,AAAA",
  );

  return () => {
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      writable: true,
      value: originalImage,
    });
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      writable: true,
      value: originalFileReader,
    });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  };
}

/** 聊天截图粘贴事件里最小可用的 clipboardData；count 用于一次粘贴多张。 */
export function clipboardWithChatScreenshots(count = 1): DataTransfer {
  const items = Array.from({ length: count }, (_unused, index) => {
    const file = new File(["stub"], "chat-" + index + ".png", {
      type: "image/png",
    });
    return { kind: "file", type: "image/png", getAsFile: () => file };
  });
  return { items, getData: () => "" } as unknown as DataTransfer;
}

export function clipboardWithChatScreenshot(): DataTransfer {
  return clipboardWithChatScreenshots(1);
}
