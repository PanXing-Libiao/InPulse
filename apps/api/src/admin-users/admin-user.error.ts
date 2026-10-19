export type AdminUserErrorReason =
  | "not-found"
  | "state-conflict"
  | "version-conflict"
  | "self-mutation"
  | "last-active-admin"
  | "open-tasks"
  | "active-project-membership";

export class AdminUserError extends Error {
  constructor(
    readonly status: 404 | 409,
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

export function adminUserOpenTasks(openTaskCount: number): AdminUserError {
  return new AdminUserError(
    409,
    "ADMIN_USER_HAS_OPEN_TASKS",
    "该账号仍有未完成任务，请先转分配或删除任务后再停用",
    "open-tasks",
    { openTaskCount },
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
