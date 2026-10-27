import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SSO_GENERIC_ERROR_MESSAGE,
  SSO_START_PATH,
  buildSsoStartUrl,
  describeSsoError,
  navigateToSsoStart,
} from "./sso-navigation";

describe("buildSsoStartUrl", () => {
  it("把站内目标编码进 return_to", () => {
    expect(buildSsoStartUrl("/projects")).toBe(
      `${SSO_START_PATH}?returnTo=%2Fprojects`,
    );
    expect(buildSsoStartUrl("/projects/7?tab=1")).toBe(
      `${SSO_START_PATH}?returnTo=%2Fprojects%2F7%3Ftab%3D1`,
    );
  });

  it("只产出站内相对路径，不接受外部地址", () => {
    const url = buildSsoStartUrl("//evil.example.com");
    expect(url.startsWith(SSO_START_PATH)).toBe(true);
    expect(url).toBe(`${SSO_START_PATH}?returnTo=%2F%2Fevil.example.com`);
  });
});

describe("describeSsoError", () => {
  it("缺少 sso_error 时不显示任何提示", () => {
    expect(describeSsoError(null)).toBeNull();
    expect(describeSsoError(undefined)).toBeNull();
    expect(describeSsoError("")).toBeNull();
  });

  it("把已知分类映射为固定文案", () => {
    expect(describeSsoError("state-expired")).toContain("超时");
    expect(describeSsoError("account-disabled")).toContain("停用");
    expect(describeSsoError("rate-limited")).toContain("频繁");
    expect(describeSsoError("group-metadata-failed")).toContain("群组类型");
  });

  it("未识别的取值只回通用文案，不回显原文", () => {
    const message = describeSsoError("<script>alert(1)</script>");
    expect(message).toBe(SSO_GENERIC_ERROR_MESSAGE);
    expect(message).not.toContain("script");
  });
});

describe("navigateToSsoStart", () => {
  const originalLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("整页跳转到单点登录入口并携带 returnTo", () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: originalLocation.href,
        origin: originalLocation.origin,
        replace,
      },
    });

    navigateToSsoStart("/projects/7");

    expect(replace).toHaveBeenCalledWith(
      `${SSO_START_PATH}?returnTo=%2Fprojects%2F7`,
    );
  });
});
