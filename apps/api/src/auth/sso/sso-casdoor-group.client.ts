import type { SsoConfig } from "./sso.config.js";

import {
  normalizeCasdoorGroupPaths,
  type CasdoorGroupPath,
} from "../../organizations/casdoor-group-path.js";

export class SsoGroupMetadataError extends Error {
  constructor(readonly reason: string) {
    super(`SSO group metadata failure: ${reason}`);
    this.name = "SsoGroupMetadataError";
  }
}

interface CasdoorGroupRecord {
  readonly type: "Physical" | "Virtual";
  readonly isEnabled: boolean;
}

export class SsoCasdoorGroupClient {
  constructor(
    private readonly config: SsoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolvePhysicalGroups(
    groups: readonly string[],
  ): Promise<readonly string[]> {
    const physicalGroups: string[] = [];
    for (const group of normalizeCasdoorGroupPaths(groups)) {
      const record = await this.getGroup(group);
      if (record.type === "Virtual") {
        continue;
      }
      if (record.isEnabled) {
        physicalGroups.push(group.path);
      }
    }
    return physicalGroups;
  }

  private async getGroup(group: CasdoorGroupPath): Promise<CasdoorGroupRecord> {
    const endpoint = new URL("api/get-group", `${this.config.issuer}/`);
    endpoint.searchParams.set("id", `${group.owner}/${group.name}`);

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: this.authorizationHeader(),
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      throw new SsoGroupMetadataError("idp-unreachable");
    }
    if (!response.ok) {
      throw new SsoGroupMetadataError(`group-${response.status}`);
    }

    const payload = await parseJsonObject(response);
    if (payload["status"] !== "ok") {
      throw new SsoGroupMetadataError("status-error");
    }
    const record = payload["data"];
    if (!isRecord(record)) {
      throw new SsoGroupMetadataError("missing-group");
    }
    return validateRecord(record, group);
  }

  /**
   * Casdoor 的 AutoSigninFilter 接受 application clientId/clientSecret 的 HTTP
   * Basic 认证。这里只查询已验签 claim 引用的单个群组；Client Secret 只进入
   * 请求头，不缓存、不落库、不写日志。
   */
  private authorizationHeader(): string {
    const credentials = `${this.config.clientId}:${this.config.clientSecret}`;
    return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  }
}

function validateRecord(
  record: Readonly<Record<string, unknown>>,
  group: CasdoorGroupPath,
): CasdoorGroupRecord {
  const owner = record["owner"];
  const name = record["name"];
  const type = record["type"];
  const isTopGroup = record["isTopGroup"];
  const isEnabled = record["isEnabled"];
  const parentId = record["parentId"];
  if (
    owner !== group.owner ||
    name !== group.name ||
    typeof isTopGroup !== "boolean" ||
    typeof isEnabled !== "boolean" ||
    typeof parentId !== "string"
  ) {
    throw new SsoGroupMetadataError("group-mismatch");
  }
  if (type !== "Physical" && type !== "Virtual") {
    throw new SsoGroupMetadataError("group-type-invalid");
  }
  const expectedTopGroup = group.depth === 2;
  if (isTopGroup !== expectedTopGroup) {
    throw new SsoGroupMetadataError("group-parent-mismatch");
  }
  if (
    (expectedTopGroup && parentId !== group.owner) ||
    (!expectedTopGroup && parentId !== group.parentPath!.split("/").at(-1))
  ) {
    throw new SsoGroupMetadataError("group-parent-mismatch");
  }
  return { type, isEnabled };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) {
      throw new SsoGroupMetadataError("malformed-response");
    }
    return parsed;
  } catch (error) {
    if (error instanceof SsoGroupMetadataError) {
      throw error;
    }
    throw new SsoGroupMetadataError("malformed-response");
  }
}
