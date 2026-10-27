import { normalizeCasdoorGroupPaths } from "../../organizations/casdoor-group-path.js";
import type { SsoConfig } from "./sso.config.js";

const PAGE_SIZE = 100;
const MAX_USERS = 1000;
const MAX_GROUP_PATHS = 100;

export class SsoCasdoorDirectoryError extends Error {
  constructor(readonly reason: string) {
    super(`Casdoor directory failure: ${reason}`);
    this.name = "SsoCasdoorDirectoryError";
  }
}

/** 仅在内存中存在的脱敏目录条目；不包含 password、salt、token 或 Roles。 */
export interface CasdoorDirectoryUser {
  readonly casdoorId: string;
  readonly loginName: string;
  readonly displayName: string;
  readonly email: string | null;
  /** 只保留配置组织下、通过路径校验的组；Physical 判定在 Import Service 中完成。 */
  readonly groups: readonly string[];
}

export interface CasdoorDirectorySnapshot {
  readonly organization: string;
  readonly fetchedAt: Date;
  readonly users: readonly CasdoorDirectoryUser[];
}

/**
 * Casdoor 用户目录只读客户端（ADR-100）。
 *
 * 使用与 SSO 相同的 application clientId/clientSecret 做 HTTP Basic，
 * 只获取 `/api/get-users` 的必要字段白名单。原始响应、密码、密码盐、
 * accessToken 等字段在解析后立即丢弃，不落库、不写审计、不写日志。
 */
export class SsoCasdoorDirectoryClient {
  constructor(
    private readonly config: SsoConfig,
    private readonly organization: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async load(): Promise<CasdoorDirectorySnapshot> {
    const organization = normalizeOrganization(this.organization);
    const fetchedAt = new Date();
    const rawUsers: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();

    for (let page = 1; page <= MAX_USERS / PAGE_SIZE + 1; page += 1) {
      const rows = await this.getUsersPage(organization, page);
      if (
        rawUsers.length + rows.length > MAX_USERS &&
        (rows.length > 0 || rawUsers.length >= MAX_USERS)
      ) {
        throw new SsoCasdoorDirectoryError("directory-too-large");
      }
      let added = 0;
      for (const row of rows) {
        const id = requireString(row["id"], "id", 200);
        if (seenIds.has(id)) {
          throw new SsoCasdoorDirectoryError("duplicate-user-id");
        }
        seenIds.add(id);
        rawUsers.push(row);
        added += 1;
      }
      if (rows.length < PAGE_SIZE) break;
      if (added === 0) {
        throw new SsoCasdoorDirectoryError("pagination-stalled");
      }
      if (rawUsers.length === MAX_USERS) {
        const next = await this.getUsersPage(organization, page + 1);
        if (next.length > 0) {
          throw new SsoCasdoorDirectoryError("directory-too-large");
        }
        break;
      }
    }

    const users = rawUsers
      .filter((row) => !isInactiveRecord(row))
      .map((row) => toDirectoryUser(row, organization))
      .sort((left, right) => left.loginName.localeCompare(right.loginName));

    const loginNames = new Set<string>();
    for (const user of users) {
      const key = user.loginName.toLocaleLowerCase();
      if (loginNames.has(key)) {
        throw new SsoCasdoorDirectoryError("duplicate-login-name");
      }
      loginNames.add(key);
    }
    if (users.length > MAX_USERS) {
      throw new SsoCasdoorDirectoryError("directory-too-large");
    }

    return { organization, fetchedAt, users };
  }

  private async getUsersPage(
    organization: string,
    page: number,
  ): Promise<readonly Record<string, unknown>[]> {
    const endpoint = new URL("api/get-users", `${this.config.issuer}/`);
    endpoint.searchParams.set("owner", organization);
    endpoint.searchParams.set("pageSize", String(PAGE_SIZE));
    endpoint.searchParams.set("p", String(page));

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(
            `${this.config.clientId}:${this.config.clientSecret}`,
            "utf8",
          ).toString("base64")}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      throw new SsoCasdoorDirectoryError("idp-unreachable");
    }
    if (!response.ok) {
      throw new SsoCasdoorDirectoryError(`directory-${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SsoCasdoorDirectoryError("malformed-response");
    }
    if (!isRecord(payload) || payload["status"] !== "ok") {
      throw new SsoCasdoorDirectoryError("status-error");
    }
    const data = payload["data"];
    if (data === null) return [];
    if (!Array.isArray(data) || !data.every(isRecord)) {
      throw new SsoCasdoorDirectoryError("malformed-response");
    }
    return data;
  }
}

function normalizeOrganization(value: string | undefined): string {
  const organization = value?.trim() ?? "";
  if (organization.length === 0) {
    throw new SsoCasdoorDirectoryError("not-configured");
  }
  if (
    organization.length > 100 ||
    organization.includes("/") ||
    organization !== organization.trim()
  ) {
    throw new SsoCasdoorDirectoryError("organization-invalid");
  }
  return organization;
}

function toDirectoryUser(
  row: Readonly<Record<string, unknown>>,
  organization: string,
): CasdoorDirectoryUser {
  const casdoorId = requireString(row["id"], "id", 200);
  const loginName = requireString(row["name"], "name", 100);
  const displayName = requireString(
    optionalString(row["displayName"]) ?? loginName,
    "displayName",
    200,
  );
  const rawEmail = optionalString(row["email"]);
  const email =
    rawEmail === undefined || rawEmail.length === 0 ? null : rawEmail;
  if (email !== null && email.length > 320) {
    throw new SsoCasdoorDirectoryError("email-invalid");
  }

  const rawGroups = row["groups"];
  if (
    rawGroups !== undefined &&
    rawGroups !== null &&
    !Array.isArray(rawGroups)
  ) {
    throw new SsoCasdoorDirectoryError("groups-invalid");
  }
  const groupValues = (rawGroups ?? []) as unknown[];
  if (!groupValues.every((value) => typeof value === "string")) {
    throw new SsoCasdoorDirectoryError("groups-invalid");
  }
  const ownerPrefix = `${organization}/`;
  const organizationGroups = [
    ...new Set(
      (groupValues as string[]).filter((value) =>
        value.startsWith(ownerPrefix),
      ),
    ),
  ];
  if (organizationGroups.length > MAX_GROUP_PATHS) {
    throw new SsoCasdoorDirectoryError("groups-too-many");
  }
  let groups: readonly string[];
  try {
    groups = normalizeCasdoorGroupPaths(organizationGroups).map(
      (group) => group.path,
    );
  } catch {
    throw new SsoCasdoorDirectoryError("groups-invalid");
  }

  return { casdoorId, loginName, displayName, email, groups };
}

function isInactiveRecord(row: Readonly<Record<string, unknown>>): boolean {
  const isForbidden = row["isForbidden"];
  const isDeleted = row["isDeleted"];
  if (isForbidden !== undefined && typeof isForbidden !== "boolean") {
    throw new SsoCasdoorDirectoryError("forbidden-state-invalid");
  }
  if (isDeleted !== undefined && typeof isDeleted !== "boolean") {
    throw new SsoCasdoorDirectoryError("deleted-state-invalid");
  }
  if (isForbidden === true || isDeleted === true) return true;

  const deletedTime = row["deletedTime"];
  if (
    deletedTime !== undefined &&
    deletedTime !== null &&
    typeof deletedTime !== "string"
  ) {
    throw new SsoCasdoorDirectoryError("deleted-time-invalid");
  }
  const normalized = typeof deletedTime === "string" ? deletedTime.trim() : "";
  return (
    normalized.length > 0 &&
    !normalized.startsWith("0001-01-01") &&
    !normalized.startsWith("1970-01-01")
  );
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = optionalString(value);
  if (normalized === undefined || normalized.length > maxLength) {
    throw new SsoCasdoorDirectoryError(`${field}-invalid`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SsoCasdoorDirectoryError("field-type-invalid");
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
