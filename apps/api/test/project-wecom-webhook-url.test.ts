import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  ProjectWecomWebhookUrlError,
  normalizeProjectWecomWebhookUrl,
} from "../src/modules/wecom-group/project-wecom-webhook-url.js";

const KEY = "Abcdefghijklmnop_WXYZ";
const CANONICAL_URL =
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + KEY;

describe("normalizeProjectWecomWebhookUrl（ADR-105）", () => {
  test("只保留官方 HTTPS origin、固定路径与一个 key", () => {
    const normalized = normalizeProjectWecomWebhookUrl(
      "  " + CANONICAL_URL + "  ",
    );
    expect(normalized.url).toBe(CANONICAL_URL);
    expect(normalized.hint).toBe("WXYZ");
    expect(normalized.fingerprint).toEqual(
      createHash("sha256").update(CANONICAL_URL, "utf8").digest(),
    );
    expect(normalized.fingerprint).toHaveLength(32);
  });

  test.each([
    ["http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + KEY],
    ["https://qyapi.weixin.qq.com/cgi-bin/webhook/sendx?key=" + KEY],
    [
      "https://" +
        "user" +
        ":" +
        "pass" +
        "@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" +
        KEY,
    ],
    [CANONICAL_URL + "#fragment"],
    [CANONICAL_URL + "&debug=1"],
    [CANONICAL_URL + "&key=" + KEY],
    ["https://qyapi.weixin.qq.com/cgi-bin/webhook/send"],
    ["https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=short"],
    ["https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijklmnop!"],
    ["not-a-url"],
  ])("拒绝非法 URL：%s", (input) => {
    expect(() => normalizeProjectWecomWebhookUrl(input)).toThrow(
      ProjectWecomWebhookUrlError,
    );
  });

  test("错误消息不包含用户输入的完整 Key", () => {
    try {
      normalizeProjectWecomWebhookUrl(
        "https://evil.example/cgi-bin/webhook/send?key=" + KEY,
      );
      throw new Error("unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectWecomWebhookUrlError);
      expect((error as Error).message).not.toContain(KEY);
    }
  });
});
