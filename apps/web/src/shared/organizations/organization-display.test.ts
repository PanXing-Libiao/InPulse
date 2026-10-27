import { describe, expect, it } from "vitest";

import {
  organizationDisplayName,
  organizationDisplayPath,
} from "./organization-display";

describe("organization display labels", () => {
  it("maps known Casdoor groups to Chinese labels without changing identity data", () => {
    expect(
      organizationDisplayName({ name: "Mechanical Team", source: "CASDOOR" }),
    ).toBe("机械团队");
    expect(
      organizationDisplayName({ name: "Basic RD", source: "CASDOOR" }),
    ).toBe("基础研发");
    expect(
      organizationDisplayName({
        name: "Overseas Sales Dept",
        source: "CASDOOR",
      }),
    ).toBe("海外销售部");
    expect(
      organizationDisplayName({
        name: "  Software Technical Support  ",
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

  it("translates group segments in the display path but keeps the owner", () => {
    expect(
      organizationDisplayPath({
        name: "Mechanical Team",
        source: "CASDOOR",
        groupPath: "libiaorobot.com/总部/Mechanical Team",
      }),
    ).toBe("libiaorobot.com/总部/机械团队");
    expect(
      organizationDisplayPath({
        name: "测试部",
        source: "CASDOOR",
        groupPath: "libiaorobot.com/测试部",
      }),
    ).toBe("libiaorobot.com/测试部");
  });
});
