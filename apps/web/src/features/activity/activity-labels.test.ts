import { describe, expect, it } from "vitest";
import { activityActionLabel } from "./activity-labels";

describe("activity-labels 动作名称映射", () => {
  it("将项目封箱枚举显示为中文", () => {
    expect(activityActionLabel("PROJECT_WRAPPED")).toBe("项目封箱");
  });
});
