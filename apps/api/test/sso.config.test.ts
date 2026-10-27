import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadSsoConfig, ssoEnabled } from "../src/auth/sso/sso.config.js";

const ISSUER = "https://authtest.libiaorobot.com";
const REDIRECT_URL = "http://127.0.0.1:5173/api/v1/auth/sso/callback";

function secretFile(content = "test-client-secret"): string {
  const directory = mkdtempSync(join(tmpdir(), "inpulse-sso-"));
  const path = join(directory, "client-secret.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

function enabledEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    SSO_ENABLED: "1",
    SSO_ISSUER: ISSUER,
    SSO_CLIENT_ID: "inpulse",
    SSO_CLIENT_SECRET_FILE: secretFile(),
    SSO_REDIRECT_URI: REDIRECT_URL,
    NODE_ENV: "test",
    SSO_CLIENT_SECRET_TEST_PATH: "1",
    ...overrides,
  };
}

describe("ssoEnabled", () => {
  test("只有显式的真值才开启", () => {
    expect(ssoEnabled({ SSO_ENABLED: "1" })).toBe(true);
    expect(ssoEnabled({ SSO_ENABLED: " true " })).toBe(true);
    expect(ssoEnabled({ SSO_ENABLED: "TRUE" })).toBe(true);
    expect(ssoEnabled({ SSO_ENABLED: "0" })).toBe(false);
    expect(ssoEnabled({ SSO_ENABLED: "false" })).toBe(false);
    expect(ssoEnabled({})).toBe(false);
  });
});

describe("loadSsoConfig（fail closed）", () => {
  test("未启用时既不返回配置也不报错", () => {
    expect(loadSsoConfig({})).toEqual({
      config: undefined,
      invalidReason: undefined,
    });
  });

  test("配置齐全时返回完整配置", () => {
    const result = loadSsoConfig(enabledEnv());
    expect(result.invalidReason).toBeUndefined();
    expect(result.config?.issuer).toBe(ISSUER);
    expect(result.config?.clientId).toBe("inpulse");
    expect(result.config?.clientSecret).toBe("test-client-secret");
    expect(result.config?.redirectUrl).toBe(REDIRECT_URL);
    expect(result.config?.stateTtlSeconds).toBe(600);
  });

  test("启用但缺少必填项时拒绝并给出分类原因", () => {
    expect(
      loadSsoConfig(enabledEnv({ SSO_ISSUER: undefined })).config,
    ).toBeUndefined();
    expect(
      loadSsoConfig(enabledEnv({ SSO_ISSUER: undefined })).invalidReason,
    ).toContain("SSO_ISSUER");
    expect(
      loadSsoConfig(enabledEnv({ SSO_CLIENT_ID: " " })).invalidReason,
    ).toContain("SSO_CLIENT_ID");
  });

  test("issuer 必须是 https 绝对地址", () => {
    expect(
      loadSsoConfig(enabledEnv({ SSO_ISSUER: "http://authtest.local" }))
        .invalidReason,
    ).toContain("https");
    expect(
      loadSsoConfig(enabledEnv({ SSO_ISSUER: "authtest.local" })).invalidReason,
    ).toContain("https");
  });

  test("redirect url 必须指向回调路由且不带查询串", () => {
    expect(
      loadSsoConfig(enabledEnv({ SSO_REDIRECT_URI: "https://inpulse.local/" }))
        .invalidReason,
    ).toContain("/api/v1/auth/sso/callback");
    expect(
      loadSsoConfig(enabledEnv({ SSO_REDIRECT_URI: `${REDIRECT_URL}?next=1` }))
        .invalidReason,
    ).toContain("query");
  });

  test("生产只接受 /run/secrets 下的 Secret 文件", () => {
    const path = secretFile();
    const result = loadSsoConfig(
      enabledEnv({
        NODE_ENV: "production",
        SSO_CLIENT_SECRET_TEST_PATH: "1",
        SSO_CLIENT_SECRET_FILE: path,
      }),
    );
    expect(result.config).toBeUndefined();
    expect(result.invalidReason).toContain("/run/secrets/");
  });

  test("Secret 为空或不可读时拒绝", () => {
    expect(
      loadSsoConfig(enabledEnv({ SSO_CLIENT_SECRET_FILE: secretFile("") }))
        .invalidReason,
    ).toContain("empty");
    expect(
      loadSsoConfig(
        enabledEnv({
          SSO_CLIENT_SECRET_FILE: secretFile().replace(".txt", "-missing.txt"),
        }),
      ).invalidReason,
    ).toContain("not readable");
  });

  test("非法配置不泄露 Secret 内容", () => {
    const result = loadSsoConfig(
      enabledEnv({ SSO_ISSUER: "http://insecure.local" }),
    );
    expect(JSON.stringify(result)).not.toContain("test-client-secret");
  });
});

describe("CASDOOR_IMPORT_ORGANIZATION", () => {
  test("可选配置只接受单个 Casdoor 组织 owner", () => {
    expect(
      loadSsoConfig(enabledEnv()).config?.importOrganization,
    ).toBeUndefined();
    expect(
      loadSsoConfig(
        enabledEnv({ CASDOOR_IMPORT_ORGANIZATION: " libiaorobot.com " }),
      ).config?.importOrganization,
    ).toBe("libiaorobot.com");
  });

  test("带路径的非法组织配置按 fail closed 拒绝", () => {
    const result = loadSsoConfig(
      enabledEnv({ CASDOOR_IMPORT_ORGANIZATION: "libiaorobot.com/测试部" }),
    );
    expect(result.config).toBeUndefined();
    expect(result.invalidReason).toContain("CASDOOR_IMPORT_ORGANIZATION");
  });
});
