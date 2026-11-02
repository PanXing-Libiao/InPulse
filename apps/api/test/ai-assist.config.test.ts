import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  aiAssistEnabled,
  loadAiAssistConfig,
} from "../src/modules/document-import/ai-assist.config.js";

const ENDPOINT = "https://api.example.com/v1/chat/completions";

function secretFile(content = "test-ai-key"): string {
  const directory = mkdtempSync(join(tmpdir(), "inpulse-ai-assist-"));
  const path = join(directory, "api-key.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

function enabledEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    AI_ASSIST_ENABLED: "1",
    AI_ASSIST_ENDPOINT: ENDPOINT,
    AI_ASSIST_MODEL: "gpt-4o-mini",
    AI_ASSIST_API_KEY_FILE: secretFile(),
    NODE_ENV: "test",
    AI_ASSIST_API_KEY_TEST_PATH: "1",
    ...overrides,
  };
}

describe("aiAssistEnabled", () => {
  test("只有显式的真值才开启", () => {
    expect(aiAssistEnabled({ AI_ASSIST_ENABLED: "1" })).toBe(true);
    expect(aiAssistEnabled({ AI_ASSIST_ENABLED: " true " })).toBe(true);
    expect(aiAssistEnabled({ AI_ASSIST_ENABLED: "TRUE" })).toBe(true);
    expect(aiAssistEnabled({ AI_ASSIST_ENABLED: "0" })).toBe(false);
    expect(aiAssistEnabled({ AI_ASSIST_ENABLED: "false" })).toBe(false);
    expect(aiAssistEnabled({})).toBe(false);
  });
});
describe("loadAiAssistConfig（fail closed）", () => {
  test("未启用时既不返回配置也不报错", () => {
    expect(loadAiAssistConfig({})).toEqual({
      config: undefined,
      invalidReason: undefined,
    });
  });

  test("配置齐全时返回完整配置与默认超参", () => {
    const result = loadAiAssistConfig(enabledEnv());
    expect(result.invalidReason).toBeUndefined();
    expect(result.config?.endpoint).toBe(ENDPOINT);
    expect(result.config?.model).toBe("gpt-4o-mini");
    expect(result.config?.apiKey).toBe("test-ai-key");
    expect(result.config?.timeoutMs).toBe(60_000);
    expect(result.config?.maxTokens).toBe(8192);
  });

  test("超时与 max_tokens 可显式覆盖", () => {
    const result = loadAiAssistConfig(
      enabledEnv({
        AI_ASSIST_TIMEOUT_MS: "30000",
        AI_ASSIST_MAX_TOKENS: "2048",
      }),
    );
    expect(result.config?.timeoutMs).toBe(30_000);
    expect(result.config?.maxTokens).toBe(2048);
  });

  test("总结模型可选：未配置时不写入，配置时原样返回", () => {
    expect(
      loadAiAssistConfig(enabledEnv()).config?.summaryModel,
    ).toBeUndefined();
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_SUMMARY_MODEL: " fast-model " }),
      ).config?.summaryModel,
    ).toBe("fast-model");
  });

  test("总结模型超长时 fail closed", () => {
    const result = loadAiAssistConfig(
      enabledEnv({ AI_ASSIST_SUMMARY_MODEL: "x".repeat(201) }),
    );
    expect(result.config).toBeUndefined();
    expect(result.invalidReason).toContain("AI_ASSIST_SUMMARY_MODEL");
  });

  test("启用但缺少端点 / 模型 / 密钥文件时拒绝并给出分类原因", () => {
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_ENDPOINT: undefined })).config,
    ).toBeUndefined();
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_ENDPOINT: undefined }))
        .invalidReason,
    ).toContain("AI_ASSIST_ENDPOINT");
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_MODEL: " " })).invalidReason,
    ).toContain("AI_ASSIST_MODEL");
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_API_KEY_FILE: undefined }))
        .invalidReason,
    ).toContain("AI_ASSIST_API_KEY_FILE");
  });

  test("端点必须为 https 绝对地址", () => {
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_ENDPOINT: "not-a-url" }))
        .invalidReason,
    ).toContain("URL");
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: "ftp://api.example.com/x" }),
      ).invalidReason,
    ).toContain("https");
  });

  test("dev / test 允许回环 http；非回环 http 与生产回环均拒绝", () => {
    const loopback = "http://127.0.0.1:8123/v1/chat/completions";
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_ENDPOINT: loopback })).config
        ?.endpoint,
    ).toBe(loopback);
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: "http://api.example.com/x" }),
      ).invalidReason,
    ).toContain("https");
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: loopback, NODE_ENV: "production" }),
      ).invalidReason,
    ).toContain("https");
  });

  test("根地址自动补全 /chat/completions（含尾斜杠与裸域名）", () => {
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: "https://api.example.com/v1" }),
      ).config?.endpoint,
    ).toBe("https://api.example.com/v1/chat/completions");
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: "https://api.example.com/v1/" }),
      ).config?.endpoint,
    ).toBe("https://api.example.com/v1/chat/completions");
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: "https://api.example.com" }),
      ).config?.endpoint,
    ).toBe("https://api.example.com/v1/chat/completions");
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_ENDPOINT: "http://127.0.0.1:8123/v1" }),
      ).config?.endpoint,
    ).toBe("http://127.0.0.1:8123/v1/chat/completions");
  });

  test("密钥文件路径：非 test 逃生时必须位于 /run/secrets", () => {
    expect(
      loadAiAssistConfig(
        enabledEnv({
          AI_ASSIST_API_KEY_FILE: "C:/tmp/key.txt",
          AI_ASSIST_API_KEY_TEST_PATH: undefined,
        }),
      ).invalidReason,
    ).toContain("/run/secrets/");
    expect(
      loadAiAssistConfig(
        enabledEnv({
          AI_ASSIST_API_KEY_FILE: "/run/secrets/ai_assist_api_key",
        }),
      ).invalidReason,
    ).toContain("not readable");
  });

  test("密钥文件不可读或为空时拒绝", () => {
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_API_KEY_FILE: "C:/definitely-missing/key.txt" }),
      ).invalidReason,
    ).toContain("not readable");
    expect(
      loadAiAssistConfig(
        enabledEnv({ AI_ASSIST_API_KEY_FILE: secretFile("   ") }),
      ).invalidReason,
    ).toContain("empty");
  });

  test("超时与 max_tokens 必须为范围内的整数", () => {
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_TIMEOUT_MS: "abc" }))
        .invalidReason,
    ).toContain("AI_ASSIST_TIMEOUT_MS");
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_TIMEOUT_MS: "10" }))
        .invalidReason,
    ).toContain("AI_ASSIST_TIMEOUT_MS");
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_MAX_TOKENS: "0" }))
        .invalidReason,
    ).toContain("AI_ASSIST_MAX_TOKENS");
    expect(
      loadAiAssistConfig(enabledEnv({ AI_ASSIST_MAX_TOKENS: "99999999" }))
        .invalidReason,
    ).toContain("AI_ASSIST_MAX_TOKENS");
  });
});
