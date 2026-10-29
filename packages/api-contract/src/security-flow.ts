/**
 * ADR-023 allowlist（经 ADR-031 收缩、ADR-032 扩展、ADR-069 扩展一条，
 * ADR-106 移除项目群绑定码签发，共六条）：只有这六个一次性认证安全流程
 * operationId 可以登记 `securityFlow`，且必须且只能登记 `securityFlow`。
 * 集合必须与 docs/permissions.md 的“认证安全流程矩阵”精确相等。
 */
export const securityFlowOperationIds = [
  "issueCsrfToken",
  "login",
  "logout",
  "startSsoLogin",
  "completeSsoLogin",
  "createWecomBindingCode",
] as const;

export type SecurityFlowOperationId = (typeof securityFlowOperationIds)[number];
