export type OrganizationErrorReason =
  "not-found" | "version-conflict" | "name-conflict" | "sso-managed";

/** ADR-081 组织管理业务错误；HTTP 层按 status / code 映射统一错误体。 */
export class OrganizationError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly reason: OrganizationErrorReason,
  ) {
    super(message);
    this.name = "OrganizationError";
  }
}

/** update / delete 的组织不存在返回 404；assign 的目标组织不存在返回 422。 */
export function organizationNotFound(
  status: 404 | 422 = 404,
): OrganizationError {
  return new OrganizationError(
    status,
    "ORGANIZATION_NOT_FOUND",
    "组织不存在",
    "not-found",
  );
}

export function organizationVersionConflict(): OrganizationError {
  return new OrganizationError(
    409,
    "ORGANIZATION_VERSION_CONFLICT",
    "组织已在其他窗口被修改，请重新加载后再操作",
    "version-conflict",
  );
}

export function organizationSsoManaged(): OrganizationError {
  return new OrganizationError(
    409,
    "ORGANIZATION_SSO_MANAGED",
    "Casdoor 组织与 SSO 用户的组织归属由统一身份自动同步，不能手工调整",
    "sso-managed",
  );
}

export function organizationNameConflict(): OrganizationError {
  return new OrganizationError(
    409,
    "ORGANIZATION_NAME_CONFLICT",
    "组织名称已存在",
    "name-conflict",
  );
}
