import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { TransactionContext } from "../src/database/transaction-context.js";
import type { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { AiAssistRuntimeService } from "../src/modules/document-import/ai-assist-runtime.service.js";
import {
  encryptAiAssistSecret,
  loadAiAssistEncryptionKeyring,
  type AiAssistEncryptionKeyring,
} from "../src/modules/document-import/ai-assist-secret-keyring.js";
import {
  AiAssistSettingsRepository,
  type AiAssistSettingsRecord,
} from "../src/modules/document-import/ai-assist-settings.repository.js";

// 静音 Nest Logger，保持测试输出干净。
vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

const PLAINTEXT = "value-for-encryption";

let directory: string | undefined;
let keyring: AiAssistEncryptionKeyring | undefined;
let apiKeyFile = "";

function keyringEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    AI_ASSIST_ENCRYPTION_KEY_TEST_PATH: "1",
    AI_ASSIST_ENCRYPTION_KEY_FILE: join(directory!, "ai-assist.keyring"),
    AI_ASSIST_ENCRYPTION_KEY_VERSION: "1",
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "inpulse-ai-assist-runtime-"));
  await writeFile(
    join(directory, "ai-assist.keyring"),
    "1:" + "ab".repeat(32) + "\n",
    "utf8",
  );
  apiKeyFile = join(directory, "ai-assist-api-key.txt");
  await writeFile(apiKeyFile, "env-mode-key\n", "utf8");
  keyring = loadAiAssistEncryptionKeyring(keyringEnv());
});

afterAll(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

function rowOf(
  overrides: Partial<AiAssistSettingsRecord> = {},
): AiAssistSettingsRecord {
  const encrypted = encryptAiAssistSecret(PLAINTEXT, keyring!);
  return {
    id: 1,
    enabled: true,
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "stub-model",
    timeoutMs: 60_000,
    maxTokens: 8_192,
    apiKeyCiphertext: encrypted.ciphertext,
    apiKeyKeyVersion: encrypted.keyVersion,
    apiKeyHint: "tion",
    updatedBy: 1,
    updatedAt: new Date().toISOString(),
    rowVersion: 3,
    ...overrides,
  };
}

function legacyEnv(): Record<string, string> {
  return {
    ...keyringEnv(),
    AI_ASSIST_ENABLED: "1",
    AI_ASSIST_ENDPOINT: "https://api.example.com/v1/chat/completions",
    AI_ASSIST_MODEL: "env-model",
    AI_ASSIST_API_KEY_FILE: apiKeyFile,
    AI_ASSIST_API_KEY_TEST_PATH: "1",
  };
}

function serviceWithRow(row: AiAssistSettingsRecord | undefined): {
  readonly service: AiAssistRuntimeService;
  readonly findCalls: () => number;
} {
  let calls = 0;
  const repository = {
    find: async () => {
      calls += 1;
      return row;
    },
  } as unknown as AiAssistSettingsRepository;
  const uow = {
    run: async (callback: (tx: TransactionContext) => Promise<unknown>) =>
      callback({} as TransactionContext),
  } as unknown as PostgresUnitOfWork;
  return {
    service: new AiAssistRuntimeService(uow, repository),
    findCalls: () => calls,
  };
}

describe("AiAssistRuntimeService.resolveFromRow（优先级矩阵）", () => {
  test("急停：AI_ASSIST_ENABLED 显式非真值 → KILL_SWITCH，即使数据库行开启", () => {
    const service = serviceWithRow(undefined).service;
    expect(
      service.resolveFromRow(rowOf(), {
        ...keyringEnv(),
        AI_ASSIST_ENABLED: "0",
      }),
    ).toEqual({ kind: "DISABLED", reason: "KILL_SWITCH", detail: undefined });
  });

  test("数据库行优先于环境变量：enabled=true → READY / DATABASE", () => {
    const service = serviceWithRow(undefined).service;
    const resolution = service.resolveFromRow(rowOf(), legacyEnv());
    if (resolution.kind !== "READY") {
      throw new Error("expected READY resolution");
    }
    expect(resolution.source).toBe("DATABASE");
    expect(resolution.config.model).toBe("stub-model");
    expect(resolution.config.apiKey).toBe(PLAINTEXT);
  });

  test("数据库行 enabled=false → NOT_ENABLED，即使环境变量已配置", () => {
    const service = serviceWithRow(undefined).service;
    expect(
      service.resolveFromRow(rowOf({ enabled: false }), legacyEnv()),
    ).toEqual({
      kind: "DISABLED",
      reason: "NOT_ENABLED",
      detail: undefined,
    });
  });

  test("数据库行端点 / 模型非法 → CONFIG_INVALID", () => {
    const service = serviceWithRow(undefined).service;
    expect(
      service.resolveFromRow(
        rowOf({ endpoint: "http://api.example.com/v1" }),
        keyringEnv(),
      ),
    ).toMatchObject({ kind: "DISABLED", reason: "CONFIG_INVALID" });
    expect(
      service.resolveFromRow(rowOf({ model: "x".repeat(201) }), keyringEnv()),
    ).toMatchObject({ kind: "DISABLED", reason: "CONFIG_INVALID" });
  });

  test("密文被篡改 → CONFIG_INVALID（fail closed）", () => {
    const service = serviceWithRow(undefined).service;
    const broken = rowOf();
    const tampered = Buffer.from(broken.apiKeyCiphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(
      service.resolveFromRow(
        { ...broken, apiKeyCiphertext: tampered },
        keyringEnv(),
      ),
    ).toMatchObject({ kind: "DISABLED", reason: "CONFIG_INVALID" });
  });

  test("数据库行可用但主密钥缺失 → ENCRYPTION_KEY_UNAVAILABLE", () => {
    const service = serviceWithRow(undefined).service;
    expect(service.resolveFromRow(rowOf(), {})).toMatchObject({
      kind: "DISABLED",
      reason: "ENCRYPTION_KEY_UNAVAILABLE",
    });
  });

  test("无数据库行时回退环境变量：合法 → READY / ENVIRONMENT", () => {
    const service = serviceWithRow(undefined).service;
    const resolution = service.resolveFromRow(undefined, legacyEnv());
    if (resolution.kind !== "READY") {
      throw new Error("expected READY resolution");
    }
    expect(resolution.source).toBe("ENVIRONMENT");
    expect(resolution.config.apiKey).toBe("env-mode-key");
  });

  test("无数据库行：未启用 → NOT_ENABLED；启用但配置非法 → CONFIG_INVALID", () => {
    const service = serviceWithRow(undefined).service;
    expect(service.resolveFromRow(undefined, keyringEnv())).toEqual({
      kind: "DISABLED",
      reason: "NOT_ENABLED",
      detail: undefined,
    });
    expect(
      service.resolveFromRow(undefined, {
        ...keyringEnv(),
        AI_ASSIST_ENABLED: "1",
      }),
    ).toMatchObject({ kind: "DISABLED", reason: "CONFIG_INVALID" });
  });
});

describe("AiAssistRuntimeService.resolve（经 UnitOfWork 读取）", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [name, value] of Object.entries(keyringEnv())) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    saved["AI_ASSIST_ENABLED"] = process.env["AI_ASSIST_ENABLED"];
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  test("急停时短路：不访问数据库", async () => {
    process.env["AI_ASSIST_ENABLED"] = "0";
    const { service, findCalls } = serviceWithRow(rowOf());
    const resolution = await service.resolve();
    expect(resolution).toEqual({
      kind: "DISABLED",
      reason: "KILL_SWITCH",
      detail: undefined,
    });
    expect(findCalls()).toBe(0);
  });

  test("无急停时读取数据库行并优先", async () => {
    process.env["AI_ASSIST_ENABLED"] = "1";
    const { service, findCalls } = serviceWithRow(rowOf());
    const resolution = await service.resolve();
    expect(findCalls()).toBe(1);
    if (resolution.kind !== "READY") {
      throw new Error("expected READY resolution");
    }
    expect(resolution.source).toBe("DATABASE");
    expect(resolution.config.apiKey).toBe(PLAINTEXT);
  });
  test("resolveApiKey：配置关闭的数据库行仍可复用密钥，密文损坏则 fail closed", async () => {
    process.env["AI_ASSIST_ENABLED"] = "1";
    const disabled = serviceWithRow(rowOf({ enabled: false }));
    expect(await disabled.service.resolveApiKey()).toEqual({
      kind: "READY",
      apiKey: PLAINTEXT,
      source: "DATABASE",
    });

    const broken = rowOf();
    const tampered = Buffer.from(broken.apiKeyCiphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    const invalid = serviceWithRow({
      ...broken,
      apiKeyCiphertext: tampered,
    });
    expect(await invalid.service.resolveApiKey()).toMatchObject({
      kind: "DISABLED",
      reason: "CONFIG_INVALID",
    });
  });
});
