import { describe, expect, it } from "vitest";

import {
  organizationDisplayName,
  organizationDisplayPath,
} from "./organization-display";

const CASDOOR_LABEL_CASES = [
  ["Administration Dept", "行政综合部"],
  ["After-sales Dept", "售后部"],
  ["Basic RD", "基础研发"],
  ["Domestic Sales Dept", "国内销售部"],
  ["Finance Dept", "财务部"],
  ["General Manager Office", "总经办"],
  ["Germany Office", "德国公司"],
  ["Hardware Team", "硬件组"],
  ["Hardware Technical Support", "硬件技术支持"],
  ["HR Dept", "人力资源部"],
  ["Legal Dept", "法务部"],
  ["LIBIAOROBOT", "立镖机器人"],
  ["Marketing and Brand Dept", "市场品牌部"],
  ["Mechanical Team", "机械组"],
  ["NEXT Hub", "实习生"],
  ["Overseas Sales Dept", "海外销售部"],
  ["Pre-sales Planning Dept", "售前规划部"],
  ["Pre-sales Planning Dept(Overseas)", "售前规划部（海外）"],
  ["Product Dept", "产品部"],
  ["Production Dept", "生产部"],
  ["Project Dept", "项目部"],
  ["Purchasing Dept", "采购部"],
  ["Quality Dept", "品质部"],
  ["RD Dept", "研发部"],
  ["Singapore Office", "新加坡公司"],
  ["Software Project 1", "软件项目一部"],
  ["Software Project 2", "软件项目二部"],
  ["Software Project Dept", "软件项目部"],
  ["Software Technical Support", "软件技术支持"],
  ["U.S. Office", "美国公司"],
  ["Warehouse Dept", "仓储部"],
] as const;

describe("organization display labels", () => {
  it.each(CASDOOR_LABEL_CASES)(
    "maps Casdoor group %s to %s",
    (name, expected) => {
      expect(organizationDisplayName({ name, source: "CASDOOR" })).toBe(
        expected,
      );
    },
  );

  it("normalizes whitespace and case for known Casdoor groups", () => {
    expect(
      organizationDisplayName({
        name: "  software   technical support  ",
        source: "CASDOOR",
      }),
    ).toBe("软件技术支持");
  });

  it("keeps unknown Chinese groups and LOCAL names unchanged", () => {
    expect(organizationDisplayName({ name: "测试部", source: "CASDOOR" })).toBe(
      "测试部",
    );
    expect(
      organizationDisplayName({ name: "Mechanical Team", source: "LOCAL" }),
    ).toBe("Mechanical Team");
  });

  it("translates every group segment in the display path but keeps the owner", () => {
    expect(
      organizationDisplayPath({
        name: "Basic RD",
        source: "CASDOOR",
        groupPath: "libiaorobot.com/LIBIAOROBOT/RD Dept/Basic RD",
      }),
    ).toBe("libiaorobot.com/立镖机器人/研发部/基础研发");
    expect(
      organizationDisplayPath({
        name: "测试部",
        source: "CASDOOR",
        groupPath: "libiaorobot.com/测试部",
      }),
    ).toBe("libiaorobot.com/测试部");
  });
});
