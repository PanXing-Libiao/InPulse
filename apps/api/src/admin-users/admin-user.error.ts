export type AdminUserErrorReason =
  | "not-found"
  | "state-conflict"
  | "version-conflict"
  | "self-mutation"
  | "last-active-admin"
  | "open-tasks"
  | "active-project-membership"
  | "offboarding";

export class AdminUserError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly reason: AdminUserErrorReason,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AdminUserError";
  }
}

export function adminUserNotFound(): AdminUserError {
  return new AdminUserError(
    404,
    "ADMIN_USER_NOT_FOUND",
    "用户不存在",
    "not-found",
  );
}

export function adminUserStateConflict(): AdminUserError {
  return new AdminUserError(
    409,
    "ADMIN_USER_STATE_CONFLICT",
    "用户当前状态不允许此操作",
    "state-conflict",
  );
}

export function adminUserVersionConflict(): AdminUserError {
  return new AdminUserError(
    409,
    "ADMIN_USER_VERSION_CONFLICT",
    "用户已在其他窗口被修改，请重新加载后再操作",
    "version-conflict",
  );
}

export function adminUserSelfMutation(): AdminUserError {
  return new AdminUserError(
    409,
    "ADMIN_USER_SELF_MUTATION_REJECTED",
    "不能对当前管理员自己执行停用、降级、删除或强制退出",
    "self-mutation",
  );
}

export function adminUserActiveProjectMembership(): AdminUserError {
  return new AdminUserError(
    409,
    "ADMIN_USER_ACTIVE_PROJECT_MEMBERSHIP",
    "该用户仍是项目活跃成员，请先转移组长身份并把该账号移出全部项目后再删除",
    "active-project-membership",
  );
}

export function lastActiveAdmin(): AdminUserError {
  return new AdminUserError(
    409,
    "LAST_ACTIVE_ADMIN_REQUIRED",
    "不能移除或停用最后一名可用管理员，请先指定另一名管理员",
    "last-active-admin",
  );
}

/** 停用交接清单与服务端实时任务不一致：要求刷新后重新处理。 */
export function adminUserOffboardingConflict(
  code: string,
  message: string,
): AdminUserError {
  return new AdminUserError(409, code, message, "offboarding");
}

/** 停用交接动作不合法（例如唯一负责人任务没有接手人）。 */
export function adminUserOffboardingInvalid(
  code: string,
  message: string,
): AdminUserError {
  return new AdminUserError(422, code, message, "offboarding");
}

/** 停用交接引用了已被删除或不再属于该账号的任务。 */
export function adminUserOffboardingTaskNotFound(): AdminUserError {
  return new AdminUserError(
    404,
    "ADMIN_USER_OFFBOARDING_TASK_NOT_FOUND",
    "待交接任务不存在或已不再由该账号负责",
    "offboarding",
  );
}
