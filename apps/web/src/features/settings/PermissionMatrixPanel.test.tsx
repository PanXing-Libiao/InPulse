import React from "react";
import { ConfigProvider } from "antd";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type InpulseApiClient,
  type ProjectMemberPermissions,
} from "@generated/api";
import { PermissionMatrixPanel } from "./PermissionMatrixPanel";
import { permissionMatrixRows } from "./settings-content";

const settings: ProjectMemberPermissions = {
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
  rowVersion: 3,
  updatedAt: "2026-10-28T03:00:00.000Z",
  updatedByName: "Alice",
};

function mount(client: InpulseApiClient, isAdmin: boolean) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <PermissionMatrixPanel client={client} isAdmin={isAdmin} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

function cell(rowLabel: string, columnIndex: number): HTMLElement {
  const row = screen.getByText(rowLabel).closest("tr");
  if (!row) throw new Error("permission row not found: " + rowLabel);
  const cells = within(row as HTMLElement).getAllByRole("cell");
  const target = cells[columnIndex];
  if (!target) throw new Error("column not found: " + columnIndex);
  return target;
}

function clientWith(
  overrides: Partial<InpulseApiClient> = {},
): InpulseApiClient {
  return {
    getProjectMemberPermissions: vi.fn().mockResolvedValue(settings),
    updateProjectMemberPermissions: vi.fn(),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    ...overrides,
  } as unknown as InpulseApiClient;
}

async function chooseLeaderOnly() {
  const trigger = screen
    .getByLabelText("编辑项目与变更状态权限范围")
    .closest(".ant-select");
  if (!trigger) throw new Error("select trigger not found");
  fireEvent.mouseDown(trigger);
  const dropdown = document.querySelector(".ant-select-dropdown");
  if (!dropdown) throw new Error("select dropdown not found");
  fireEvent.click(within(dropdown as HTMLElement).getByText("仅组长"));
}

describe("PermissionMatrixPanel", () => {
  it("renders all matrix rows and distinguishes fixed-open and admin-only items", async () => {
    mount(clientWith(), false);
    const table = await screen.findByRole("table", {
      name: "全平台项目成员权限矩阵",
    });
    for (const header of ["功能", "权限范围", "规则说明"]) {
      expect(
        within(table).getByRole("columnheader", { name: header }),
      ).toBeInTheDocument();
    }
    expect(within(table).getAllByRole("row")).toHaveLength(
      permissionMatrixRows.length + 1,
    );
    expect(cell("查看项目、动态、成员与搜索", 1)).toHaveTextContent("固定开放");
    expect(cell("个人设置与通知偏好", 1)).toHaveTextContent("固定开放");
    expect(cell("作废/恢复迭代记录", 1)).toHaveTextContent("仅系统管理员");
    expect(cell("系统管理与审计", 1)).toHaveTextContent("仅系统管理员");
    expect(cell("编辑项目与变更状态", 1)).toHaveTextContent("全部成员");
    expect(cell("转移项目组长", 1)).toHaveTextContent("仅组长");
  });

  it("lets administrators change a level and saves CSRF, If-Match and an idempotency key", async () => {
    const updated: ProjectMemberPermissions = {
      ...settings,
      projectEdit: "LEADERS_ONLY",
      rowVersion: 4,
      updatedByName: "Admin",
    };
    const getProjectMemberPermissions = vi
      .fn()
      .mockResolvedValueOnce(settings)
      .mockResolvedValue(updated);
    const updateProjectMemberPermissions = vi.fn().mockResolvedValue(updated);
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    mount(
      clientWith({
        getProjectMemberPermissions,
        updateProjectMemberPermissions,
        issueCsrfToken,
      }),
      true,
    );
    await screen.findByRole("table", { name: "全平台项目成员权限矩阵" });

    await chooseLeaderOnly();
    const save = screen.getByRole("button", { name: "保存权限配置" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() =>
      expect(updateProjectMemberPermissions).toHaveBeenCalledTimes(1),
    );
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(updateProjectMemberPermissions.mock.calls[0]![0]).toEqual({
      projectEdit: "LEADERS_ONLY",
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
    });
    expect(updateProjectMemberPermissions.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "a".repeat(43),
          "If-Match": '"3"',
          "Idempotency-Key": expect.stringMatching(
            /^project-member-permissions-/,
          ),
        }),
      }),
    );
    expect(
      await screen.findByText(/下一次请求立即按新配置校验/),
    ).toBeInTheDocument();
  });

  it("keeps non-admin members read-only", async () => {
    mount(clientWith(), false);
    await screen.findByRole("table", { name: "全平台项目成员权限矩阵" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存权限配置" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("当前账号只读")).toBeInTheDocument();
  });

  it("shows a 409 conflict and reuses the same key for the unchanged retry", async () => {
    const conflict = new ApiError(409, {
      code: "PROJECT_MEMBER_PERMISSION_VERSION_CONFLICT",
      message: "conflict",
      details: {},
      requestId: "request-1",
    });
    const updateProjectMemberPermissions = vi.fn().mockRejectedValue(conflict);
    mount(clientWith({ updateProjectMemberPermissions }), true);
    await screen.findByRole("table", { name: "全平台项目成员权限矩阵" });
    await chooseLeaderOnly();

    const save = screen.getByRole("button", { name: "保存权限配置" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(
      await screen.findByText(/权限配置已被其他管理员更新/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新加载最新配置" }),
    ).toBeInTheDocument();

    fireEvent.click(save);
    await waitFor(() =>
      expect(updateProjectMemberPermissions).toHaveBeenCalledTimes(2),
    );
    const first = updateProjectMemberPermissions.mock.calls[0]![1] as {
      readonly headers: Readonly<Record<string, string>>;
    };
    const second = updateProjectMemberPermissions.mock.calls[1]![1] as {
      readonly headers: Readonly<Record<string, string>>;
    };
    expect(first.headers["Idempotency-Key"]).toBe(
      second.headers["Idempotency-Key"],
    );
  });
});
