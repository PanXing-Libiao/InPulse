import { describe, expect, it } from "vitest";
import type { UserDirectoryItem } from "@generated/api";
import { buildDocumentDraftView, parseDocumentDraft } from "./document-draft";
import {
  buildDocumentAssigneeQuestion,
  buildDocumentAssigneeSupplement,
  checkDocumentMemberCoverage,
  collectDocumentAssigneeNames,
  isDocumentMemberFieldName,
  matchDocumentAssignees,
  memberTagsFromValue,
  serializeMemberTags,
  suggestDirectoryMembers,
  type DocumentMemberCoverageContext,
} from "./document-assignee-match";

function directory(
  ...items: readonly { id: number; name: string }[]
): readonly UserDirectoryItem[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    avatarUrl: null,
    isAdmin: false,
    organizations: [],
  }));
}

function namesOf(document: string) {
  return collectDocumentAssigneeNames(
    buildDocumentDraftView(parseDocumentDraft(document)),
  );
}

const DOCUMENT = [
  "# 项目：商城结算系统",
  "- 项目编码：MALL",
  "- 项目成员：林雨、陈昊",
  "## 模块：购物车",
  "### 任务：数量调整交互",
  "- 负责人：林雨",
  "### 任务：数量调整接口联调",
  "- 负责人：林语",
  "## 模块：订单",
  "### 任务：订单查询筛选",
  "- 负责人：张三",
].join("\n");

describe("ADR-071 草稿成员名字与账号的确定性匹配", () => {
  it("按姓名精确且唯一命中，不做模糊接管", () => {
    const result = matchDocumentAssignees(
      namesOf(DOCUMENT),
      directory({ id: 1, name: "林雨" }, { id: 2, name: "陈昊" }),
    );
    expect([...result.matched.keys()]).toEqual(["林雨", "陈昊"]);
    expect(result.matched.get("林雨")?.id).toBe(1);
    expect(result.unmatched.map((item) => item.name)).toEqual(["林语", "张三"]);
  });

  it("同名多人时算未匹配并给出全部同名候选", () => {
    const result = matchDocumentAssignees(
      namesOf(DOCUMENT),
      directory(
        { id: 1, name: "林雨" },
        { id: 7, name: "陈昊" },
        { id: 8, name: "陈昊" },
      ),
    );
    const duplicate = result.unmatched.find((item) => item.name === "陈昊");
    expect(duplicate?.kind).toBe("SIMILAR");
    expect(duplicate?.candidates.map((item) => item.id)).toEqual([7, 8]);
  });

  it("相近姓名只作候选提示，不自动接管", () => {
    const result = matchDocumentAssignees(
      namesOf(DOCUMENT),
      directory({ id: 5, name: "林雨" }),
    );
    const similar = result.unmatched.find((item) => item.name === "林语");
    expect(similar?.kind).toBe("SIMILAR");
    expect(similar?.candidates.map((item) => item.name)).toEqual(["林雨"]);
    expect(similar?.firstUse?.label).toBe("数量调整接口联调");
  });

  it("没有相近成员时标记为 UNKNOWN 且不给候选", () => {
    const result = matchDocumentAssignees(
      namesOf(DOCUMENT),
      directory({ id: 5, name: "林雨" }),
    );
    const unknown = result.unmatched.find((item) => item.name === "张三");
    expect(unknown?.kind).toBe("UNKNOWN");
    expect(unknown?.candidates).toEqual([]);
  });

  it("忽略空白与大小写差异", () => {
    const result = matchDocumentAssignees(
      [
        {
          name: "ZHANG SAN",
          lineIndex: 1,
          label: "任务",
          source: "TASK_ASSIGNEE",
        },
      ],
      directory({ id: 3, name: "zhangsan" }),
    );
    expect(result.matched.get("ZHANG SAN")?.id).toBe(3);
  });

  it("收集名字时含项目成员，同名只追问一次", () => {
    const uses = namesOf(DOCUMENT);
    expect(uses.map((use) => use.name)).toEqual([
      "林雨",
      "陈昊",
      "林语",
      "张三",
    ]);
    expect(uses[0]?.source).toBe("PROJECT_MEMBER");
    expect(uses[0]?.label).toBe("项目成员");
  });

  it("追问文案区分「有相近的人」与「找不到相近的人」", () => {
    const result = matchDocumentAssignees(
      namesOf(DOCUMENT),
      directory({ id: 5, name: "林雨" }),
    );
    const question = buildDocumentAssigneeQuestion(result.unmatched);
    expect(question).toContain("还有 3 个名字对不上成员账号");
    expect(question).toContain(
      "「林语」（数量调整接口联调）最接近的是「林雨」",
    );
    expect(question).toContain(
      "「张三」（订单查询筛选）在成员里找不到相近的人",
    );
    expect(buildDocumentAssigneeQuestion([])).toBeNull();
  });

  it("候选按钮写出的补充说明保持「旧名改成新名」", () => {
    expect(buildDocumentAssigneeSupplement("林语", "林雨")).toBe(
      "「林语」改成「林雨」",
    );
  });
});

describe("ADR-072 项目成员名单校验（ADR-073 起创建者默认算成员）", () => {
  const creator: DocumentMemberCoverageContext["creator"] = {
    id: 9,
    name: "特哥",
    loginName: "tege",
  };

  function coverage(
    document: string,
    context?: Partial<DocumentMemberCoverageContext>,
  ) {
    return checkDocumentMemberCoverage(
      buildDocumentDraftView(parseDocumentDraft(document)),
      "NEW_PROJECT",
      {
        creator,
        directory: directory({ id: 1, name: "林雨" }, { id: 2, name: "陈昊" }),
        ...context,
      },
    );
  }

  it("没写项目成员时只报「缺项目成员」，不叠加负责人一条", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 项目编码：MALL",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：林雨",
      ].join("\n"),
    );
    expect(result).toEqual({
      memberRequired: true,
      missingAssignees: [],
    });
  });

  it("旧模板写「- 初始成员：」时按同一字段识别，不再报缺项目成员", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 初始成员：林雨",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：林雨",
      ].join("\n"),
    );
    expect(result).toEqual({ memberRequired: false, missingAssignees: [] });
  });

  it("缺任务负责人照旧报出，同一人按首次出现去重", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 项目成员：林雨",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：陈昊",
        "### 任务：数量调整接口联调",
        "- 负责人：陈昊",
      ].join("\n"),
    );
    expect(result.memberRequired).toBe(false);
    expect(result.missingAssignees).toEqual(["陈昊"]);
  });

  it("名单里没写创建者本人也不算缺口（ADR-073：创建者默认就在项目成员里）", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 项目成员：林雨, 陈昊",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：陈昊",
      ].join("\n"),
    );
    expect(result).toEqual({ memberRequired: false, missingAssignees: [] });
  });

  it("负责人指派给创建者本人时不算缺口（姓名与登录名都认）", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 项目成员：林雨",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：特哥, tege, 林雨",
      ].join("\n"),
    );
    expect(result.missingAssignees).toEqual([]);
  });

  it("名单里有本地读不懂的登录名时不做负责人判断，避免误报", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 项目成员：特哥, xiaowu",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：林雨",
      ].join("\n"),
    );
    expect(result.missingAssignees).toEqual([]);
  });

  it("同名多人导致本地判不了时同样不误报", () => {
    const result = coverage(
      [
        "# 项目：商城结算系统",
        "- 项目成员：林雨",
        "## 模块：购物车",
        "### 任务：数量调整交互",
        "- 负责人：陈昊",
      ].join("\n"),
      {
        directory: directory(
          { id: 1, name: "林雨" },
          { id: 4, name: "陈昊" },
          { id: 7, name: "陈昊" },
        ),
      },
    );
    expect(result.missingAssignees).toEqual([]);
  });

  it("项目内导入与没有登录信息时都不做这两项校验", () => {
    const view = buildDocumentDraftView(parseDocumentDraft("## 模块：购物车"));
    expect(
      checkDocumentMemberCoverage(view, "PROJECT", { creator, directory: [] }),
    ).toEqual({
      memberRequired: false,
      missingAssignees: [],
    });
    expect(
      checkDocumentMemberCoverage(
        buildDocumentDraftView(
          parseDocumentDraft("# 项目：商城系统\n- 项目成员：林雨"),
        ),
        "NEW_PROJECT",
        { creator: null, directory: [] },
      ),
    ).toEqual({
      memberRequired: false,
      missingAssignees: [],
    });
  });
});

describe("成员字段的账号搜索建议（2026-10-14）", () => {
  const pool = directory(
    { id: 1, name: "林雨" },
    { id: 2, name: "陈昊" },
    { id: 3, name: "小潘" },
    { id: 4, name: "王小二" },
    { id: 5, name: "小吴" },
  );

  it("只认成员字段：负责人 / 项目成员 / 成员；旧模板的「初始成员」仍认", () => {
    expect(isDocumentMemberFieldName("负责人")).toBe(true);
    expect(isDocumentMemberFieldName("项目成员")).toBe(true);
    expect(isDocumentMemberFieldName("初始成员")).toBe(true);
    expect(isDocumentMemberFieldName("成员")).toBe(true);
    expect(isDocumentMemberFieldName("项目编码")).toBe(false);
    expect(isDocumentMemberFieldName("项目说明")).toBe(false);
    expect(isDocumentMemberFieldName("优先级")).toBe(false);
  });

  it("按姓名子串筛选，前缀命中排在前面（打「小」先给「小潘」再看「王小二」）", () => {
    expect(
      suggestDirectoryMembers(pool, "小", []).map((item) => item.name),
    ).toEqual(["小潘", "小吴", "王小二"]);
    expect(
      suggestDirectoryMembers(pool, "雨", []).map((item) => item.name),
    ).toEqual(["林雨"]);
    expect(suggestDirectoryMembers(pool, "没人", [])).toEqual([]);
  });

  it("输入框还没打字时给整份目录（候选列表常驻，点掉一条接着挑下一条）", () => {
    expect(
      suggestDirectoryMembers(pool, "", []).map((item) => item.name),
    ).toEqual(["林雨", "陈昊", "小潘", "王小二", "小吴"]);
    // 只有空白也算没打字。
    expect(
      suggestDirectoryMembers(pool, "  ", []).map((item) => item.name),
    ).toHaveLength(5);
  });

  it("已经做成标签的名字不再建议（同一个人不会写两遍）", () => {
    expect(suggestDirectoryMembers(pool, "林", ["林雨"])).toEqual([]);
    expect(
      suggestDirectoryMembers(pool, "小", ["小潘"]).map((item) => item.name),
    ).toEqual(["小吴", "王小二"]);
    expect(
      suggestDirectoryMembers(pool, "", ["林雨", "陈昊"]).map(
        (item) => item.name,
      ),
    ).toEqual(["小潘", "王小二", "小吴"]);
  });

  it("打全一个名字照常给候选：点一下就成一个标签", () => {
    expect(
      suggestDirectoryMembers(pool, "陈昊", []).map((item) => item.name),
    ).toEqual(["陈昊"]);
  });

  it("建议最多 8 条", () => {
    const big = directory(
      ...Array.from({ length: 12 }, (_item, index) => ({
        id: index + 1,
        name: "成员" + String(index + 1),
      })),
    );
    expect(suggestDirectoryMembers(big, "成员", [])).toHaveLength(8);
    expect(suggestDirectoryMembers(big, "成员", [])[0]?.name).toBe("成员1");
  });
});

describe("成员字段的标签化编辑（2026-10-14）", () => {
  it("名单值拆成标签：半角逗号 / 全角逗号 / 顿号都算分隔，去掉空白段", () => {
    expect(memberTagsFromValue("林雨、陈昊")).toEqual(["林雨", "陈昊"]);
    expect(memberTagsFromValue("林雨, 陈昊，小潘")).toEqual([
      "林雨",
      "陈昊",
      "小潘",
    ]);
    expect(memberTagsFromValue("")).toEqual([]);
    expect(memberTagsFromValue("  ")).toEqual([]);
  });

  it("标签 + 正在输入的那一段拼回名单值：用顿号连接", () => {
    expect(serializeMemberTags([], "陈昊")).toBe("陈昊");
    expect(serializeMemberTags(["林雨"], "陈昊")).toBe("林雨、陈昊");
    expect(serializeMemberTags(["林雨"], "")).toBe("林雨");
    expect(serializeMemberTags(["林雨"], "   ")).toBe("林雨");
    expect(serializeMemberTags([], "")).toBe("");
  });

  it("同一个名字只写一遍：重复标签与「既点了候选又手打一遍」都去掉", () => {
    expect(serializeMemberTags(["林雨", "林雨"], "陈昊")).toBe("林雨、陈昊");
    expect(serializeMemberTags(["林雨"], "林雨")).toBe("林雨");
  });
});
