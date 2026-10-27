import type { SsoConfig } from "./sso.config.js";

const MAX_ROLES = 100;
const MAX_PRINCIPALS = 1000;

export class SsoCasdoorPermissionError extends Error {
  constructor(readonly reason: string) {
    super("Casdoor permission failure: " + reason);
    this.name = "SsoCasdoorPermissionError";
  }
}

/** 只表达 Casdoor 导入候选范围，不映射为任何 InPulse 授权。 */
export interface CasdoorPermissionScope {
  readonly groupIds: ReadonlySet<string>;
  readonly userIds: ReadonlySet<string>;
}

interface CasdoorPrincipalRecord {
  readonly owner: string;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  readonly users: readonly string[];
  readonly effect: string | undefined;
  readonly state: string | undefined;
}

/**
 * ADR-101：读取指定 Casdoor Permission 直接与角色继承的群组、用户，
 * 供管理员批量导入在目录读取阶段收窄候选账号。Client Secret 只进入
 * HTTP Basic 请求头，不落库、不写日志，也不改变 InPulse 权限判断。
 */
export class SsoCasdoorPermissionClient {
  constructor(
    private readonly config: SsoConfig,
    private readonly permissionName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolveScope(organization: string): Promise<CasdoorPermissionScope> {
    const permissionId = organization + "/" + this.permissionName;
    const permission = await this.loadRecord("permission", permissionId);
    if (!permission.isEnabled) {
      throw new SsoCasdoorPermissionError("permission-disabled");
    }
    if (permission.effect !== "Allow") {
      throw new SsoCasdoorPermissionError("permission-effect-not-allow");
    }
    if (permission.state !== "Approved") {
      throw new SsoCasdoorPermissionError("permission-state-not-approved");
    }

    const groups = new Set<string>();
    const users = new Set<string>();
    this.addPrincipals(groups, users, permission, organization);

    const pendingRoles = [...permission.roles];
    const visitedRoles = new Set<string>();
    while (pendingRoles.length > 0) {
      const roleId = pendingRoles.shift()!;
      if (visitedRoles.has(roleId)) continue;
      if (visitedRoles.size >= MAX_ROLES) {
        throw new SsoCasdoorPermissionError("roles-too-many");
      }
      visitedRoles.add(roleId);
      const role = await this.loadRecord("role", roleId);
      if (!role.isEnabled) continue;
      this.addPrincipals(groups, users, role, organization);
      pendingRoles.push(...role.roles);
      if (groups.size + users.size > MAX_PRINCIPALS) {
        throw new SsoCasdoorPermissionError("principals-too-many");
      }
    }

    if (groups.size === 0 && users.size === 0) {
      throw new SsoCasdoorPermissionError("permission-empty");
    }
    return { groupIds: groups, userIds: users };
  }

  private addPrincipals(
    groups: Set<string>,
    users: Set<string>,
    record: CasdoorPrincipalRecord,
    organization: string,
  ): void {
    for (const groupId of record.groups) {
      groups.add(this.requireOwnedResource(groupId, organization));
    }
    for (const userId of record.users) {
      users.add(this.requireOwnedResource(userId, organization));
    }
    for (const roleId of record.roles) {
      this.requireOwnedResource(roleId, organization);
    }
    if (groups.size + users.size > MAX_PRINCIPALS) {
      throw new SsoCasdoorPermissionError("principals-too-many");
    }
  }

  private requireOwnedResource(value: string, organization: string): string {
    const normalized = value.trim();
    const prefix = organization + "/";
    if (
      normalized.length <= prefix.length ||
      !normalized.startsWith(prefix) ||
      normalized.slice(prefix.length).includes("/")
    ) {
      throw new SsoCasdoorPermissionError("resource-owner-mismatch");
    }
    return normalized;
  }

  private async loadRecord(
    kind: "permission" | "role",
    resourceId: string,
  ): Promise<CasdoorPrincipalRecord> {
    const endpoint = new URL("api/get-" + kind, this.config.issuer + "/");
    endpoint.searchParams.set("id", resourceId);

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
      throw new SsoCasdoorPermissionError("idp-unreachable");
    }
    if (response.status === 404) {
      throw new SsoCasdoorPermissionError(kind + "-missing");
    }
    if (!response.ok) {
      throw new SsoCasdoorPermissionError(kind + "-" + response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SsoCasdoorPermissionError("malformed-response");
    }
    if (!isRecord(payload) || payload["status"] !== "ok") {
      throw new SsoCasdoorPermissionError("status-error");
    }
    if (!isRecord(payload["data"])) {
      throw new SsoCasdoorPermissionError("malformed-response");
    }
    return toPrincipalRecord(payload["data"], resourceId, kind);
  }

  private authorizationHeader(): string {
    return (
      "Basic " +
      Buffer.from(
        this.config.clientId + ":" + this.config.clientSecret,
        "utf8",
      ).toString("base64")
    );
  }
}

function toPrincipalRecord(
  value: Readonly<Record<string, unknown>>,
  resourceId: string,
  kind: "permission" | "role",
): CasdoorPrincipalRecord {
  const owner = requireString(value["owner"], kind + "-owner", 100);
  const name = requireString(value["name"], kind + "-name", 100);
  if (owner + "/" + name !== resourceId) {
    throw new SsoCasdoorPermissionError(kind + "-mismatch");
  }
  if (typeof value["isEnabled"] !== "boolean") {
    throw new SsoCasdoorPermissionError(kind + "-enabled-invalid");
  }
  return {
    owner,
    name,
    isEnabled: value["isEnabled"],
    roles: stringArray(value["roles"], kind + "-roles"),
    groups: stringArray(value["groups"], kind + "-groups"),
    users: stringArray(value["users"], kind + "-users"),
    effect: optionalString(value["effect"], kind + "-effect"),
    state: optionalString(value["state"], kind + "-state"),
  };
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new SsoCasdoorPermissionError(field + "-invalid");
  }
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = optionalString(value, field);
  if (normalized === undefined || normalized.length > maxLength) {
    throw new SsoCasdoorPermissionError(field + "-invalid");
  }
  return normalized;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SsoCasdoorPermissionError(field + "-invalid");
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
