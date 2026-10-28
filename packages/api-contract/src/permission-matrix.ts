/**
 * ADR-019：Route Registry 与可执行权限矩阵一一对应。
 * 身份集合必须与 docs/permissions.md 的“身份定义”表精确相等，
 * 由 checkPermissionMatrix 在 CI 中跨文档与代码校验。
 */
export const permissionIdentities = [
  "匿名",
  "活跃成员",
  "其他项目成员",
  "已移除成员",
  "停用用户",
  "系统管理员",
] as const;

export type PermissionIdentity = (typeof permissionIdentities)[number];

export type DenyStatus = 401 | 403 | 404 | 409;

/**
 * allow：该身份可执行；deny：该身份被拒绝并返回固定状态码；
 * conditional：存在明确前置条件，条件不满足时必须返回 deniedWith。
 * 测试矩阵 AUTHZ-001 要求每条路由至少一条允许与一条拒绝用例。
 */
export type MatrixOutcome =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly status: DenyStatus }
  | {
      readonly kind: "conditional";
      readonly allowedWhen: string;
      readonly deniedWith: DenyStatus;
    };

export interface PermissionMatrixEntry {
  readonly operationId: string;
  readonly outcomes: Readonly<Record<PermissionIdentity, MatrixOutcome>>;
}

/**
 * 只登记已在 Route Registry 中注册的操作。authPolicy 为 none 的运维探针
 * 对全部身份开放，其“拒绝用例”由 checkPermissionMatrix 按 authPolicy 豁免，
 * 不得据此放宽任何业务或认证路由。
 */
export const permissionMatrix = [
  {
    operationId: "listTaskCenter",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "mine/created/project 且 SQL 仅返回当前授权项目；all 仅管理员",
        deniedWith: 403,
      },
      其他项目成员: {
        kind: "conditional",
        allowedWhen: "仅返回其余可访问项目，all 仅管理员",
        deniedWith: 403,
      },
      已移除成员: {
        kind: "conditional",
        allowedWhen: "已移除项目不返回，all 仅管理员",
        deniedWith: 403,
      },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },

  ...["listExternalLinks", "addExternalLink", "removeExternalLink"].map(
    (operationId): PermissionMatrixEntry => ({
      operationId,
      outcomes: {
        匿名: { kind: "deny", status: 401 },
        活跃成员: {
          kind: "conditional",
          allowedWhen: "目标当前可读；写入另需目标和父级可写及当前版本",
          deniedWith: 404,
        },
        其他项目成员: { kind: "deny", status: 404 },
        已移除成员: { kind: "deny", status: 404 },
        停用用户: { kind: "deny", status: 401 },
        系统管理员: {
          kind: "conditional",
          allowedWhen: "目标存在；VOID只读，写入需目标和父级可写",
          deniedWith: 404,
        },
      },
    }),
  ),

  ...(["voidChangeRecord", "restoreChangeRecord"] as const).map(
    (operationId): PermissionMatrixEntry => ({
      operationId,
      outcomes: {
        匿名: { kind: "deny", status: 401 },
        活跃成员: { kind: "deny", status: 403 },
        其他项目成员: { kind: "deny", status: 403 },
        已移除成员: { kind: "deny", status: 403 },
        停用用户: { kind: "deny", status: 401 },
        系统管理员: {
          kind: "conditional",
          allowedWhen: "完整管理员 Session",
          deniedWith: 403,
        },
      },
    }),
  ),
  ...(["listModules", "createModule", "updateModule"] as const).map(
    (operationId): PermissionMatrixEntry => ({
      operationId,
      outcomes: {
        匿名: { kind: "deny", status: 401 },
        活跃成员: { kind: "allow" },
        其他项目成员: { kind: "deny", status: 404 },
        已移除成员: { kind: "deny", status: 404 },
        停用用户: { kind: "deny", status: 401 },
        系统管理员: { kind: "allow" },
      },
    }),
  ),
  // ADR-059：模块与功能删除按 ADR-039 的例外收窄到系统管理员或本项目 ACTIVE 组长，
  // 其余活跃成员 403，非成员与已移除成员 404。
  ...(["deleteModule", "deleteFeature"] as const).map(
    (operationId): PermissionMatrixEntry => ({
      operationId,
      outcomes: {
        匿名: { kind: "deny", status: 401 },
        活跃成员: {
          kind: "conditional",
          allowedWhen: "本项目 ACTIVE 组长（LEADER）",
          deniedWith: 403,
        },
        其他项目成员: { kind: "deny", status: 404 },
        已移除成员: { kind: "deny", status: 404 },
        停用用户: { kind: "deny", status: 401 },
        系统管理员: { kind: "allow" },
      },
    }),
  ),
  ...(
    [
      "listFeatures",
      "listRecordDrafts",
      "listChangeRecords",
      "getChangeRecord",
      "listChangeRecordVersions",
      "getChangeRecordVersion",
      "publishChangeRecord",
      "completeTask",
      "convertLeftoverToTask",
      "previewLeftoverTask",
      "getLeftoverTaskSource",
      "createChangeRecordVersion",
      "addChangeRecordLeftover",
      "getTaskRecordDrafts",
      "createTaskRecordDraft",
      "updateTaskRecordDraft",
      "getRecordDraft",
      "createIndependentRecordDraft",
      "updateIndependentRecordDraft",
      "deleteRecordDraft",
      "listTasks",
      "getTask",
      "listTaskAssignees",
      "listActiveProjectMembers",
      "createTaskWithScope",
      "createTask",
      "updateTask",
      "listModuleTasks",
      "getModuleTask",
      "listModuleTaskAssignees",
      "createModuleTask",
      "updateModuleTask",
      "getTaskStatusHistory",
      "getModuleTaskStatusHistory",
      "mergeTaskGroup",
      "unmergeTaskGroup",
      "transitionTask",
      "transitionModuleTask",
      "deleteTask",
      "deleteModuleTask",
      "getFeature",
      "findSimilarFeatures",
      "createFeature",
      "updateFeature",
    ] as const
  ).map((operationId): PermissionMatrixEntry => ({
    operationId,
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  })),
  {
    operationId: "getHealth",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getHealthLive",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getHealthReady",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "issueCsrfToken",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "login",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "logout",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "startSsoLogin",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "completeSsoLogin",
    outcomes: {
      匿名: { kind: "allow" },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "allow" },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getCurrentUser",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getUserDirectory",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getMyOrganizationMembers",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  ...(
    [
      "listOrganizations",
      "createOrganization",
      "updateOrganization",
      "deleteOrganization",
      "assignUsersOrganization",
    ] as const
  ).map((operationId): PermissionMatrixEntry => ({
    operationId,
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  })),
  {
    operationId: "getAdminUserOffboarding",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "previewCasdoorUserImport",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整管理员 Session；实时读取配置的 Casdoor 组织目录，只返回脱敏身份与 Physical 组预览；响应 no-store，不需要 CSRF 或幂等键",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "importCasdoorUsers",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整管理员 Session；CSRF 与 Idempotency-Key 必填；按所选 Casdoor 标识重新读取当前目录，只创建无口令非管理员账号或按既有身份规则绑定，并同步 Physical 组织；不自动停用、删除或重新启用平台账号；目录故障 503，预览后目录变化 409，身份冲突逐账号跳过并写单条批次审计",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "listAdminUsers",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  ...(
    [
      "createUser",
      "updateUser",
      "disableUser",
      "enableUser",
      "deleteUser",
    ] as const
  ).map((operationId): PermissionMatrixEntry => ({
    operationId,
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；删除前目标必须已停用且没有任何活跃项目成员关系；移除或停用管理员时仍须保留至少一名可用管理员，且禁止自移除/自停用/自删除",
        deniedWith: 403,
      },
    },
  })),
  {
    operationId: "getAiAssistSettings",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "updateAiAssistSettings",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与 Idempotency-Key 必填；密钥经 AES-256-GCM 加密落库、明文永不入库；写审计 admin.aiAssistSettings.update（不含密钥）",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "testAiAssistSettings",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；纯校验探测（无持久化副作用，不要求 CSRF 与幂等键）",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "getWecomRobotConfig",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "updateWecomRobotConfig",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与 Idempotency-Key 必填；机器人密钥经 AES-256-GCM 加密落库、明文永不入库；写审计 admin.wecomRobot.update（不含密钥）",
        deniedWith: 403,
      },
    },
  },
  // ADR-077：项目企微群绑定。读路径对本项目全体活跃成员开放（非成员 404）；
  // 签发绑定码与解绑是新增的组长/系统管理员专属门禁（ADR-039 例外清单）；
  // 绑定兑换发生在桥接侧，要求发送者是项目成员或系统管理员并已绑定个人账号。
  {
    operationId: "getProjectWecomGroup",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen: "ADR-077：目标项目当前活跃成员（实时成员关系）",
        deniedWith: 404,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "createProjectWecomGroupCode",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-077：系统管理员或本项目组长可签发一次性绑定码（普通成员 403 PROJECT_WECOM_GROUP_FORBIDDEN）；CSRF 与同源必填；ADR-023 allowlist securityFlow，每次调用重签并立即作废旧码",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与同源必填；ADR-023 allowlist securityFlow（不进入通用幂等记录）",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "updateProjectWecomGroupNotificationOptions",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-090：系统管理员或本项目组长可保存项目群通知开关（普通成员 403 PROJECT_WECOM_GROUP_FORBIDDEN）；项目必须已绑定 ACTIVE 群（409）；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.notificationOptions.update",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与 Idempotency-Key 必填；项目必须已绑定 ACTIVE 群；写审计 project.wecomGroup.notificationOptions.update",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "deleteProjectWecomGroup",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-077：系统管理员或本项目组长可解绑（普通成员 403 PROJECT_WECOM_GROUP_FORBIDDEN）；CSRF 与 Idempotency-Key 必填；作废待用码并把 ACTIVE 绑定置 REVOKED（不物理删除），写审计 project.wecomGroup.unbind",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.unbind",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "createProjectWecomWebhook",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-105：当前 projectWecomGroup 能力档位允许写 Webhook 目标（默认系统管理员或组长；不允许时 403 PROJECT_WECOM_GROUP_FORBIDDEN）；CSRF 与 Idempotency-Key 必填；仅接受企业微信官方 Webhook URL，URL 加密落库且不进入审计、日志或响应；同 URL 409，单项目上限 20",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.webhook.create；审计与响应只含标签和 Key 尾号",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "deleteProjectWecomWebhook",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-105：当前 projectWecomGroup 能力档位允许删除 Webhook 目标（默认系统管理员或组长；不允许时 403 PROJECT_WECOM_GROUP_FORBIDDEN）；CSRF 与 Idempotency-Key 必填；目标必须属于当前项目且为 ACTIVE WEBHOOK；状态流转 REVOKED，写审计 project.wecomGroup.webhook.delete",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.webhook.delete",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "getProjectMemberPermissions",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "updateProjectMemberPermissions",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF、If-Match 与 Idempotency-Key 必填；单行配置 FOR UPDATE，版本冲突 409；同事务写审计 admin.projectMemberPermissions.update",
        deniedWith: 403,
      },
    },
  },
  {
    operationId: "getSearch",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getAuditLogs",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "deny", status: 403 },
      其他项目成员: { kind: "deny", status: 403 },
      已移除成员: { kind: "deny", status: 403 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getTaskGroup",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listTaskGroupRecords",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getProjectOverview",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getProjectTaskBoard",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listMyTasks",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listLeftoverItems",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listTaskGroups",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listTaskGroupMemberships",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listRecordFeed",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getRecordSummary",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listMyRecordDrafts",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getProjectActivity",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    // 聚合动态对全部登录用户开放：授权范围外的项目静默排除，因此不存在 403 / 404；
    // ADR-062 起已删除项目不再保留任何可读动态链。
    operationId: "listActivity",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getNotifications",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getNotificationUnreadCount",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getNotificationPreferences",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "updateNotificationPreferences",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "readNotification",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "unreadNotification",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "readAllNotifications",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "createProject",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "listProjects",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "getProject",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "updateProject",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "changeProjectStatus",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-039：本项目任意活跃成员（实时成员关系），CSRF、Idempotency-Key 与 If-Match 必填；进入维护中要求项目下任务全部收尾，仍有未完成且未取消的任务时 409 PROJECT_MAINTENANCE_TASKS_OPEN；未开始与维护中互改 409 PROJECT_STATUS_LEVEL_SKIP，已有完成任务回退未开始 409 PROJECT_STATUS_NOT_STARTED_LOCKED",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；CSRF、Idempotency-Key 与 If-Match 必填，维护中任务收尾门禁与两条硬约束同样返回 409",
        deniedWith: 403,
      },
    },
  },
  ...(
    [
      "listProjectMembers",
      "listProjectMemberUnfinishedTasks",
      "addProjectMember",
      "removeProjectMember",
    ] as const
  ).map((operationId): PermissionMatrixEntry => ({
    operationId,
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-039：本项目任意活跃成员（实时成员关系）" +
          (operationId === "removeProjectMember"
            ? "；目标为本项目 LEADER 时 409，须先把其他成员设为组长完成转移（ADR-053）"
            : operationId === "addProjectMember"
              ? "；新成员默认 role='MEMBER'，项目无活跃组长时首位加入者直接成为 LEADER（ADR-053）"
              : ""),
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；移除前未完成任务可按需改派，不改派保留历史负责人但成员失去项目访问权与角色；目标为本项目 LEADER 时 409（ADR-053：组长只能先转移再移除）",
        deniedWith: 403,
      },
    },
  })),
  {
    operationId: "setProjectMemberRole",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-053：系统管理员或本项目组长可转移组长——本项目组长只能把其他活跃成员设为 LEADER（不能自设、不能撤销组长）；普通成员与已降级的前组长一律 403 PROJECT_MEMBER_ROLE_FORBIDDEN，非成员 404",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整系统管理员 Session；把其他成员设为 LEADER 即完成转移（原组长自动降级），不允许直接撤销组长（409 PROJECT_MEMBER_LEADER_REQUIRED，ADR-053 项目必须始终保留一名组长）；目标必须 ACTIVE 成员，LEADER 唯一性冲突 409 PROJECT_MEMBER_LEADER_CONFLICT",
        deniedWith: 403,
      },
    },
  },
  ...(["previewProjectDocumentImport", "importProjectDocument"] as const).map(
    (operationId): PermissionMatrixEntry => ({
      operationId,
      outcomes: {
        匿名: { kind: "deny", status: 401 },
        活跃成员: {
          kind: "conditional",
          allowedWhen:
            "ADR-064：目标项目当前活跃成员（或系统管理员）；预览只读不写库，执行另需 CSRF、同源与 Idempotency-Key，同一摘要文档禁止重复导入",
          deniedWith: 404,
        },
        其他项目成员: { kind: "deny", status: 404 },
        已移除成员: { kind: "deny", status: 404 },
        停用用户: { kind: "deny", status: 401 },
        系统管理员: { kind: "allow" },
      },
    }),
  ),
  ...(["previewProjectImport", "importProject"] as const).map(
    (operationId): PermissionMatrixEntry => ({
      operationId,
      outcomes: {
        匿名: { kind: "deny", status: 401 },
        活跃成员: { kind: "allow" },
        其他项目成员: { kind: "allow" },
        已移除成员: { kind: "allow" },
        停用用户: { kind: "deny", status: 401 },
        系统管理员: { kind: "allow" },
      },
    }),
  ),
  // ADR-069：企业微信机器人绑定面向任何已登录用户（与项目无关）；
  // 签发绑定码走 ADR-023 securityFlow（签发一次性安全材料），
  // 解绑为 actorOnly 幂等撤销，全部不接触项目数据。
  {
    operationId: "getWecomBinding",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "createWecomBindingCode",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "deleteWecomBinding",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  // ADR-067：AI 辅助转换面向任何已登录用户（与整项目导入一致的可见性），
  // 不接触项目数据；未启用或上游故障统一 503，不泄露配置细节。
  {
    operationId: "assistDocumentImport",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  // ADR-076：迭代总结 AI 改写面向任何已登录用户（与 F-33 取数、AI 辅助转换
  // 一致的可见性），服务端不查库、不接触项目数据；未启用或上游故障统一 503。
  {
    operationId: "assistRecordSummary",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: { kind: "allow" },
      其他项目成员: { kind: "allow" },
      已移除成员: { kind: "allow" },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: { kind: "allow" },
    },
  },
  {
    operationId: "deleteProject",
    outcomes: {
      匿名: { kind: "deny", status: 401 },
      活跃成员: {
        kind: "conditional",
        allowedWhen:
          "ADR-062 / ADR-085：只有本项目组长（实时成员关系中的 ACTIVE LEADER）可以删除项目；本项目普通成员一律 403 PROJECT_DELETE_FORBIDDEN。CSRF、Idempotency-Key 与 If-Match 必填，版本不符 409 PROJECT_VERSION_CONFLICT。删除为物理删除：项目与全部下级业务数据消失且不可恢复，项目自己的审计链保留为只读历史；SYSTEM 审计链另留一条 project.delete，项目编码可以重新使用",
        deniedWith: 403,
      },
      其他项目成员: { kind: "deny", status: 404 },
      已移除成员: { kind: "deny", status: 404 },
      停用用户: { kind: "deny", status: 401 },
      系统管理员: {
        kind: "conditional",
        allowedWhen:
          "完整管理员 Session；CSRF、Idempotency-Key 与 If-Match 必填，删除语义与组长一致（物理删除、不可恢复、编码可复用）。目标已不存在时 404，重复删除只得由幂等重放处理",
        deniedWith: 403,
      },
    },
  },
] satisfies readonly PermissionMatrixEntry[];

export function outcomeAllows(outcome: MatrixOutcome): boolean {
  return outcome.kind === "allow" || outcome.kind === "conditional";
}

export function outcomeDenies(outcome: MatrixOutcome): boolean {
  return outcome.kind === "deny" || outcome.kind === "conditional";
}
