import { describe, expect, test } from "vitest";

import {
  SYSTEM_PROMPT,
  buildTaskDraftAssistMessages,
} from "../src/modules/document-import/task-draft-assist.prompt.js";

describe("任务草稿助手提示词", () => {
  test("锁定专业写作与已选上下文规则", () => {
    expect(SYSTEM_PROMPT).toContain("专业标准");
    expect(SYSTEM_PROMPT).toContain("动作 + 对象 + 结果或范围");
    expect(SYSTEM_PROMPT).toContain("视为项目已确认");
    expect(SYSTEM_PROMPT).toContain("不要重复建议当前模块");
  });

  test("锁定简称拆词、漏字与多候选确认规则", () => {
    expect(SYSTEM_PROMPT).toContain("拆词、漏字");
    expect(SYSTEM_PROMPT).toContain("服装管理");
    expect(SYSTEM_PROMPT).toContain("账号登录");
    expect(SYSTEM_PROMPT).toContain("交给确认卡");
    expect(SYSTEM_PROMPT).toContain("不要自造组合名");
  });

  test("带项目上下文时提供成员与模块，不再给项目候选", () => {
    const messages = buildTaskDraftAssistMessages({
      message: "下周五前把离线补传做完，找小邵",
      history: [],
      today: "2026-11-02",
      weekday: "星期一",
      members: [{ name: "小邵" }],
      modules: [{ name: "离线与同步" }],
      projects: [],
      currentModuleName: "离线与同步",
      hasProjectContext: true,
    });
    const user = messages[1]?.content;
    expect(typeof user).toBe("string");
    expect(String(user)).toContain("项目成员");
    expect(String(user)).toContain("小邵");
    expect(String(user)).not.toContain("可选项目（只能从这份名单里选）");
  });
});
