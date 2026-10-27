import type { SsoConfig } from "./sso.config.js";

import {
  normalizeCasdoorGroupPaths,
  type CasdoorGroupPath,
} from "../../organizations/casdoor-group-path.js";

const PAGE_SIZE = 100;
const MAX_GROUPS = 1000;
const MAX_GROUP_DEPTH = 20;

export class SsoGroupMetadataError extends Error {
  constructor(readonly reason: string) {
    super("SSO group metadata failure: " + reason);
    this.name = "SsoGroupMetadataError";
  }
}

interface CasdoorGroupRecord {
  readonly owner: string;
  readonly name: string;
  readonly type: "Physical" | "Virtual";
  readonly isEnabled: boolean;
  readonly isTopGroup: boolean;
  readonly parentId: string;
}

interface CasdoorGroupCatalog {
  readonly byName: ReadonlyMap<string, CasdoorGroupRecord>;
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

  /**
   * ADR-100 管理员批量导入专用：Casdoor 用户对象的 groups 保存 owner/name
   * 主键，而不是层级路径。先一次读取本组织群组目录，再按 parentId 还原完整
   * 路径，只把启用中的 Physical 直接组交给组织同步；Virtual、停用与已从
   * Casdoor 目录消失的陈旧引用不建立成员关系。
   */
  async resolvePhysicalImportGroups(
    organization: string,
    groups: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const directGroups = normalizeCasdoorGroupPaths(groups);
    for (const group of directGroups) {
      if (group.owner !== organization) {
        throw new SsoGroupMetadataError("group-owner-mismatch");
      }
    }

    const catalog = await this.loadGroupCatalog(organization);
    const pathCache = new Map<string, string>();
    const physicalGroups = new Map<string, string>();
    for (const direct of directGroups) {
      const record = catalog.byName.get(direct.name);
      if (record === undefined) continue;
      if (record.type !== "Physical" || !record.isEnabled) continue;
      physicalGroups.set(
        direct.path,
        resolveGroupPath(
          record,
          catalog,
          organization,
          pathCache,
          new Set<string>(),
        ),
      );
    }
    return physicalGroups;
  }

  private async loadGroupCatalog(
    organization: string,
  ): Promise<CasdoorGroupCatalog> {
    const byName = new Map<string, CasdoorGroupRecord>();
    for (let page = 1; page <= MAX_GROUPS / PAGE_SIZE + 1; page += 1) {
      const rows = await this.getGroupsPage(organization, page);
      if (
        byName.size + rows.length > MAX_GROUPS &&
        (rows.length > 0 || byName.size >= MAX_GROUPS)
      ) {
        throw new SsoGroupMetadataError("group-directory-too-large");
      }
      let added = 0;
      for (const row of rows) {
        const record = toGroupRecord(row, organization);
        if (byName.has(record.name)) {
          throw new SsoGroupMetadataError("duplicate-group-name");
        }
        byName.set(record.name, record);
        added += 1;
      }
      if (rows.length < PAGE_SIZE) break;
      if (added === 0) {
        throw new SsoGroupMetadataError("group-pagination-stalled");
      }
      if (byName.size === MAX_GROUPS) {
        const next = await this.getGroupsPage(organization, page + 1);
        if (next.length > 0) {
          throw new SsoGroupMetadataError("group-directory-too-large");
        }
        break;
      }
    }
    return { byName };
  }

  private async getGroupsPage(
    organization: string,
    page: number,
  ): Promise<readonly Record<string, unknown>[]> {
    const endpoint = new URL("api/get-groups", this.config.issuer + "/");
    endpoint.searchParams.set("owner", organization);
    endpoint.searchParams.set("pageSize", String(PAGE_SIZE));
    endpoint.searchParams.set("p", String(page));

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
      throw new SsoGroupMetadataError("group-" + response.status);
    }

    const payload = await parseJsonObject(response);
    if (payload["status"] !== "ok") {
      throw new SsoGroupMetadataError("status-error");
    }
    const data = payload["data"];
    if (data === null) return [];
    if (!Array.isArray(data) || !data.every(isRecord)) {
      throw new SsoGroupMetadataError("malformed-response");
    }
    return data;
  }

  private async getGroup(group: CasdoorGroupPath): Promise<CasdoorGroupRecord> {
    const endpoint = new URL("api/get-group", this.config.issuer + "/");
    endpoint.searchParams.set("id", group.owner + "/" + group.name);

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
      throw new SsoGroupMetadataError("group-" + response.status);
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
   * Basic 认证。这里只查询已验签 claim 引用的单个群组或管理员导入所需的
   * 本组织群组目录；Client Secret 只进入请求头，不缓存、不落库、不写日志。
   */
  private authorizationHeader(): string {
    const credentials = this.config.clientId + ":" + this.config.clientSecret;
    return "Basic " + Buffer.from(credentials, "utf8").toString("base64");
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
  return { owner, name, type, isEnabled, isTopGroup, parentId };
}

function toGroupRecord(
  row: Readonly<Record<string, unknown>>,
  organization: string,
): CasdoorGroupRecord {
  const owner = requireExactString(row["owner"], "group-owner", 100);
  const name = requireExactString(row["name"], "group-name", 100);
  const type = row["type"];
  const isEnabled = row["isEnabled"];
  const isTopGroup = row["isTopGroup"];
  const parentId = requireExactString(row["parentId"], "group-parent", 200);
  if (owner !== organization) {
    throw new SsoGroupMetadataError("group-owner-mismatch");
  }
  if (name.includes("/")) {
    throw new SsoGroupMetadataError("group-name-invalid");
  }
  if (type !== "Physical" && type !== "Virtual") {
    throw new SsoGroupMetadataError("group-type-invalid");
  }
  if (typeof isEnabled !== "boolean" || typeof isTopGroup !== "boolean") {
    throw new SsoGroupMetadataError("group-state-invalid");
  }
  return { owner, name, type, isEnabled, isTopGroup, parentId };
}

function resolveGroupPath(
  record: CasdoorGroupRecord,
  catalog: CasdoorGroupCatalog,
  organization: string,
  cache: Map<string, string>,
  stack: Set<string>,
): string {
  const cached = cache.get(record.name);
  if (cached !== undefined) return cached;
  if (stack.has(record.name)) {
    throw new SsoGroupMetadataError("group-parent-cycle");
  }
  if (stack.size >= MAX_GROUP_DEPTH) {
    throw new SsoGroupMetadataError("group-depth-invalid");
  }
  stack.add(record.name);

  let path: string;
  if (record.isTopGroup) {
    if (record.parentId !== organization) {
      throw new SsoGroupMetadataError("group-parent-mismatch");
    }
    path = organization + "/" + record.name;
  } else {
    const parent = catalog.byName.get(record.parentId);
    if (parent === undefined) {
      throw new SsoGroupMetadataError("group-parent-missing");
    }
    path =
      resolveGroupPath(parent, catalog, organization, cache, stack) +
      "/" +
      record.name;
  }

  try {
    normalizeCasdoorGroupPaths([path]);
  } catch {
    throw new SsoGroupMetadataError("group-path-invalid");
  }
  cache.set(record.name, path);
  stack.delete(record.name);
  return path;
}

function requireExactString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new SsoGroupMetadataError(field + "-invalid");
  }
  return value;
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
