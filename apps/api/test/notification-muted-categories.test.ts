import { describe, expect, test } from "vitest";

import {
  InvalidMutedProjectCategoriesError,
  notificationMuteRules,
} from "../src/modules/notifications/notification-muted-categories.js";

describe("notificationMuteRules", () => {
  test("把 projectId:category 展开为项目级站内通知类型规则", () => {
    const rules = notificationMuteRules("12:task.assign,12:record");

    expect(rules).toContain("12|task.assigned");
    expect(rules).toContain("12|TASK_ASSIGNED");
    expect(rules).toContain("12|record.publish");
    expect(rules).toContain("12|record.version.create");
    expect(rules).not.toContain("12|task.complete");
    expect(rules.every((rule) => rule.startsWith("12|"))).toBe(true);
  });

  test("同一项目同一类别重复出现时只保留一份规则", () => {
    const rules = notificationMuteRules("12:record,12:record,13:record");

    expect(rules).toHaveLength(new Set(rules).size);
    expect(rules.filter((rule) => rule.startsWith("12|"))).toHaveLength(6);
    expect(rules.filter((rule) => rule.startsWith("13|"))).toHaveLength(6);
  });

  test("未提供参数时不产生过滤规则", () => {
    expect(notificationMuteRules(undefined)).toEqual([]);
  });

  test("非法项目、未知类别和空片段一律拒绝", () => {
    for (const raw of [
      "0:record",
      "12",
      "12:",
      "12:unknown",
      "12:record,",
      "12:record,,13:record",
      "abc:record",
    ]) {
      expect(() => notificationMuteRules(raw)).toThrow(
        InvalidMutedProjectCategoriesError,
      );
    }
  });
});
