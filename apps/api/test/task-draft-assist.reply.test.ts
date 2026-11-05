import { describe, expect, test } from "vitest";

import { alignReplyWithModuleCandidates } from "../src/modules/document-import/task-draft-assist.reply.js";

describe("任务草稿助手回复与模块候选对齐", () => {
  test("模型说没有模块清单、系统却匹配到候选时，剔除矛盾句并补确认说明", () => {
    const reply =
      "我识别到账单核对任务，计划本周五前完成。目前还没有提供模块清单，因此模块暂时留空。";
    const aligned = alignReplyWithModuleCandidates(reply, [
      { name: "账单生成" },
    ]);
    expect(aligned).not.toContain("没有提供模块清单");
    expect(aligned).not.toContain("暂时留空");
    expect(aligned).toContain("已按当前项目的模块清单匹配到「账单生成」");
    expect(aligned).toContain("本周五前完成");
  });

  test("整句都在否认模块时，只保留系统补充的确认说明", () => {
    const aligned = alignReplyWithModuleCandidates(
      "没有模块清单，模块暂时留空。",
      [{ name: "账单生成" }],
    );
    expect(aligned).toBe(
      "已按当前项目的模块清单匹配到「账单生成」，请确认是否用它。",
    );
  });

  test("没有候选或回复没有矛盾时不改写", () => {
    expect(alignReplyWithModuleCandidates("模块暂时留空。", [])).toBe(
      "模块暂时留空。",
    );
    expect(
      alignReplyWithModuleCandidates("像是「账单生成」这个模块，对吗？", [
        { name: "账单生成" },
      ]),
    ).toBe("像是「账单生成」这个模块，对吗？");
  });
});
