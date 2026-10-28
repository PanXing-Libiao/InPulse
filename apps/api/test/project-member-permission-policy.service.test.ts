import { describe, expect, it } from "vitest";

import type { ProjectMemberPermissionLevel } from "@inpulse/api-contract";
import type { TransactionContext } from "../src/database/transaction-context.js";
import {
  ProjectMemberPermissionPolicyService,
  type ProjectMemberPermissionRole,
} from "../src/modules/projects/project-member-permission-policy.service.js";
import {
  ProjectMemberPermissionRepository,
  type ProjectMemberPermissionSettingsRecord,
} from "../src/modules/projects/project-member-permission.repository.js";

const defaults: ProjectMemberPermissionSettingsRecord = {
  projectEdit: "ALL_MEMBERS",
  projectMemberManage: "ALL_MEMBERS",
  projectLeaderTransfer: "LEADERS_ONLY",
  projectDelete: "LEADERS_ONLY",
  projectDocumentImport: "ALL_MEMBERS",
  moduleFeatureEdit: "ALL_MEMBERS",
  moduleFeatureDelete: "LEADERS_ONLY",
  taskEdit: "ALL_MEMBERS",
  taskLifecycle: "ALL_MEMBERS",
  recordWrite: "ALL_MEMBERS",
  projectWecomGroup: "LEADERS_ONLY",
  rowVersion: 1,
  updatedAt: null,
  updatedByName: null,
};

function txFor(
  role: ProjectMemberPermissionRole | undefined,
  options: { readonly isAdmin?: boolean; readonly disabled?: boolean } = {},
): TransactionContext {
  const sql = (async (
    strings: TemplateStringsArray,
    ..._values: readonly unknown[]
  ) => {
    const query = strings.join("?");
    if (query.includes("FROM app.users")) {
      return [
        {
          isAdmin: options.isAdmin ?? false,
          status: options.disabled === true ? "DISABLED" : "ACTIVE",
          disabledAt: options.disabled === true ? new Date() : null,
        },
      ];
    }
    if (query.includes("FROM app.project_members")) {
      return role === undefined || role === "SYSTEM_ADMIN" ? [] : [{ role }];
    }
    throw new Error("unexpected query: " + query);
  }) as unknown as TransactionContext["sql"];
  return { sql } as TransactionContext;
}

function serviceWith(
  settings: ProjectMemberPermissionSettingsRecord | null = defaults,
): ProjectMemberPermissionPolicyService {
  return new ProjectMemberPermissionPolicyService({
    find: async () => settings ?? undefined,
  } as unknown as ProjectMemberPermissionRepository);
}

const levelCases: ReadonlyArray<{
  readonly level: ProjectMemberPermissionLevel;
  readonly role: "LEADER" | "MEMBER";
  readonly allowed: boolean;
}> = [
  { level: "ALL_MEMBERS", role: "LEADER", allowed: true },
  { level: "ALL_MEMBERS", role: "MEMBER", allowed: true },
  { level: "LEADERS_ONLY", role: "LEADER", allowed: true },
  { level: "LEADERS_ONLY", role: "MEMBER", allowed: false },
  { level: "ADMINS_ONLY", role: "LEADER", allowed: false },
  { level: "ADMINS_ONLY", role: "MEMBER", allowed: false },
];

describe("ProjectMemberPermissionPolicyService", () => {
  it.each(levelCases)(
    "applies $level to $role as allowed=$allowed",
    async ({ level, role, allowed }) => {
      const decision = await serviceWith({
        ...defaults,
        projectEdit: level,
      }).evaluate(txFor(role), {
        actorUserId: 9,
        projectId: 3,
        capabilities: ["projectEdit"],
      });
      expect(decision.kind).toBe(allowed ? "allowed" : "forbidden");
      if (decision.kind === "allowed") {
        expect(decision.role).toBe(role);
      } else if (decision.kind === "forbidden") {
        expect(decision.deniedCapabilities).toEqual(["projectEdit"]);
      }
    },
  );

  it.each(["ALL_MEMBERS", "LEADERS_ONLY", "ADMINS_ONLY"] as const)(
    "always allows a system administrator under %s",
    async (level) => {
      const decision = await serviceWith({
        ...defaults,
        projectDelete: level,
      }).evaluate(txFor(undefined, { isAdmin: true }), {
        actorUserId: 1,
        projectId: 3,
        capabilities: ["projectDelete"],
      });
      expect(decision).toEqual({ kind: "allowed", role: "SYSTEM_ADMIN" });
    },
  );

  it("returns not-member for non-members, disabled users and disabled accounts", async () => {
    await expect(
      serviceWith().evaluate(txFor(undefined), {
        actorUserId: 9,
        projectId: 3,
        capabilities: ["projectEdit"],
      }),
    ).resolves.toEqual({ kind: "not-member" });
    await expect(
      serviceWith().evaluate(txFor("LEADER", { disabled: true }), {
        actorUserId: 9,
        projectId: 3,
        capabilities: ["projectEdit"],
      }),
    ).resolves.toEqual({ kind: "not-member" });
  });

  it("checks every requested capability and reports only the denied ones", async () => {
    const decision = await serviceWith().evaluate(txFor("MEMBER"), {
      actorUserId: 9,
      projectId: 3,
      capabilities: ["projectEdit", "projectLeaderTransfer", "projectDelete"],
    });
    expect(decision).toEqual({
      kind: "forbidden",
      role: "MEMBER",
      deniedCapabilities: ["projectLeaderTransfer", "projectDelete"],
    });
  });

  it("fails closed when the singleton settings row is missing", async () => {
    await expect(
      serviceWith(null).assertCapabilities(txFor("MEMBER"), {
        actorUserId: 9,
        projectId: 3,
        capabilities: ["projectEdit"],
      }),
    ).rejects.toThrow("project member permission settings row is missing");
  });

  it("keeps default leader-only and member-wide behavior for the eleven capabilities", async () => {
    const member = await serviceWith().evaluate(txFor("MEMBER"), {
      actorUserId: 9,
      projectId: 3,
      capabilities: [
        "projectEdit",
        "projectMemberManage",
        "projectDocumentImport",
        "moduleFeatureEdit",
        "taskEdit",
        "taskLifecycle",
        "recordWrite",
      ],
    });
    expect(member.kind).toBe("allowed");
    const leaderOnly = await serviceWith().evaluate(txFor("MEMBER"), {
      actorUserId: 9,
      projectId: 3,
      capabilities: [
        "projectLeaderTransfer",
        "projectDelete",
        "moduleFeatureDelete",
        "projectWecomGroup",
      ],
    });
    expect(leaderOnly).toMatchObject({
      kind: "forbidden",
      deniedCapabilities: [
        "projectLeaderTransfer",
        "projectDelete",
        "moduleFeatureDelete",
        "projectWecomGroup",
      ],
    });
  });
});
