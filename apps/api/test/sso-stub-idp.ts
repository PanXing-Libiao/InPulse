import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * 立镖 Casdoor OIDC 的桩 IdP（ADR-032）：
 * 提供 discovery、token 与 JWKS 三个端点；id_token 固定附带 isAdmin: true，
 * 用于证明 InPulse 忽略该 claim、只按本地账号状态判定权限。
 */
export interface StubIdpClaims {
  readonly nonce: string;
  readonly subject?: string;
  readonly loginName: string;
  readonly displayName?: string;
  readonly email?: string | null;
  /** undefined 表示 id_token 不包含 groups；空数组表示明确无群组。 */
  readonly groups?: readonly string[];
}

export interface StubIdp {
  readonly fetchImpl: typeof fetch;
  readonly jwksCalls: () => number;
  setClaims(claims: StubIdpClaims): void;
}

export interface StubIdpOptions {
  readonly issuer: string;
  readonly clientId: string;
  /** 未显式给 subject 时的兜底生成器；默认随机 UUID。 */
  readonly fallbackSubject?: () => string;
}

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createStubIdp(options: StubIdpOptions): StubIdp {
  const issuer = options.issuer;
  const authorizeEndpoint = issuer + "/login/oauth/authorize";
  const tokenEndpoint = issuer + "/api/login/oauth/access_token";
  const jwksUri = issuer + "/.well-known/jwks";
  const fallbackSubject =
    options.fallbackSubject ??
    ((): string => "sub_" + randomUUID().replaceAll("-", ""));

  const key = createKey("key-1");
  let jwksCalls = 0;
  let current: StubIdpClaims | undefined;

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === issuer + "/.well-known/openid-configuration") {
      return jsonResponse({
        issuer,
        authorization_endpoint: authorizeEndpoint,
        token_endpoint: tokenEndpoint,
        jwks_uri: jwksUri,
      });
    }
    if (url === jwksUri) {
      jwksCalls += 1;
      return jsonResponse({ keys: [key.jwk] });
    }
    if (url === tokenEndpoint && init?.method === "POST") {
      if (current === undefined) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: issuer,
        aud: options.clientId,
        sub: current.subject ?? fallbackSubject(),
        name: current.loginName,
        nonce: current.nonce,
        iat: now,
        exp: now + 300,
        // Casdoor 还可能返回 isAdmin 等 claim；InPulse 必须忽略它们。
        isAdmin: true,
      };
      if (current.displayName !== undefined) {
        payload["displayName"] = current.displayName;
      }
      if (current.email !== undefined && current.email !== null) {
        payload["email"] = current.email;
      }
      if (current.groups !== undefined) {
        payload["groups"] = [...current.groups];
      }
      const headerPart = base64Url({ alg: "RS256", typ: "JWT", kid: "key-1" });
      const payloadPart = base64Url(payload);
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(headerPart + "." + payloadPart, "utf8"),
        key.privateKey,
      ).toString("base64url");
      return jsonResponse({
        access_token: "stub-access-token",
        id_token: headerPart + "." + payloadPart + "." + signature,
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    jwksCalls: () => jwksCalls,
    setClaims: (claims) => {
      current = claims;
    },
  };
}
