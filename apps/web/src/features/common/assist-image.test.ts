import { describe, expect, it } from "vitest";

import { imageFilesFromClipboard } from "./assist-image";

function file(name: string, type: string): File {
  return new File(["stub"], name, { type });
}

describe("imageFilesFromClipboard", () => {
  it("只取图片文件，忽略文本与其它类型", () => {
    const clipboard = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => file("chat.png", "image/png"),
        },
        {
          kind: "file",
          type: "application/pdf",
          getAsFile: () => file("doc.pdf", "application/pdf"),
        },
      ],
    } as unknown as DataTransfer;
    expect(imageFilesFromClipboard(clipboard).map((item) => item.name)).toEqual(
      ["chat.png"],
    );
  });

  it("没有剪贴板数据时返回空数组", () => {
    expect(imageFilesFromClipboard(undefined)).toEqual([]);
  });
});
