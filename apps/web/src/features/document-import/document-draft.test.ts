import { describe, expect, it } from "vitest";
import {
  buildDocumentDraftView,
  findDocumentDraftField,
  insertDocumentDraftField,
  lastNodeLineIndex,
  parseDocumentDraft,
  parseDocumentDraftLine,
  serializeDocumentDraft,
  setDocumentDraftValue,
  splitDocumentDraftList,
} from "./document-draft";

const SAMPLE =
  "# 项目：商城系统\n- 项目编码：SHOP\n- 项目成员：林雨, 陈昊\n\n> 说明行会被忽略\n## 模块：支付\n- 说明：支付与退款能力\n### 任务：修复重复回调\n- 负责人：林雨\n- 优先级：高\n\n### 任务：接口联调\n- 负责人：陈昊\n## 模块：订单\n- 说明：（待补）\n```\n围栏里的正文按行解析\n```\n- 孤立字段行";

describe("ADR-071 模板草稿的结构化往返", () => {
  it("识别标题行、字段行、忽略行与未知行", () => {
    expect(parseDocumentDraftLine("# 项目：商城系统")).toMatchObject({
      kind: "TITLE",
      titleKind: "PROJECT",
      headingDepth: 1,
      headingWord: "项目",
      title: "商城系统",
    });
    expect(parseDocumentDraftLine("### 任务：接口联调")).toMatchObject({
      kind: "TITLE",
      titleKind: "MODULE_TASK",
      headingDepth: 3,
    });
    expect(parseDocumentDraftLine("#### 任务：旧功能任务")).toMatchObject({
      kind: "UNKNOWN",
    });
    expect(parseDocumentDraftLine("- 负责人：林雨, 陈昊")).toMatchObject({
      kind: "FIELD",
      fieldName: "负责人",
      fieldValue: "林雨, 陈昊",
    });
    expect(parseDocumentDraftLine("- 项目编码: SHOP")).toMatchObject({
      kind: "FIELD",
      fieldName: "项目编码",
      fieldValue: "SHOP",
    });
    expect(parseDocumentDraftLine("> 说明行会被忽略").kind).toBe("IGNORED");
    expect(parseDocumentDraftLine("```").kind).toBe("IGNORED");
    expect(parseDocumentDraftLine("").kind).toBe("BLANK");
    expect(parseDocumentDraftLine("随便一行").kind).toBe("UNKNOWN");
    expect(parseDocumentDraftLine("### 说明：不是合法层级").kind).toBe(
      "UNKNOWN",
    );
    expect(parseDocumentDraftLine("- 没有冒号").kind).toBe("UNKNOWN");
  });

  it("未编辑时序列化回原文（半角冒号按模板归一化为全角）", () => {
    const lines = parseDocumentDraft(SAMPLE);
    const back = serializeDocumentDraft(lines);
    expect(back).toContain("# 项目：商城系统");
    expect(back).toContain("- 负责人：林雨");
    expect(back).toContain("> 说明行会被忽略");
    expect(back).toContain("围栏里的正文按行解析");
    expect(back).toContain("- 孤立字段行");
    expect(back.endsWith("- 孤立字段行")).toBe(true);
  });

  it("按层级建树：任务直接归模块", () => {
    const view = buildDocumentDraftView(parseDocumentDraft(SAMPLE));
    expect(view.project).toMatchObject({ name: "商城系统" });
    expect(
      view.project === null ? [] : view.project.fields.map((f) => f.name),
    ).toEqual(["项目编码", "项目成员"]);
    expect(view.counts).toEqual({ modules: 2, tasks: 2 });
    const pay = view.modules[0]!;
    expect(pay.name).toBe("支付");
    expect(pay.tasks.map((task) => task.title)).toEqual([
      "修复重复回调",
      "接口联调",
    ]);
    const assignee = findDocumentDraftField(pay.tasks[0]!.fields, "负责人");
    expect(assignee === null ? null : assignee.value).toBe("林雨");
  });

  it("层级错位进入 loose，旧功能层不再被识别为任务", () => {
    const lines = parseDocumentDraft(
      ["### 任务：没有模块", "- 负责人：张三", "#### 任务：旧功能任务"].join(
        String.fromCharCode(10),
      ),
    );
    const view = buildDocumentDraftView(lines);
    expect(view.modules).toHaveLength(0);
    expect(view.looseLineIndexes).toEqual([0, 1]);
  });

  it("编辑一行只改一行，其余行按原文保留", () => {
    const lines = parseDocumentDraft(SAMPLE);
    const target = lines.findIndex(
      (line) => line.kind === "FIELD" && line.fieldName === "负责人",
    );
    const next = setDocumentDraftValue(lines, target, "张三");
    const text = serializeDocumentDraft(next);
    expect(text).toContain("- 负责人：张三");
    expect(text).toContain("- 负责人：陈昊");
    expect(text).toContain("> 说明行会被忽略");
  });

  it("标题行改名同样只改该行", () => {
    const lines = parseDocumentDraft(SAMPLE);
    const target = lines.findIndex(
      (line) => line.kind === "TITLE" && line.titleKind === "MODULE",
    );
    const text = serializeDocumentDraft(
      setDocumentDraftValue(lines, target, "结算"),
    );
    expect(text).toContain("## 模块：结算");
    expect(text).toContain("## 模块：订单");
  });

  it("不可编辑的行按原样返回", () => {
    const lines = parseDocumentDraft(SAMPLE);
    const target = lines.findIndex((line) => line.kind === "IGNORED");
    expect(setDocumentDraftValue(lines, target, "改不动")).toEqual(lines);
  });

  it("列表字段按逗号、顿号拆分并去掉空白", () => {
    expect(splitDocumentDraftList("林雨, 陈昊、张三")).toEqual([
      "林雨",
      "陈昊",
      "张三",
    ]);
    expect(splitDocumentDraftList("  ")).toEqual([]);
  });

  it("插入空字段行只动目标行之后的位置，可再解析回来", () => {
    const lines = parseDocumentDraft(
      "## 模块：订单\n## 模块：支付\n- 说明：退款",
    );
    const moduleLine = 0;
    const next = insertDocumentDraftField(lines, moduleLine, "说明");
    const text = serializeDocumentDraft(next);
    expect(text).toBe("## 模块：订单\n- 说明：\n## 模块：支付\n- 说明：退款");
    const view = buildDocumentDraftView(parseDocumentDraft(text));
    expect(view.modules[0]?.fields[0]?.name).toBe("说明");
    expect(view.modules[0]?.fields[0]?.value).toBe("");
    expect(view.modules[1]?.name).toBe("支付");
  });

  it("插入位置取节点最后一个字段行（避免插到任务后面）", () => {
    const lines = parseDocumentDraft(
      "## 模块：支付\n- 说明：退款\n### 任务：重复回调\n- 负责人：林雨",
    );
    const view = buildDocumentDraftView(lines);
    const module = view.modules[0];
    expect(module).toBeDefined();
    const after = lastNodeLineIndex(
      module?.lineIndex ?? 0,
      module?.fields ?? [],
    );
    const next = insertDocumentDraftField(lines, after, "标签");
    const text = serializeDocumentDraft(next);
    const positions = text.split("\n");
    expect(positions[1]).toBe("- 说明：退款");
    expect(positions[2]).toBe("- 标签：");
    expect(positions[3]).toBe("### 任务：重复回调");
  });
});
