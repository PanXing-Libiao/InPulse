import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * 立镖 Casdoor OIDC 的桩 IdP（ADR-032）：
 * 提供 discovery、token、JWKS 与只读群组元数据端点；id_token 固定附带
 * isAdmin: true，用于证明 InPulse 忽略该 claim、只按本地账号状态判定权限。
 */
export interface StubIdpClaims {
  readonly nonce: string;
  readonly subject?: string;
  readonly loginName: string;
  readonly displayName?: string;
  readonly email?: string | null;
  /** undefined 表示 id_token 不包含 groups；空数组表示明确无群组。 */
  readonly groups?: readonly string[];
  /** 未给出时，claim 中的每个群组默认是启用中的 Physical 组。 */
  readonly groupMetadata?: readonly StubIdpGroupMetadata[];
  readonly groupLookupStatus?: number;
}

export interface StubIdpGroupMetadata {
  readonly path: string;
  /** undefined 使用 Physical；null 表示响应缺少 type。 */
  readonly type?: string | null;
  readonly isEnabled?: boolean;
  readonly isTopGroup?: boolean;
  readonly parentId?: string;
}

export interface StubIdpGroupLookup {
  readonly id: string;
  readonly authorization: string | null;
}

export interface StubIdp {
  readonly fetchImpl: typeof fetch;
  readonly jwksCalls: () => number;
  readonly groupCalls: () => readonly StubIdpGroupLookup[];
  setClaims(claims: StubIdpClaims): void;
  setGroupLookupObserver(observer: (() => void) | undefined): void;
}

export interface StubIdpOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** 未显式给 subject 时的兜底生成器；默认随机 UUID。 */
  readonly fallbackSubject?: () => string;
}

interface KeyMaterial {
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

const ACCESS_TOKEN = "stub-access-token";

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
  const groupEndpoint = issuer + "/api/get-group";
  const groupAuthorization =
    "Basic " +
    Buffer.from(options.clientId + ":" + options.clientSecret, "utf8").toString(
      "base64",
    );
  const fallbackSubject =
    options.fallbackSubject ??
    ((): string => "sub_" + randomUUID().replaceAll("-", ""));

  const key = createKey("key-1");
  let jwksCalls = 0;
  let current: StubIdpClaims | undefined;
  let groupLookupObserver: (() => void) | undefined;
  const groupCalls: StubIdpGroupLookup[] = [];

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
        access_token: ACCESS_TOKEN,
        id_token: headerPart + "." + payloadPart + "." + signature,
      });
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.origin + parsedUrl.pathname === groupEndpoint) {
      const authorization = new Headers(init?.headers).get("authorization");
      const id = parsedUrl.searchParams.get("id") ?? "";
      groupCalls.push({ id, authorization });
      groupLookupObserver?.();
      if (authorization !== groupAuthorization) {
        return jsonResponse({ status: "error", msg: "unauthorized" }, 401);
      }
      if (current?.groupLookupStatus !== undefined) {
        return jsonResponse({}, current.groupLookupStatus);
      }
      const record = buildGroupRecord(current, id);
      if (record === undefined) {
        return jsonResponse({ status: "error", msg: "group not found" }, 404);
      }
      return jsonResponse({ status: "ok", msg: "", data: record });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    jwksCalls: () => jwksCalls,
    groupCalls: () => [...groupCalls],
    setClaims: (claims) => {
      current = claims;
    },
    setGroupLookupObserver: (observer) => {
      groupLookupObserver = observer;
    },
  };
}

function buildGroupRecord(
  claims: StubIdpClaims | undefined,
  id: string,
): Record<string, unknown> | undefined {
  if (claims?.groups === undefined) {
    return undefined;
  }
  const owner = id.slice(0, id.indexOf("/"));
  const name = id.slice(id.indexOf("/") + 1);
  if (owner.length === 0 || name.length === 0) {
    return undefined;
  }
  const groupPath = claims.groups.find((value) => {
    const segments = value.split("/");
    return segments[0] === owner && segments.at(-1) === name;
  });
  if (groupPath === undefined) {
    return undefined;
  }
  const segments = groupPath.split("/");
  const metadata = claims.groupMetadata?.find(
    (entry) => entry.path === groupPath,
  );
  const isTopGroup = metadata?.isTopGroup ?? segments.length === 2;
  const record: Record<string, unknown> = {
    owner,
    name,
    isTopGroup,
    parentId:
      metadata?.parentId ??
      (segments.length === 2 ? owner : segments[segments.length - 2]!),
    isEnabled: metadata?.isEnabled ?? true,
    users: ["stub-user"],
  };
  if (metadata?.type !== null) {
    record["type"] = metadata?.type ?? "Physical";
  }
  return record;
}
