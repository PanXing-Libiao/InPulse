import { createPublicKey, verify as verifySignature } from "node:crypto";

import type { SsoConfig } from "./sso.config.js";

/** Discovery 文档中本实现真正使用的端点，全部来自 issuer 发现结果。 */
export interface SsoProviderMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

/** 只提取身份字段与已验签的 groups；id_token 其余字段一律丢弃。 */
export interface SsoIdTokenClaims {
  readonly subject: string;
  readonly loginName: string;
  readonly displayName: string;
  readonly email: string | null;
  /** null 表示 claim 缺失；空数组表示用户明确没有 Casdoor 群组。 */
  readonly groups: readonly string[] | null;
}

export interface SsoIdTokenVerification {
  readonly nonce: string;
}

const CLOCK_SKEW_SECONDS = 60;
const JSON_WEB_KEY_SET_TYPE = "application/json";

export class SsoProtocolError extends Error {
  constructor(readonly reason: string) {
    super(`SSO protocol failure: ${reason}`);
    this.name = "SsoProtocolError";
  }
}

interface JsonWebKeySet {
  readonly keys: readonly Record<string, unknown>[];
}

/**
 * 标准 OIDC 机密客户端（ADR-032）：授权端点、token 端点与 JWKS 全部来自
 * `/.well-known/openid-configuration` 发现结果，不硬编码任何 Casdoor 路径；
 * 所有请求都在数据库事务之外执行，client_secret 只出现在服务端到服务端的
 * token 请求体中，不落库、不写日志。
 */
export class SsoOidcClient {
  private metadata:
    { value: SsoProviderMetadata; fetchedAt: number } | undefined;
  private keySet: { value: JsonWebKeySet; fetchedAt: number } | undefined;

  constructor(
    private readonly config: SsoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async buildAuthorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
  }): Promise<string> {
    const metadata = await this.providerMetadata();
    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUrl);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** 服务端到服务端换取 token；返回原始 id_token 由调用方立即验签。 */
  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<string> {
    const metadata = await this.providerMetadata();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.config.redirectUrl,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: input.codeVerifier,
    });
    const response = await this.request(metadata.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new SsoProtocolError(`token-exchange-${response.status}`);
    }
    const payload = await parseJsonObject(response);
    const idToken = payload["id_token"];
    if (typeof idToken !== "string" || idToken.length === 0) {
      throw new SsoProtocolError("missing-id-token");
    }
    return idToken;
  }

  /** 校验 RS256 签名与 iss/aud/exp/nbf/nonce，并提取身份与 groups claim。 */
  async verifyIdToken(
    idToken: string,
    verification: SsoIdTokenVerification,
  ): Promise<SsoIdTokenClaims> {
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      throw new SsoProtocolError("malformed-id-token");
    }
    const [headerPart, payloadPart, signaturePart] = parts as [
      string,
      string,
      string,
    ];
    const header = decodeJsonObject(headerPart, "malformed-id-token-header");
    if (header["alg"] !== "RS256") {
      throw new SsoProtocolError("unsupported-id-token-algorithm");
    }
    const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;
    const publicKey = await this.verificationKey(kid);
    const signatureValid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
      publicKey,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!signatureValid) {
      throw new SsoProtocolError("id-token-signature-invalid");
    }

    const claims = decodeJsonObject(payloadPart, "malformed-id-token-payload");
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims["iss"] !== this.config.issuer) {
      throw new SsoProtocolError("id-token-issuer-mismatch");
    }
    if (!audienceMatches(claims["aud"], this.config.clientId)) {
      throw new SsoProtocolError("id-token-audience-mismatch");
    }
    const expiresAt = numericClaim(claims["exp"]);
    if (
      expiresAt === undefined ||
      expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS
    ) {
      throw new SsoProtocolError("id-token-expired");
    }
    const notBefore = numericClaim(claims["nbf"]);
    if (
      notBefore !== undefined &&
      notBefore > nowSeconds + CLOCK_SKEW_SECONDS
    ) {
      throw new SsoProtocolError("id-token-not-yet-valid");
    }
    const issuedAt = numericClaim(claims["iat"]);
    if (issuedAt !== undefined && issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
      throw new SsoProtocolError("id-token-issued-in-future");
    }
    if (claims["nonce"] !== verification.nonce) {
      throw new SsoProtocolError("id-token-nonce-mismatch");
    }

    const subject = stringClaim(claims["sub"]);
    const loginName = stringClaim(claims["name"]);
    if (subject === undefined || loginName === undefined) {
      throw new SsoProtocolError("id-token-missing-identity-claims");
    }
    const displayName = stringClaim(claims["displayName"]) ?? loginName;
    const email = stringClaim(claims["email"]) ?? null;
    const groups = groupsClaim(claims["groups"]);
    return { subject, loginName, displayName, email, groups };
  }

  private async verificationKey(kid: string | undefined) {
    let keySet = await this.jwks();
    let jwk = selectSigningKey(keySet, kid);
    if (jwk === undefined) {
      keySet = await this.jwks(true);
      jwk = selectSigningKey(keySet, kid);
    }
    if (jwk === undefined) {
      throw new SsoProtocolError("unknown-id-token-signing-key");
    }
    try {
      return createPublicKey({ key: jwk as never, format: "jwk" });
    } catch {
      throw new SsoProtocolError("invalid-id-token-signing-key");
    }
  }

  private async providerMetadata(): Promise<SsoProviderMetadata> {
    const cached = this.metadata;
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < this.ttlMs()) {
      return cached.value;
    }
    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    const response = await this.request(url, {
      method: "GET",
      headers: { accept: JSON_WEB_KEY_SET_TYPE },
    });
    if (!response.ok) {
      throw new SsoProtocolError(`discovery-${response.status}`);
    }
    const document = await parseJsonObject(response);
    if (document["issuer"] !== this.config.issuer) {
      throw new SsoProtocolError("discovery-issuer-mismatch");
    }
    const value: SsoProviderMetadata = {
      authorizationEndpoint: endpoint(document["authorization_endpoint"]),
      tokenEndpoint: endpoint(document["token_endpoint"]),
      jwksUri: endpoint(document["jwks_uri"]),
    };
    this.metadata = { value, fetchedAt: now };
    return value;
  }

  private async jwks(force = false): Promise<JsonWebKeySet> {
    const cached = this.keySet;
    const now = Date.now();
    if (
      !force &&
      cached !== undefined &&
      now - cached.fetchedAt < this.ttlMs()
    ) {
      return cached.value;
    }
    const metadata = await this.providerMetadata();
    const response = await this.request(metadata.jwksUri, {
      method: "GET",
      headers: { accept: JSON_WEB_KEY_SET_TYPE },
    });
    if (!response.ok) {
      throw new SsoProtocolError(`jwks-${response.status}`);
    }
    const document = await parseJsonObject(response);
    const keys = document["keys"];
    if (!Array.isArray(keys)) {
      throw new SsoProtocolError("malformed-jwks");
    }
    const value: JsonWebKeySet = {
      keys: keys.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      ),
    };
    this.keySet = { value, fetchedAt: now };
    return value;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      throw new SsoProtocolError("idp-unreachable");
    }
  }

  private ttlMs(): number {
    return this.config.discoveryTtlSeconds * 1000;
  }
}

function selectSigningKey(
  keySet: JsonWebKeySet,
  kid: string | undefined,
): Record<string, unknown> | undefined {
  const rsaKeys = keySet.keys.filter(
    (key) => key["kty"] === "RSA" && key["use"] !== "enc",
  );
  if (kid !== undefined) {
    // 声明了 kid 时只接受精确匹配，让调用方刷新 JWKS 而不是回落到别的密钥。
    return rsaKeys.find((key) => key["kid"] === kid);
  }
  // 未声明 kid 时只接受唯一 RSA 签名密钥，出现歧义一律拒绝。
  return rsaKeys.length === 1 ? rsaKeys[0] : undefined;
}

function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SsoProtocolError("discovery-missing-endpoint");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SsoProtocolError("discovery-invalid-endpoint");
  }
  if (parsed.protocol !== "https:") {
    throw new SsoProtocolError("discovery-insecure-endpoint");
  }
  return value;
}

function audienceMatches(value: unknown, clientId: string): boolean {
  if (typeof value === "string") {
    return value === clientId;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => entry === clientId);
  }
  return false;
}

function numericClaim(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function groupsClaim(value: unknown): readonly string[] | null {
  if (value === undefined) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new SsoProtocolError("id-token-groups-invalid");
  }
  // 保留 Casdoor 原始路径，不在这里裁剪或改写大小写。
  return [...value] as string[];
}

function stringClaim(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function decodeJsonObject(
  part: string,
  reason: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new SsoProtocolError(reason);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SsoProtocolError) {
      throw error;
    }
    throw new SsoProtocolError(reason);
  }
}

async function parseJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new SsoProtocolError("malformed-response");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SsoProtocolError) {
      throw error;
    }
    throw new SsoProtocolError("malformed-response");
  }
}
