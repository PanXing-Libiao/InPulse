import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { beforeEach, describe, expect, test } from "vitest";

import {
  SsoOidcClient,
  SsoProtocolError,
} from "../src/auth/sso/sso-oidc.client.js";
import type { SsoConfig } from "../src/auth/sso/sso.config.js";

const ISSUER = "https://authtest.libiaorobot.com";
const AUTHORIZE_ENDPOINT = `${ISSUER}/login/oauth/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/api/login/oauth/access_token`;
const JWKS_URI = `${ISSUER}/.well-known/jwks`;

const config: SsoConfig = {
  issuer: ISSUER,
  clientId: "inpulse-test",
  clientSecret: "unit-test-secret",
  redirectUrl: "http://127.0.0.1:5173/api/v1/auth/sso/callback",
  stateTtlSeconds: 600,
  discoveryTtlSeconds: 600,
  requestTimeoutMs: 2000,
};

interface KeyMaterial {
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

function createKey(kid: string): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { privateKey, jwk: { ...jwk, kid, use: "sig", alg: "RS256" } };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signIdToken(
  claims: Record<string, unknown>,
  key: KeyMaterial,
  options: { readonly kid?: string; readonly alg?: string } = {},
): string {
  const headerPart = base64Url({
    alg: options.alg ?? "RS256",
    typ: "JWT",
    kid: options.kid ?? "key-1",
  });
  const payloadPart = base64Url(claims);
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
    key.privateKey,
  ).toString("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

function claims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: config.clientId,
    sub: "8f8a9897-610c-4a0e-ad07-e276ff6fb5b5",
    name: "shaochenyu",
    displayName: "邵晨宇",
    email: "shaochenyu@libiaorobot.com",
    nonce: "expected-nonce",
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

interface StubOptions {
  readonly issuer?: string;
  readonly endpoints?: Partial<{
    readonly authorization_endpoint: string;
    readonly token_endpoint: string;
    readonly jwks_uri: string;
  }>;
  readonly keys?: readonly Record<string, unknown>[];
  readonly idToken?: (body: URLSearchParams) => string;
  readonly tokenStatus?: number;
  readonly tokenBody?: Record<string, unknown>;
  readonly discoveryStatus?: number;
}

function createStubFetch(options: StubOptions = {}): {
  readonly fetchImpl: typeof fetch;
  readonly calls: string[];
  readonly tokenBodies: URLSearchParams[];
} {
  const calls: string[] = [];
  const tokenBodies: URLSearchParams[] = [];
  const metadata = {
    issuer: options.issuer ?? ISSUER,
    authorization_endpoint: AUTHORIZE_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    jwks_uri: JWKS_URI,
    ...options.endpoints,
  };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse(metadata, options.discoveryStatus ?? 200);
    }
    if (url === metadata.jwks_uri) {
      return jsonResponse({ keys: options.keys ?? [] });
    }
    if (url === metadata.token_endpoint) {
      tokenBodies.push(new URLSearchParams(String(init?.body ?? "")));
      if (options.tokenBody !== undefined) {
        return jsonResponse(options.tokenBody, options.tokenStatus ?? 200);
      }
      return jsonResponse({ id_token: "" }, options.tokenStatus ?? 200);
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, tokenBodies };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let key: KeyMaterial;

beforeEach(() => {
  key = createKey("key-1");
});

describe("SsoOidcClient 授权与发现", () => {
  test("授权地址来自 discovery，并带 state/nonce/PKCE", async () => {
    const { fetchImpl, calls } = createStubFetch({ keys: [key.jwk] });
    const client = new SsoOidcClient(config, fetchImpl);

    const url = new URL(
      await client.buildAuthorizationUrl({
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: "challenge-1",
      }),
    );

    expect(url.origin + url.pathname).toBe(AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUrl);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(calls).toEqual([`GET ${ISSUER}/.well-known/openid-configuration`]);
  });

  test("discovery 结果按 TTL 缓存，只请求一次", async () => {
    const { fetchImpl, calls } = createStubFetch({ keys: [key.jwk] });
    const client = new SsoOidcClient(config, fetchImpl);

    await client.buildAuthorizationUrl({
      state: "a",
      nonce: "b",
      codeChallenge: "c",
    });
    await client.buildAuthorizationUrl({
      state: "d",
      nonce: "e",
      codeChallenge: "f",
    });

    expect(
      calls.filter((call) => call.includes("openid-configuration")),
    ).toHaveLength(1);
  });

  test("discovery issuer 不一致或端点非 https 时拒绝", async () => {
    const mismatch = createStubFetch({ issuer: "https://other.example.com" });
    await expect(
      new SsoOidcClient(config, mismatch.fetchImpl).buildAuthorizationUrl({
        state: "a",
        nonce: "b",
        codeChallenge: "c",
      }),
    ).rejects.toThrow(/discovery-issuer-mismatch/);

    const insecure = createStubFetch({
      endpoints: { token_endpoint: "http://insecure.example.com/token" },
    });
    await expect(
      new SsoOidcClient(config, insecure.fetchImpl).buildAuthorizationUrl({
        state: "a",
        nonce: "b",
        codeChallenge: "c",
      }),
    ).rejects.toThrow(/discovery-insecure-endpoint/);
  });

  test("discovery 非 2xx 时 fail closed", async () => {
    const stub = createStubFetch({ discoveryStatus: 503 });
    await expect(
      new SsoOidcClient(config, stub.fetchImpl).exchangeAuthorizationCode({
        code: "code-1",
        codeVerifier: "verifier-1",
      }),
    ).rejects.toThrow(/discovery-503/);
  });
});

describe("SsoOidcClient 换取令牌", () => {
  test("服务端到服务端提交 client_secret 与 PKCE verifier", async () => {
    const stub = createStubFetch({
      keys: [key.jwk],
      tokenBody: {
        id_token: signIdToken(claims(), key),
      },
    });
    const client = new SsoOidcClient(config, stub.fetchImpl);

    const idToken = await client.exchangeAuthorizationCode({
      code: "code-1",
      codeVerifier: "verifier-1",
    });

    expect(idToken.split(".")).toHaveLength(3);
    const body = stub.tokenBodies[0];
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(body?.get("code")).toBe("code-1");
    expect(body?.get("redirect_uri")).toBe(config.redirectUrl);
    expect(body?.get("client_id")).toBe(config.clientId);
    expect(body?.get("client_secret")).toBe(config.clientSecret);
    expect(body?.get("code_verifier")).toBe("verifier-1");
  });

  test("token 端点失败或缺 id_token 时拒绝", async () => {
    const failing = createStubFetch({ tokenBody: {}, tokenStatus: 400 });
    await expect(
      new SsoOidcClient(config, failing.fetchImpl).exchangeAuthorizationCode({
        code: "code-1",
        codeVerifier: "verifier-1",
      }),
    ).rejects.toThrow(/token-exchange-400/);

    const missing = createStubFetch({ tokenBody: { access_token: "x" } });
    await expect(
      new SsoOidcClient(config, missing.fetchImpl).exchangeAuthorizationCode({
        code: "code-1",
        codeVerifier: "verifier-1",
      }),
    ).rejects.toThrow(/missing-id-token/);
  });
});

describe("SsoOidcClient id_token 验签", () => {
  function client(stub: ReturnType<typeof createStubFetch>): SsoOidcClient {
    return new SsoOidcClient(config, stub.fetchImpl);
  }

  test("签名有效时只提取身份字段与已验签 groups", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const result = await client(stub).verifyIdToken(
      signIdToken(claims({ isAdmin: true, roles: ["admin"] }), key),
      { nonce: "expected-nonce" },
    );

    expect(result).toEqual({
      subject: "8f8a9897-610c-4a0e-ad07-e276ff6fb5b5",
      loginName: "shaochenyu",
      displayName: "邵晨宇",
      email: "shaochenyu@libiaorobot.com",
      groups: null,
    });
    expect(Object.keys(result)).not.toContain("isAdmin");
  });

  test("groups 保留 Casdoor 原始路径，区分缺失与空数组并拒绝非法形状", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const verifier = client(stub);

    const empty = await verifier.verifyIdToken(
      signIdToken(claims({ groups: [] }), key),
      { nonce: "expected-nonce" },
    );
    expect(empty.groups).toEqual([]);

    const paths = [
      "libiaorobot.com/总部/测试部",
      "libiaorobot.com/研发/平台组",
    ];
    const grouped = await verifier.verifyIdToken(
      signIdToken(claims({ groups: paths }), key),
      { nonce: "expected-nonce" },
    );
    expect(grouped.groups).toEqual(paths);

    await expect(
      verifier.verifyIdToken(
        signIdToken(claims({ groups: "libiaorobot.com/测试部" }), key),
        { nonce: "expected-nonce" },
      ),
    ).rejects.toThrow(/id-token-groups-invalid/);
    await expect(
      verifier.verifyIdToken(signIdToken(claims({ groups: [1] }), key), {
        nonce: "expected-nonce",
      }),
    ).rejects.toThrow(/id-token-groups-invalid/);
  });

  test("缺少 displayName/email 时回落到 loginName 与 null", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const result = await client(stub).verifyIdToken(
      signIdToken(claims({ displayName: undefined, email: undefined }), key),
      { nonce: "expected-nonce" },
    );

    expect(result.displayName).toBe("shaochenyu");
    expect(result.email).toBeNull();
  });

  test("nonce/iss/aud/exp/nbf 任一不符都拒绝", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const verifier = client(stub);
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verifier.verifyIdToken(signIdToken(claims(), key), { nonce: "other" }),
    ).rejects.toThrow(/id-token-nonce-mismatch/);
    await expect(
      verifier.verifyIdToken(
        signIdToken(claims({ iss: "https://evil.example.com" }), key),
        { nonce: "expected-nonce" },
      ),
    ).rejects.toThrow(/id-token-issuer-mismatch/);
    await expect(
      verifier.verifyIdToken(
        signIdToken(claims({ aud: "other-client" }), key),
        {
          nonce: "expected-nonce",
        },
      ),
    ).rejects.toThrow(/id-token-audience-mismatch/);
    await expect(
      verifier.verifyIdToken(signIdToken(claims({ exp: now - 600 }), key), {
        nonce: "expected-nonce",
      }),
    ).rejects.toThrow(/id-token-expired/);
    await expect(
      verifier.verifyIdToken(signIdToken(claims({ nbf: now + 600 }), key), {
        nonce: "expected-nonce",
      }),
    ).rejects.toThrow(/id-token-not-yet-valid/);
  });

  test("aud 为数组时接受包含 client_id 的取值", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const result = await client(stub).verifyIdToken(
      signIdToken(claims({ aud: ["other", config.clientId] }), key),
      { nonce: "expected-nonce" },
    );

    expect(result.loginName).toBe("shaochenyu");
  });

  test("非 RS256、篡改载荷与签名无效都拒绝", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const verifier = client(stub);

    await expect(
      verifier.verifyIdToken(signIdToken(claims(), key, { alg: "HS256" }), {
        nonce: "expected-nonce",
      }),
    ).rejects.toThrow(/unsupported-id-token-algorithm/);

    const other = createKey("key-2");
    await expect(
      verifier.verifyIdToken(signIdToken(claims(), other), {
        nonce: "expected-nonce",
      }),
    ).rejects.toThrow(
      /unknown-id-token-signing-key|id-token-signature-invalid/,
    );

    const parts = signIdToken(claims(), key).split(".");
    const tampered = `${parts[0]}.${base64Url(claims({ sub: "attacker" }))}.${parts[2]}`;
    await expect(
      verifier.verifyIdToken(tampered, { nonce: "expected-nonce" }),
    ).rejects.toThrow(/id-token-signature-invalid/);

    await expect(
      verifier.verifyIdToken("not-a-jwt", { nonce: "expected-nonce" }),
    ).rejects.toThrow(/malformed-id-token/);
    await expect(
      verifier.verifyIdToken("a.b.c", { nonce: "expected-nonce" }),
    ).rejects.toThrow(/malformed-id-token/);
  });

  test("kid 未命中时强制刷新一次 JWKS（密钥轮换）", async () => {
    const rotated = createKey("key-9");
    let jwksCalls = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: AUTHORIZE_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          jwks_uri: JWKS_URI,
        });
      }
      if (url === JWKS_URI) {
        jwksCalls += 1;
        return jsonResponse({
          keys: jwksCalls === 1 ? [key.jwk] : [rotated.jwk],
        });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await new SsoOidcClient(config, fetchImpl).verifyIdToken(
      signIdToken(claims(), rotated, { kid: "key-9" }),
      { nonce: "expected-nonce" },
    );

    expect(result.loginName).toBe("shaochenyu");
    expect(jwksCalls).toBe(2);
  });

  test("协议错误类型统一为 SsoProtocolError 且不携带令牌内容", async () => {
    const stub = createStubFetch({ keys: [key.jwk] });
    const token = signIdToken(claims(), key);
    const error = await client(stub)
      .verifyIdToken(token, { nonce: "other" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SsoProtocolError);
    expect((error as SsoProtocolError).reason).toBe("id-token-nonce-mismatch");
    expect(String(error)).not.toContain(token.slice(0, 24));
  });
});
