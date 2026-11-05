import { describe, expect, test } from "vitest";

import { buildSystemPrompt } from "../src/modules/document-import/ai-assist.prompt.js";
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

  test("文档导入提示词带上今天日期与内联字段规则", () => {
    const prompt = buildSystemPrompt("IN_PROJECT", undefined, undefined, {
      date: "2026-11-05",
      weekday: "星期四",
    });
    expect(prompt).toContain("今天是 2026-11-05（星期四）");
    expect(prompt).toContain("材料写「10月31日」就写 2026-10-31");
    expect(prompt).toContain("「负责人：X」「截止：X」「优先级：X」");
    expect(prompt).toContain("「X 前完成」");
  });

  test("带项目上下文时写明已选项目与模块，不再给项目候选", () => {
    const messages = buildTaskDraftAssistMessages({
      message: "下周五前把离线补传做完，找小邵",
      history: [],
      today: "2026-11-02",
      weekday: "星期一",
      members: [{ name: "小邵" }],
      modules: [{ name: "离线与同步" }],
      projects: [],
      currentProjectName: "移动端现场作业 App",
      currentModuleName: "离线与同步",
      hasProjectContext: true,
    });
    const user = messages[1]?.content;
    expect(typeof user).toBe("string");
    expect(String(user)).toContain("项目成员");
    expect(String(user)).toContain("小邵");
    expect(String(user)).toContain("【左侧当前已选】项目：移动端现场作业 App");
    expect(String(user)).toContain("；模块：离线与同步");
    expect(String(user)).not.toContain("可选项目（只能从这份名单里选）");
  });
});
