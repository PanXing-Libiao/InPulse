import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  parseControllerSource,
  parseGlobalPrefix,
  scanApiControllers,
  validateControllerBindings,
} from "../src/controller-bindings.js";
import {
  parseIdentityTable,
  parseSecurityFlowOperationIds,
  validatePermissionMatrix,
} from "../src/permission-checks.js";
import {
  permissionIdentities,
  permissionMatrix,
} from "../src/permission-matrix.js";
import { apiBasePath, routeRegistry } from "../src/route-registry.js";
import { securityFlowOperationIds } from "../src/security-flow.js";
import { makeRoute } from "./helpers.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const permissionsDocument = await readFile(
  resolve(repositoryRoot, "docs/permissions.md"),
  "utf8",
);

type Outcomes = (typeof permissionMatrix)[number]["outcomes"];

const allowAll = Object.fromEntries(
  permissionIdentities.map((identity) => [identity, { kind: "allow" }]),
) as unknown as Outcomes;

describe("权限矩阵与文档一致性", () => {
  test("身份集合与 docs/permissions.md 精确一致", () => {
    expect([...parseIdentityTable(permissionsDocument)].sort()).toEqual(
      [...permissionIdentities].sort(),
    );
  });

  test("ADR-023 allowlist 与认证安全流程矩阵精确相等", () => {
    expect(
      [...parseSecurityFlowOperationIds(permissionsDocument)].sort(),
    ).toEqual([...securityFlowOperationIds].sort());
  });

  test("当前 Registry 与权限矩阵一一对应", () => {
    expect(
      validatePermissionMatrix({
        routes: routeRegistry,
        matrix: permissionMatrix,
        permissionsDocument,
      }),
    ).toEqual([]);
  });

  test("缺少权限矩阵条目的路由必须失败", () => {
    const findings = validatePermissionMatrix({
      routes: [makeRoute({ operationId: "unknownOperation" })],
      matrix: permissionMatrix,
      permissionsDocument,
    });
    expect(findings.map((finding) => finding.rule)).toContain(
      "permission-matrix",
    );
  });

  test("孤立的权限矩阵条目必须失败", () => {
    const findings = validatePermissionMatrix({
      routes: [],
      matrix: permissionMatrix,
      permissionsDocument,
    });
    expect(findings.map((finding) => finding.rule)).toContain(
      "permission-matrix",
    );
  });

  test("AUTHZ-001：需认证路由必须同时有允许与拒绝用例", () => {
    const route = makeRoute({ authPolicy: "session", operationId: "getThing" });
    const findings = validatePermissionMatrix({
      routes: [route],
      matrix: [{ operationId: "getThing", outcomes: allowAll }],
      permissionsDocument,
    });
    expect(findings.map((finding) => finding.message).join("\n")).toContain(
      "缺少拒绝用例",
    );
  });

  test("authPolicy 为 none 的路由不得登记拒绝结果", () => {
    const outcomes = {
      ...allowAll,
      匿名: { kind: "deny", status: 401 },
    } as unknown as Outcomes;
    const findings = validatePermissionMatrix({
      routes: [makeRoute()],
      matrix: [{ operationId: "getHealth", outcomes }],
      permissionsDocument,
    });
    expect(findings.map((finding) => finding.rule)).toContain(
      "permission-matrix",
    );
  });
});

describe("Controller 绑定", () => {
  const controllerSource = `
import { Controller, Get } from "@nestjs/common";
import { Operation } from "../http/contract.decorators.js";

@Controller("health")
export class HealthController {
  @Operation("getHealth")
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}
`;

  test("解析 Nest 装饰器得到相对路径与方法", () => {
    const parsed = parseControllerSource(
      controllerSource,
      "health.controller.ts",
    );
    expect(parsed.failures).toEqual([]);
    expect(parsed.bindings).toEqual([
      {
        method: "GET",
        path: "/health",
        handler: "check",
        operationId: "getHealth",
        file: "health.controller.ts",
      },
    ]);
  });

  test("把 Nest 冒号路径参数归一化为 Registry 花括号形式", () => {
    const parsed = parseControllerSource(
      [
        'import { Controller, Get } from "@nestjs/common";',
        'import { Operation } from "../http/contract.decorators.js";',
        '@Controller("projects")',
        "export class ActivityController {",
        '  @Operation("getProjectActivity")',
        '  @Get(":projectId/activity")',
        "  list(): void {}",
        "}",
      ].join("\n"),
      "activity.controller.ts",
    );

    expect(parsed.failures).toEqual([]);
    expect(parsed.bindings[0]?.path).toBe("/projects/{projectId}/activity");
  });

  test("无法解析的装饰器参数必须失败", () => {
    const parsed = parseControllerSource(
      "@Controller(dynamicPrefix)\nexport class X {\n  @Get()\n  a() {}\n}\n",
      "x.controller.ts",
    );
    expect(parsed.failures.join("\n")).toContain("字符串字面量");
  });

  test("解析全局前缀", () => {
    expect(parseGlobalPrefix('app.setGlobalPrefix("api/v1");')).toBe(
      apiBasePath,
    );
  });

  test("真实 apps/api 扫描与 Registry 一致", async () => {
    const scan = await scanApiControllers(repositoryRoot);
    expect(scan.failures).toEqual([]);
    expect(scan.globalPrefix).toBe(apiBasePath);
    expect(
      scan.bindings.map((binding) => `${binding.method} ${binding.path}`),
    ).toEqual([
      "GET /api/v1/admin/users",
      "GET /api/v1/admin/users/{userId}/offboarding",
      "POST /api/v1/admin/users",
      "PATCH /api/v1/admin/users/{userId}",
      "POST /api/v1/admin/users/{userId}/disable",
      "POST /api/v1/admin/users/{userId}/enable",
      "POST /api/v1/admin/users/{userId}/delete",
      "GET /api/v1/audit-logs",
      "GET /api/v1/auth/csrf",
      "POST /api/v1/auth/login",
      "POST /api/v1/auth/logout",
      "GET /api/v1/me",
      "GET /api/v1/auth/sso/start",
      "GET /api/v1/auth/sso/callback",
      "GET /api/v1/users",
      "GET /api/v1/health",
      "GET /api/v1/health/live",
      "GET /api/v1/health/ready",
      "GET /api/v1/activity",
      "GET /api/v1/projects/{projectId}/activity",
      "GET /api/v1/leftover-items",
      "GET /api/v1/me/record-drafts",
      "GET /api/v1/me/tasks",
      "GET /api/v1/projects/{projectId}/overview",
      "GET /api/v1/change-records",
      "GET /api/v1/change-records/summary",
      "GET /api/v1/projects/{projectId}/task-board",
      "GET /api/v1/tasks",
      "GET /api/v1/task-groups/memberships",
      "GET /api/v1/task-groups/{groupId}",
      "GET /api/v1/task-groups/{groupId}/records",
      "GET /api/v1/task-groups",
      "GET /api/v1/projects/{projectId}/change-records",
      "GET /api/v1/projects/{projectId}/change-records/{recordId}",
      "GET /api/v1/projects/{projectId}/change-records/{recordId}/versions",
      "GET /api/v1/projects/{projectId}/change-records/{recordId}/versions/{versionNo}",
      "POST /api/v1/projects/{projectId}/change-records/{recordId}/publish",
      "POST /api/v1/projects/{projectId}/change-records/{recordId}/versions",
      "POST /api/v1/projects/{projectId}/change-records/{recordId}/leftovers",
      "GET /api/v1/projects/{projectId}/record-drafts",
      "GET /api/v1/projects/{projectId}/record-drafts/{recordId}",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/record-drafts",
      "DELETE /api/v1/projects/{projectId}/record-drafts/{recordId}",
      "PATCH /api/v1/projects/{projectId}/record-drafts/{recordId}",
      "POST /api/v1/projects/{projectId}/change-records/{recordId}/void",
      "POST /api/v1/projects/{projectId}/change-records/{recordId}/restore",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features/similar",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/features",
      "PATCH /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}",
      "GET /api/v1/projects/{projectId}/modules",
      "POST /api/v1/projects/{projectId}/modules",
      "PATCH /api/v1/projects/{projectId}/modules/{moduleId}",
      "GET /api/v1/notifications",
      "GET /api/v1/notifications/unread-count",
      "POST /api/v1/notifications/{notificationId}/read",
      "POST /api/v1/notifications/{notificationId}/unread",
      "POST /api/v1/notifications/read-all",
      "GET /api/v1/projects/{projectId}/active-members",
      "POST /api/v1/projects",
      "PATCH /api/v1/projects/{projectId}",
      "PATCH /api/v1/projects/{projectId}/status",
      "DELETE /api/v1/projects/{projectId}",
      "GET /api/v1/projects/{projectId}/members",
      "GET /api/v1/projects/{projectId}/members/{userId}/unfinished-tasks",
      "POST /api/v1/projects/{projectId}/members",
      "POST /api/v1/projects/{projectId}/members/{userId}/remove",
      "POST /api/v1/projects/{projectId}/members/{userId}/role",
      "GET /api/v1/projects",
      "GET /api/v1/projects/{projectId}",
      "GET /api/v1/search",
      "POST /api/v1/task-groups/merge",
      "POST /api/v1/task-groups/unmerge",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/assignees",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/{taskId}",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks",
      "PATCH /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/{taskId}",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/tasks",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/tasks/assignees",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/tasks",
      "PATCH /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/{taskId}/status-history",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/status-history",
      "GET /api/v1/me/wecom-binding",
      "POST /api/v1/me/wecom-binding/codes",
      "DELETE /api/v1/me/wecom-binding",
      "GET /api/v1/projects/{projectId}/wecom-group",
      "POST /api/v1/projects/{projectId}/wecom-group/codes",
      "DELETE /api/v1/projects/{projectId}/wecom-group",
      "GET /api/v1/admin/wecom-robot",
      "PUT /api/v1/admin/wecom-robot",
      "GET /api/v1/organizations/me/members",
      "GET /api/v1/admin/organizations",
      "POST /api/v1/admin/organizations",
      "PATCH /api/v1/admin/organizations/{organizationId}",
      "DELETE /api/v1/admin/organizations/{organizationId}",
      "POST /api/v1/admin/users/organization",
      "GET /api/v1/admin/ai-assist",
      "PUT /api/v1/admin/ai-assist",
      "POST /api/v1/admin/ai-assist/test",
      "POST /api/v1/document-imports/assist",
      "POST /api/v1/projects/{projectId}/document-imports/preview",
      "POST /api/v1/projects/{projectId}/document-imports",
      "GET /api/v1/external-links/{targetType}/{targetId}",
      "POST /api/v1/external-links/{targetType}/{targetId}",
      "DELETE /api/v1/external-links/{targetType}/{targetId}/{linkId}",
      "POST /api/v1/projects/{projectId}/change-records/{recordId}/leftover-task",
      "GET /api/v1/projects/{projectId}/change-records/{recordId}/leftover-task-preview",
      "GET /api/v1/tasks/{taskId}/leftover-source",
      "POST /api/v1/project-imports/preview",
      "POST /api/v1/project-imports",
      "POST /api/v1/record-summaries/assist",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/delete",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/delete",
      "POST /api/v1/tasks/{taskId}/complete",
      "POST /api/v1/projects/{projectId}/tasks",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/{taskId}/delete",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/delete",
      "GET /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/record-drafts",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/record-drafts",
      "PATCH /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/record-drafts/{recordId}",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/{taskId}/status",
      "POST /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/status",
    ]);
    expect(validateControllerBindings(routeRegistry, scan)).toEqual([]);
  });

  test("Registry 与 Controller 任一侧缺失都必须失败", () => {
    const missingController = validateControllerBindings(
      [makeRoute({ path: "/absent", operationId: "getAbsent" })],
      { globalPrefix: apiBasePath, bindings: [], failures: [] },
    );
    expect(
      missingController.map((finding) => finding.message).join("\n"),
    ).toContain("没有对应 Controller");

    const missingRegistryEntry = validateControllerBindings([], {
      globalPrefix: apiBasePath,
      bindings: [
        {
          method: "GET",
          path: "/api/v1/health",
          handler: "check",
          operationId: "getHealth",
          file: "apps/api/src/health/health.controller.ts",
        },
      ],
      failures: [],
    });
    expect(
      missingRegistryEntry.map((finding) => finding.message).join("\n"),
    ).toContain("未登记到 Route Registry");
  });

  test("全局前缀漂移必须失败", () => {
    const findings = validateControllerBindings([], {
      globalPrefix: "/api/v2",
      bindings: [],
      failures: [],
    });
    expect(findings.map((finding) => finding.message).join("\n")).toContain(
      "全局前缀",
    );
  });
});
