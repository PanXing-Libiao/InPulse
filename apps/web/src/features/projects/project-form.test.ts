import { describe, expect, it } from "vitest";
import {
  deriveProjectCodeFromName,
  validateProjectWecomWebhookUrl,
} from "./project-form";

describe("deriveProjectCodeFromName", () => {
  it("keeps english letters and digits, dropping chinese, spaces and symbols", () => {
    expect(deriveProjectCodeFromName("shop system")).toBe("SHOPSYSTEM");
    expect(deriveProjectCodeFromName("商城系统 Shop2")).toBe("SHOP2");
    expect(deriveProjectCodeFromName("SHOP-T-99")).toBe("SHOPT99");
    expect(deriveProjectCodeFromName("K1235 商城系统")).toBe("K1235");
  });

  it("returns an empty result when nothing valid can be derived", () => {
    expect(deriveProjectCodeFromName("")).toBe("");
    expect(deriveProjectCodeFromName("商城系统")).toBe("");
    expect(deriveProjectCodeFromName("A 项目")).toBe("");
    expect(deriveProjectCodeFromName("6DoF 云台")).toBe("");
  });

  it("truncates to the code length limit", () => {
    expect(deriveProjectCodeFromName("a".repeat(40))).toBe("A".repeat(32));
  });
});

describe("validateProjectWecomWebhookUrl", () => {
  it("accepts only the official WeCom send endpoint with one valid key", () => {
    expect(
      validateProjectWecomWebhookUrl(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234efgh5678",
      ),
    ).toBeNull();
    expect(
      validateProjectWecomWebhookUrl(
        "https://example.com/cgi-bin/webhook/send?key=abcd1234efgh5678",
      ),
    ).toBe("请使用企业微信官方群机器人 Webhook 地址");
    expect(
      validateProjectWecomWebhookUrl(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=short",
      ),
    ).toBe("Webhook key 格式不正确，请重新复制");
  });

  it("rejects empty, malformed and extra-parameter URLs without echoing the key", () => {
    expect(validateProjectWecomWebhookUrl("  ")).toBe(
      "请粘贴企业微信群机器人 Webhook 地址",
    );
    expect(validateProjectWecomWebhookUrl("not-a-url")).toBe(
      "Webhook 地址格式不正确，请重新复制",
    );
    expect(
      validateProjectWecomWebhookUrl(
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234efgh5678&foo=bar",
      ),
    ).toBe("Webhook 地址只能包含一个 key 参数");
  });
});
