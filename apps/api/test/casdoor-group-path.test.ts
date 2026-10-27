import { describe, expect, test } from "vitest";

import {
  InvalidCasdoorGroupPathError,
  expandCasdoorGroupAncestors,
  normalizeCasdoorGroupPaths,
  selectCasdoorEntityGroups,
} from "../src/organizations/casdoor-group-path.js";

describe("Casdoor groups claim 路径", () => {
  test("保留原始路径并按深度、字典序稳定排序", () => {
    const result = normalizeCasdoorGroupPaths([
      "acme/研发/平台组",
      "acme/总部",
      "acme/研发",
      "acme/总部/测试部",
    ]);

    expect(result.map((group) => group.path)).toEqual([
      "acme/总部",
      "acme/研发",
      "acme/总部/测试部",
      "acme/研发/平台组",
    ]);
    expect(result.at(-1)).toMatchObject({
      owner: "acme",
      name: "平台组",
      parentPath: "acme/研发",
      depth: 3,
    });
  });

  test("同一路径族只保留最深实体群组，独立群组仍保留", () => {
    const groups = selectCasdoorEntityGroups(
      normalizeCasdoorGroupPaths([
        "acme/总部",
        "acme/总部/测试部",
        "acme/研发",
        "acme/研发/平台组",
        "acme/研发组",
        "other/总部",
      ]),
    );

    expect(new Set(groups.map((group) => group.path))).toEqual(
      new Set([
        "other/总部",
        "acme/总部/测试部",
        "acme/研发/平台组",
        "acme/研发组",
      ]),
    );
  });

  test("展开所有祖先且不创建 owner 虚拟组织", () => {
    const groups = normalizeCasdoorGroupPaths([
      "acme/总部/研发/平台组",
      "acme/总部/测试部",
    ]);
    const expanded = expandCasdoorGroupAncestors(groups);

    expect(expanded.map((group) => group.path)).toEqual([
      "acme/总部",
      "acme/总部/测试部",
      "acme/总部/研发",
      "acme/总部/研发/平台组",
    ]);
    expect(expanded.every((group) => group.path !== "acme")).toBe(true);
  });

  test.each([
    [""],
    ["acme"],
    ["/acme/测试部"],
    ["acme/测试部/"],
    ["acme//测试部"],
    ["acme/   "],
    ["acme/测试部", "acme/测试部"],
    [Array.from({ length: 21 }, () => "x").join("/")],
    ["acme/" + "x".repeat(101)],
    ["acme/" + "x".repeat(510)],
  ])("非法路径 %j 被拒绝", (...groups: string[]) => {
    expect(() => normalizeCasdoorGroupPaths(groups)).toThrow(
      InvalidCasdoorGroupPathError,
    );
  });
});
