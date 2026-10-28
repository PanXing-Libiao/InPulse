import { vi } from "vitest";

import {
  ProjectMemberPermissionPolicyService,
  type ProjectMemberPermissionDecision,
} from "../src/modules/projects/project-member-permission-policy.service.js";
import { ProjectMemberPermissionRepository } from "../src/modules/projects/project-member-permission.repository.js";

/** 真实 PostgreSQL 集成测试使用正式策略，覆盖默认配置与即时生效。 */
export function postgresProjectMemberPermissions(): ProjectMemberPermissionPolicyService {
  return new ProjectMemberPermissionPolicyService(
    new ProjectMemberPermissionRepository(),
  );
}

/** 纯单元测试的放行替身；角色边界由被替换的角色门禁自行模拟。 */
export function allowProjectMemberPermissions(): ProjectMemberPermissionPolicyService {
  return {
    evaluate: vi.fn(async (): Promise<ProjectMemberPermissionDecision> => ({
      kind: "allowed",
      role: "MEMBER",
    })),
    assertCapabilities: vi.fn(async () => "MEMBER" as const),
  } as unknown as ProjectMemberPermissionPolicyService;
}
