import { describe, expect, test } from "vitest";

import {
  externalLinkActivityApplies,
  externalLinkActivitySummary,
} from "../src/modules/external-links/external-link-activity.js";

const task = { code: "LIINK-T-90", title: "登录企业微信" };

describe("externalLinkActivitySummary", () => {
  test("添加关联时写明链接标签与目标任务", () => {
    expect(
      externalLinkActivitySummary({
        adding: true,
        url: "https://github.com/inpulse/core/pull/245",
        targetType: "TASK",
        target: task,
      }),
    ).toBe("添加 GitHub 关联：PR #245（任务 LIINK-T-90「登录企业微信」）");
  });

  test("解除关联沿用同一格式，commit 链接显示短 SHA", () => {
    expect(
      externalLinkActivitySummary({
        adding: false,
        url: "https://github.com/inpulse/core/commit/408ade2023dbdcaae8fe7bfed7bdf2d759d71695",
        targetType: "TASK",
        target: task,
      }),
    ).toBe(
      "解除 GitHub 关联：Commit 408ade2023db（任务 LIINK-T-90「登录企业微信」）",
    );
  });

  test("项目与正式迭代记录使用各自的中文标签与编号", () => {
    expect(
      externalLinkActivitySummary({
        adding: true,
        url: "https://github.com/inpulse/core/issues/11",
        targetType: "PROJECT",
        target: { code: "LIINK", title: "LIINK市场管理系统-项目部门" },
      }),
    ).toBe(
      "添加 GitHub 关联：Issue #11（项目 LIINK「LIINK市场管理系统-项目部门」）",
    );
    expect(
      externalLinkActivitySummary({
        adding: true,
        url: "https://github.com/inpulse/core",
        targetType: "CHANGE_RECORD",
        target: { code: "LIINK-CR-12", title: "发布验证" },
      }),
    ).toBe(
      "添加 GitHub 关联：inpulse/core（迭代记录 LIINK-CR-12「发布验证」）",
    );
  });

  test("草稿记录没有编号时只写对象标签", () => {
    expect(
      externalLinkActivitySummary({
        adding: true,
        url: "https://github.com/inpulse/core/issues/11",
        targetType: "CHANGE_RECORD",
        target: { code: null, title: "发布验证" },
      }),
    ).toBe("添加 GitHub 关联：Issue #11（迭代记录「发布验证」）");
  });

  test("超长标题按动态摘要上限截断", () => {
    const summary = externalLinkActivitySummary({
      adding: true,
      url: "https://github.com/inpulse/core/pull/245",
      targetType: "TASK",
      target: { code: "LIINK-T-90", title: "长".repeat(1200) },
    });
    expect(summary).toHaveLength(1000);
    expect(summary.endsWith("…」）")).toBe(true);
  });
});

describe("externalLinkActivityApplies", () => {
  test("草稿记录的链接事件不写项目动态，其它目标与已发布记录照常", () => {
    expect(externalLinkActivityApplies("CHANGE_RECORD", "DRAFT")).toBe(false);
    expect(externalLinkActivityApplies("CHANGE_RECORD", "PUBLISHED")).toBe(
      true,
    );
    expect(externalLinkActivityApplies("TASK", "ACTIVE")).toBe(true);
    expect(externalLinkActivityApplies("PROJECT", "ACTIVE")).toBe(true);
  });
});
