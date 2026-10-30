import { describe, expect, it } from "vitest";
import type { RecordSummaryResponse } from "@generated/api";
import {
  buildSummaryDetailMarkdown,
  buildSummaryDocument,
  summaryDocumentToText,
} from "./record-summary-document";

// F-33 正文派生：服务端只给事实，正文措辞与编号在这里推导，因此逐条锁住口径——
// 小节编号从「一」起且整体概览不占号、记录按模块归属、缺口与遗留问题
// 的文案不引入服务端没有的数据。

function response(
  overrides: Partial<RecordSummaryResponse> = {},
): RecordSummaryResponse {
  const base: RecordSummaryResponse = {
    generatedAt: "2026-09-29T02:00:00.000Z",
    range: { from: "2026-01-01", to: "2026-12-31" },
    groupBy: "PROJECT",
    scope: {
      projectIds: [7, 8],
      projectNames: ["商城系统", "会员中心"],
      member: null,
    },
    totals: {
      projectCount: 2,
      moduleCount: 3,
      recordCount: 5,
      completedTaskCount: 6,
      missingRecordTaskCount: 1,
      leftoverCount: 2,
      closedLeftoverCount: 1,
    },
    sections: [
      {
        key: "7",
        projectId: 7,
        member: null,
        recordCount: 4,
        completedTaskCount: 5,
      },
      {
        key: "8",
        projectId: 8,
        member: null,
        recordCount: 1,
        completedTaskCount: 1,
      },
    ],
    points: [
      {
        recordId: 100,
        recordCode: "SHOP-CR-100",
        projectId: 7,
        projectName: "商城系统",
        moduleId: 3,
        moduleName: "订单模块",
        title: "下单链路拆分",
        detail: "下单耗时从 900ms 降到 240ms",
        author: { userId: 5, name: "王浩", avatarUrl: null },
        publishedAt: "2026-09-20T02:00:00.000Z",
        taskId: 20,
        taskCode: "SHOP-T-20",
      },
      {
        recordId: 101,
        recordCode: "SHOP-CR-101",
        projectId: 8,
        projectName: "会员中心",
        moduleId: 9,
        moduleName: "积分模块",
        title: "积分对账口径对齐",
        detail: "对账差异归零",
        author: { userId: 6, name: "刘一诺", avatarUrl: null },
        publishedAt: "2026-09-22T02:00:00.000Z",
        taskId: null,
        taskCode: null,
      },
    ],
    leftovers: [
      {
        leftoverItemId: 900,
        recordId: 100,
        recordCode: "SHOP-CR-100",
        recordTitle: "下单链路拆分",
        projectId: 7,
        projectName: "商城系统",
        author: { userId: 5, name: "王浩", avatarUrl: null },
        content: "退款链路还没覆盖",
        status: "ACTIVE",
        followupTaskId: null,
        followupTaskCode: null,
        publishedAt: "2026-09-20T02:00:00.000Z",
      },
      {
        leftoverItemId: 901,
        recordId: 101,
        recordCode: "SHOP-CR-101",
        recordTitle: "积分对账口径对齐",
        projectId: 8,
        projectName: "会员中心",
        author: { userId: 6, name: "刘一诺", avatarUrl: null },
        content: "历史脏数据待清理",
        status: "RESOLVED",
        followupTaskId: null,
        followupTaskCode: null,
        publishedAt: "2026-09-22T02:00:00.000Z",
      },
    ],
    gaps: [
      {
        taskId: 30,
        taskCode: "SHOP-T-30",
        projectId: 7,
        projectName: "商城系统",
        moduleId: 3,
        moduleName: "订单模块",
        title: "退款回调补偿",
        completedAt: "2026-09-12T02:00:00.000Z",
        assignee: { userId: 5, name: "王浩", avatarUrl: null },
      },
    ],
    truncated: false,
  };
  return { ...base, ...overrides };
}

describe("buildSummaryDocument", () => {
  it("整年范围用年度总结抬头，范围行合并项目与成员", () => {
    const document = buildSummaryDocument(response());
    expect(document.title).toBe("2026 年度总结");
    expect(document.scopeLine).toBe(
      "商城系统 · 会员中心 ／ 2026-01-01 - 2026-12-31 ／ 全体成员",
    );
  });

  it("非整年范围改用起止日期抬头", () => {
    const document = buildSummaryDocument(
      response({ range: { from: "2026-07-01", to: "2026-09-30" } }),
    );
    expect(document.title).toBe("2026-07-01 至 2026-09-30 迭代总结");
  });

  it("概览不占号，分节编号从「一」开始且要点只收本项目的记录", () => {
    const document = buildSummaryDocument(response());
    const headings = document.blocks.map((block) =>
      block.kind === "overview" ? block.kind : block.heading,
    );
    expect(headings).toEqual([
      "overview",
      "一、商城系统 · 4 条记录 / 5 个已完成任务",
      "二、会员中心 · 1 条记录 / 1 个已完成任务",
      "三、遗留问题与风险",
      "四、还需要补什么",
    ]);
    const firstSection = document.blocks[1];
    expect(firstSection?.kind === "section" && firstSection.bullets).toEqual([
      { label: "下单链路拆分", text: "下单耗时从 900ms 降到 240ms" },
    ]);
  });

  it("遗留问题只列未处理项，已处理计入小结但不进清单", () => {
    const document = buildSummaryDocument(response());
    const issues = document.blocks.find((block) => block.kind === "issues");
    expect(issues?.kind === "issues" && issues.lead).toBe(
      "范围内共 2 条遗留问题，已处理或已作废 1 条，仍有 1 条未处理。",
    );
    expect(issues?.kind === "issues" && issues.items).toEqual([
      "退款链路还没覆盖 —— 来自 下单链路拆分（商城系统）",
    ]);
  });

  it("父记录作废派生的已作废项计入收尾数量且不进入未处理清单", () => {
    const base = response();
    const document = buildSummaryDocument({
      ...base,
      totals: {
        ...base.totals,
        leftoverCount: 3,
        closedLeftoverCount: 2,
      },
      leftovers: [
        ...base.leftovers,
        {
          ...base.leftovers[1]!,
          leftoverItemId: 902,
          content: "来源记录已作废",
          status: "VOIDED",
        },
      ],
    });
    const issues = document.blocks.find((block) => block.kind === "issues");
    expect(issues?.kind === "issues" && issues.lead).toBe(
      "范围内共 3 条遗留问题，已处理或已作废 2 条，仍有 1 条未处理。",
    );
    expect(issues?.kind === "issues" && issues.items).toEqual([
      "退款链路还没覆盖 —— 来自 下单链路拆分（商城系统）",
    ]);
  });

  it("缺口条目带上负责人与完成月日，并且截断时明确提示", () => {
    const document = buildSummaryDocument(
      response({ truncated: true, gaps: [] }),
    );
    const overview = document.blocks[0];
    expect(overview?.kind === "overview" && overview.text).toContain(
      "本次取数超过单次上限",
    );
    const withGaps = buildSummaryDocument(response());
    const gaps = withGaps.blocks.find((block) => block.kind === "gaps");
    expect(gaps?.kind === "gaps" && gaps.items).toEqual([
      "退款回调补偿（王浩 · 9/12）",
    ]);
  });

  it("按成员归纳时用成员名做小节标题，并给出成员口径脚注", () => {
    const document = buildSummaryDocument(
      response({
        groupBy: "MEMBER",
        sections: [
          {
            key: "5",
            projectId: null,
            member: { userId: 5, name: "王浩", avatarUrl: null },
            recordCount: 1,
            completedTaskCount: 1,
          },
        ],
      }),
    );
    expect(document.blocks[1]).toMatchObject({
      heading: "一、王浩 · 1 条记录 / 1 个已完成任务",
    });
    expect(document.note).toContain("按成员归纳");
  });

  it("复制的纯文本保留标题、小节与加粗要点", () => {
    const text = summaryDocumentToText(buildSummaryDocument(response()));
    expect(text).toContain("2026 年度总结");
    expect(text).toContain("## 一、商城系统 · 4 条记录 / 5 个已完成任务");
    expect(text).toContain("- **下单链路拆分**：下单耗时从 900ms 降到 240ms");
    expect(text).toContain("## 三、遗留问题与风险");
  });
});

describe("buildSummaryDetailMarkdown", () => {
  it("明细 Markdown 与明细表同列，逐条列出记录而不是复述正文", () => {
    const text = buildSummaryDetailMarkdown(response());
    expect(text).toContain("2026 年度总结 · 明细");
    expect(text).toContain(
      "商城系统 · 会员中心 ／ 2026-01-01 - 2026-12-31 ／ 全体成员",
    );
    expect(text).toContain("共 5 条迭代记录。");
    expect(text).toContain(
      "| 编号 | 项目 / 模块 | 标题与效果 | 作者 | 发布日期 |",
    );
    expect(text).toContain(
      "| SHOP-CR-100 | 商城系统 / 订单模块 | **下单链路拆分**：下单耗时从 900ms 降到 240ms | 王浩 | 2026-09-20 |",
    );
    expect(text).toContain(
      "| SHOP-CR-101 | 会员中心 / 积分模块 | **积分对账口径对齐**：对账差异归零 | 刘一诺 | 2026-09-22 |",
    );
    // 与「复制正文」刻意不同：不含小节标题与整体概览段落。
    expect(text).not.toContain("## 整体概览");
    expect(text).not.toContain("一、商城系统");
  });

  it("明细 Markdown 转义竖线与换行，表格不会被单元内容截断", () => {
    const base = response();
    const first = base.points[0]!;
    const text = buildSummaryDetailMarkdown({
      ...base,
      points: [{ ...first, title: "含|竖线", detail: "第一行\n第二行" }],
    });
    expect(text).toContain(
      "| SHOP-CR-100 | 商城系统 / 订单模块 | **含\\|竖线**：第一行 第二行 | 王浩 | 2026-09-20 |",
    );
    expect(
      text.split("\n").filter((line) => line.includes("含\\|竖线")),
    ).toHaveLength(1);
  });

  it("明细为空或截断时给出明确说明", () => {
    const base = response();
    const empty = buildSummaryDetailMarkdown({ ...base, points: [] });
    expect(empty).toContain(
      "| — | — | 本范围内没有已发布的迭代记录。 | — | — |",
    );
    const truncated = buildSummaryDetailMarkdown({ ...base, truncated: true });
    expect(truncated).toContain("本次取数超过单次上限");
  });
});
