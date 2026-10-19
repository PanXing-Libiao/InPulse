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
  type AdminUserItem,
  type InpulseApiClient,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { AdminUsersPageView } from "./AdminUsersPageView";

const admin: AdminUserItem = {
  id: 1,
  loginName: "alice",
  name: "Alice",
  email: "alice@example.com",
  avatarUrl: null,
  isAdmin: true,
  organizationId: null,
  status: "ACTIVE",
  openTaskCount: 0,
  rowVersion: 1,
  disabledAt: null,
  deletedAt: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};

const member: AdminUserItem = {
  ...admin,
  id: 2,
  loginName: "bob",
  name: "Bob",
  email: "bob@example.com",
  isAdmin: false,
  rowVersion: 1,
};

function mount(
  client: InpulseApiClient,
  currentUserId = 1,
  options: { readonly isAdmin?: boolean } = {},
) {
  const merged = {
    ...client,
    listOrganizations:
      (client as { readonly listOrganizations?: unknown }).listOrganizations ??
      vi.fn().mockResolvedValue({ items: [] }),
  } as unknown as InpulseApiClient;
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <AdminUsersPageView
            client={merged}
            currentUserId={currentUserId}
            isAdmin={options.isAdmin ?? true}
          />
        </QueryClientProvider>
      </AuthStateProvider>
    </ConfigProvider>,
  );
}

function userCard(name: string): HTMLElement {
  const card = screen.getByText(name).closest(".member-row");
  if (!card) throw new Error(`user card not found: ${name}`);
  return card as HTMLElement;
}

describe("F-03 admin users page", () => {
  it("keeps lifecycle actions out of the list", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    mount({ listAdminUsers } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(
      within(userCard("Alice")).getByRole("button", { name: /编\s*辑/ }),
    ).toBeInTheDocument();
    expect(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    ).toBeInTheDocument();
    expect(
      within(userCard("Alice")).queryByRole("button", { name: /停\s*用/ }),
    ).not.toBeInTheDocument();
    expect(
      within(userCard("Bob")).queryByRole("button", { name: /停\s*用/ }),
    ).not.toBeInTheDocument();
    expect(
      within(userCard("Alice")).queryByRole("button", { name: "强制退出" }),
    ).not.toBeInTheDocument();
    expect(
      within(userCard("Bob")).queryByRole("button", { name: "强制退出" }),
    ).not.toBeInTheDocument();
    expect(
      within(userCard("Alice")).queryByRole("button", { name: /^隐\s*藏$/ }),
    ).not.toBeInTheDocument();
    expect(
      within(userCard("Bob")).queryByRole("button", { name: /^隐\s*藏$/ }),
    ).not.toBeInTheDocument();
  });

  it("pins the current account to the top of the list", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [member, admin] });
    mount({ listAdminUsers } as unknown as InpulseApiClient, admin.id);
    await screen.findByText("Alice");
    const selfCard = userCard("Alice");
    const otherCard = userCard("Bob");
    expect(
      selfCard.compareDocumentPosition(otherCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("orders self, then other admins, then members", async () => {
    const otherAdmin: AdminUserItem = {
      ...admin,
      id: 3,
      loginName: "carol",
      name: "Carol",
      email: "carol@example.com",
    };
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [member, otherAdmin, admin] });
    mount({ listAdminUsers } as unknown as InpulseApiClient, admin.id);
    await screen.findByText("Alice");
    const rendered = [...document.querySelectorAll(".member-row")].map(
      (row) => row.querySelector("strong")?.textContent ?? "",
    );
    expect(rendered).toEqual(["Alice", "Carol", "Bob"]);
    expect(within(userCard("Alice")).getByText("当前账号")).toHaveClass(
      "badge",
      "badge-violet",
    );
  });

  it("edits a user and sends row version via If-Match", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    const updateUser = vi
      .fn()
      .mockResolvedValue({ ...member, name: "Bob Updated", rowVersion: 2 });
    const client = {
      listAdminUsers,
      issueCsrfToken,
      updateUser,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    fireEvent.change(screen.getByLabelText("姓名"), {
      target: { value: "Bob Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser).toHaveBeenCalledWith(
      2,
      { name: "Bob Updated" },
      expect.objectContaining({
        headers: expect.objectContaining({ "If-Match": '"1"' }),
      }),
    );
  });

  it("disables a target user and keeps self actions protected", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    const disableUser = vi.fn().mockResolvedValue(undefined);
    const client = {
      listAdminUsers,
      issueCsrfToken,
      disableUser,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
    const confirm = screen.getByRole("dialog", { name: /停\s*用\s*用\s*户/ });
    fireEvent.click(within(confirm).getByRole("button", { name: /确\s*认/ }));
    await waitFor(() => expect(disableUser).toHaveBeenCalledTimes(1));
    expect(disableUser).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-Match": '"1"',
          "Idempotency-Key": expect.stringContaining("admin-user-"),
        }),
      }),
    );
    await screen.findByText("用户已停用");
  });

  it("reuses the idempotency key when retrying a rejected update", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    const updateUser = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(500, {
          code: "INTERNAL_ERROR",
          message: "internal-detail",
          details: {},
          requestId: "boom",
        }),
      )
      .mockResolvedValue({ ...member, name: "Bob Updated", rowVersion: 2 });
    const client = {
      listAdminUsers,
      issueCsrfToken,
      updateUser,
    } as unknown as InpulseApiClient;
    mount(client, 1);

    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    fireEvent.change(screen.getByLabelText("姓名"), {
      target: { value: "Bob Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await screen.findByText("用户管理服务暂时不可用，请重试。");
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(2));
    await screen.findByText("用户资料已更新");
    const firstKey = (
      updateUser.mock.calls[0]![2] as {
        readonly headers: { readonly "Idempotency-Key": string };
      }
    ).headers["Idempotency-Key"];
    const secondKey = (
      updateUser.mock.calls[1]![2] as {
        readonly headers: { readonly "Idempotency-Key": string };
      }
    ).headers["Idempotency-Key"];
    expect(secondKey).toBe(firstKey);
  });

  it("keeps disabled members visible and hides deleted accounts", async () => {
    const disabled: AdminUserItem = {
      ...member,
      id: 3,
      loginName: "departed",
      name: "离职成员",
      status: "DISABLED",
      disabledAt: "2026-10-18T00:00:00.000Z",
      rowVersion: 2,
    };
    const deleted: AdminUserItem = {
      ...member,
      id: 4,
      loginName: "deleted-user-4",
      name: "删除用户",
      email: null,
      status: "DISABLED",
      disabledAt: "2026-10-18T00:00:00.000Z",
      deletedAt: "2026-10-19T00:00:00.000Z",
      rowVersion: 3,
    };
    mount({
      listAdminUsers: vi
        .fn()
        .mockResolvedValue({ items: [admin, member, disabled, deleted] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("离职成员")).toBeInTheDocument();
    expect(screen.queryByText("删除用户")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "成员状态筛选" }),
    ).not.toBeInTheDocument();
    const rows = [...document.querySelectorAll(".member-row")];
    expect(rows.at(-1)?.textContent).toContain("离职成员");
    expect(rows.at(-1)?.className).toContain("is-disabled");
  });

  it("confirms force deletion from the editor with CSRF, idempotency key and If-Match", async () => {
    const disabled: AdminUserItem = {
      ...member,
      status: "DISABLED",
      disabledAt: "2026-10-18T00:00:00.000Z",
      rowVersion: 7,
    };
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, disabled] }),
      issueCsrfToken,
      deleteUser,
    } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "强制删除" }));
    const dialog = screen.getByRole("dialog", { name: /强制删除/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteUser).toHaveBeenCalledTimes(1));
    expect(deleteUser).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "a".repeat(43),
          "Idempotency-Key": expect.stringContaining("admin-user-"),
          "If-Match": `"7"`,
        }),
      }),
    );
    await screen.findByText(
      "账号已强制删除，历史业务记录中的显示名已改为「删除用户」",
    );
  });

  it("keeps disabled and deleted accounts out of organization adjustment", async () => {
    const organization = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const disabled: AdminUserItem = {
      ...member,
      id: 3,
      loginName: "departed",
      name: "离职成员",
      status: "DISABLED",
      disabledAt: "2026-10-18T00:00:00.000Z",
      organizationId: 7,
    };
    const deleted: AdminUserItem = {
      ...member,
      id: 4,
      loginName: "deleted-user-4",
      name: "删除用户",
      email: null,
      status: "DISABLED",
      disabledAt: "2026-10-18T00:00:00.000Z",
      deletedAt: "2026-10-19T00:00:00.000Z",
      organizationId: 7,
    };
    mount({
      listAdminUsers: vi
        .fn()
        .mockResolvedValue({ items: [admin, disabled, deleted] }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [organization] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("tab", { name: /研发一组/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑组织" }));
    expect(screen.queryByText("离职成员")).not.toBeInTheDocument();
    expect(screen.queryByText("删除用户")).not.toBeInTheDocument();
  });
});

describe("F-03 settings sections", () => {
  it("switches between the member, permission matrix and notification panels", async () => {
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, member] }),
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Alice");

    const rail = screen.getByRole("navigation", { name: "成员与设置导航" });
    const memberTab = within(rail).getByRole("button", { name: "成员与角色" });
    const matrixTab = within(rail).getByRole("button", { name: "权限矩阵" });
    const notifyTab = within(rail).getByRole("button", { name: "通知策略" });
    expect(memberTab).toHaveAttribute("aria-current", "page");

    fireEvent.click(matrixTab);
    expect(matrixTab).toHaveAttribute("aria-current", "page");
    expect(memberTab).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("table", { name: "权限矩阵" })).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();

    fireEvent.click(notifyTab);
    expect(notifyTab).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("table", { name: "通知场景" })).toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "权限矩阵" }),
    ).not.toBeInTheDocument();

    fireEvent.click(memberTab);
    await screen.findByText("Alice");
    expect(memberTab).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("table", { name: "通知场景" }),
    ).not.toBeInTheDocument();
  });

  it("filters members by name, login name or email and clears back to the full list", async () => {
    const wu: AdminUserItem = {
      ...admin,
      id: 4,
      loginName: "wmj",
      name: "吴孟杰",
      email: "wumengjie@example.com",
      isAdmin: false,
      rowVersion: 1,
    };
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member, wu] });
    mount({ listAdminUsers } as unknown as InpulseApiClient);
    await screen.findByText("Alice");

    const search = screen.getByRole("textbox", { name: "搜索成员" });
    fireEvent.change(search, { target: { value: "孟杰" } });
    expect(screen.getByText("吴孟杰")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "wmj" } });
    expect(screen.getByText("吴孟杰")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "ALICE@EXAMPLE.COM" } });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("吴孟杰")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的成员")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("吴孟杰")).toBeInTheDocument();
  });

  it("管理员可打开 AI 辅助转换页签并加载配置", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const getAiAssistSettings = vi.fn().mockResolvedValue({
      enabled: false,
      source: "NONE",
      ready: false,
      disabledReason: "NOT_ENABLED",
      endpoint: null,
      model: null,
      timeoutMs: 60_000,
      maxTokens: 8192,
      keyConfigured: false,
      keyHint: null,
      rowVersion: null,
      updatedAt: null,
    });
    mount(
      { listAdminUsers, getAiAssistSettings } as unknown as InpulseApiClient,
      admin.id,
    );
    await screen.findByText("Alice");
    const rail = screen.getByRole("navigation", { name: "成员与设置导航" });
    fireEvent.click(within(rail).getByRole("button", { name: "AI 辅助转换" }));
    expect(await screen.findByText("当前状态")).toBeInTheDocument();
    expect(screen.getByText("当前未启用")).toBeInTheDocument();
    expect(getAiAssistSettings).toHaveBeenCalledTimes(1);
  });

  it("普通成员看不到 AI 辅助转换页签", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const getMyOrganizationMembers = vi
      .fn()
      .mockResolvedValue({ organization: null, items: [] });
    mount(
      {
        listAdminUsers,
        getMyOrganizationMembers,
      } as unknown as InpulseApiClient,
      member.id,
      { isAdmin: false },
    );
    await screen.findByText("尚未加入组织");
    const rail = screen.getByRole("navigation", { name: "成员与设置导航" });
    expect(
      within(rail).queryByRole("button", { name: "AI 辅助转换" }),
    ).not.toBeInTheDocument();
  });
});

describe("ADR-081 organizations", () => {
  it("renders the read-only same-organization view for regular members", async () => {
    const getMyOrganizationMembers = vi.fn().mockResolvedValue({
      organization: { id: 7, name: "研发一组" },
      items: [
        { id: 2, name: "Bob", avatarUrl: null, isAdmin: false },
        { id: 9, name: "Alice", avatarUrl: null, isAdmin: false },
      ],
    });
    const listAdminUsers = vi.fn();
    mount(
      {
        listAdminUsers,
        getMyOrganizationMembers,
      } as unknown as InpulseApiClient,
      2,
      { isAdmin: false },
    );
    await screen.findByText("Bob");
    expect(listAdminUsers).not.toHaveBeenCalled();
    expect(screen.getAllByText(/研发一组/).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "加入组织" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑组织" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("bob")).not.toBeInTheDocument();
  });

  it("shows the unassigned hint when the member has no organization", async () => {
    const getMyOrganizationMembers = vi
      .fn()
      .mockResolvedValue({ organization: null, items: [] });
    mount({ getMyOrganizationMembers } as unknown as InpulseApiClient, 2, {
      isAdmin: false,
    });
    await screen.findByText("尚未加入组织");
  });

  it("filters the member list to system administrators", async () => {
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, member] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("tab", { name: /系统管理员/ }));
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /全部/ }));
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("hides filters with no members", async () => {
    const emptyOrganization = {
      id: 9,
      name: "空组织",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [member] }),
      listOrganizations: vi
        .fn()
        .mockResolvedValue({ items: [emptyOrganization] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Bob");
    expect(
      screen.queryByRole("tab", { name: /空组织/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /系统管理员/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    expect(
      screen.queryByRole("option", { name: "空组织" }),
    ).not.toBeInTheDocument();
  });

  it("returns to all after the managed organization is emptied", async () => {
    const assignment = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const client = {
      listAdminUsers: vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ ...member, organizationId: 7 }, admin],
        })
        .mockResolvedValue({ items: [member, admin] }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [assignment] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      assignUsersOrganization: vi.fn().mockResolvedValue({ updatedCount: 1 }),
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("tab", { name: /研发一组/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑组织" }));
    fireEvent.click(screen.getByLabelText("选择 Bob"));
    fireEvent.click(screen.getByRole("button", { name: "移出到未分配" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: /研发一组/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: /全部/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("joins unassigned members through the single organization manager", async () => {
    const organization = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const assignUsersOrganization = vi
      .fn()
      .mockResolvedValue({ updatedCount: 1 });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [{ ...admin, organizationId: 7 }, member],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [organization] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      assignUsersOrganization,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    expect(within(userCard("Bob")).getByText("未分配")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择 Bob")).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "编辑组织" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    expect(
      screen.getByRole("button", { name: "退出调整" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("选择 Bob"));
    fireEvent.change(screen.getByLabelText("目标组织"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    await waitFor(() =>
      expect(assignUsersOrganization).toHaveBeenCalledTimes(1),
    );
    expect(assignUsersOrganization).toHaveBeenCalledWith(
      { userIds: [2], organizationId: 7 },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringContaining("organization-"),
        }),
      }),
    );
    await screen.findByText(/已把 1 名成员加入「研发一组」/);
    expect(screen.queryByLabelText("选择 Bob")).not.toBeInTheDocument();
  });

  it("hides disabled members while managing organizations", async () => {
    const disabled: AdminUserItem = {
      ...member,
      id: 3,
      loginName: "carol",
      name: "Carol",
      status: "DISABLED",
      disabledAt: "2026-10-19T00:00:00.000Z",
    };
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [member, disabled] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    expect(screen.getByLabelText("选择 Bob")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择 Carol")).not.toBeInTheDocument();
    expect(screen.queryByText("Carol")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出调整" }));
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("orders current account, unassigned, then assigned members", async () => {
    const firstOrganization = {
      id: 3,
      name: "先建部门",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const selfOrganization = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [
          { ...admin, organizationId: 7 },
          {
            ...member,
            id: 3,
            loginName: "carol",
            name: "Carol",
            organizationId: 3,
          },
          { ...member, organizationId: null },
        ],
      }),
      listOrganizations: vi
        .fn()
        .mockResolvedValue({ items: [firstOrganization, selfOrganization] }),
    } as unknown as InpulseApiClient;
    mount(client, admin.id);
    await screen.findByText("Carol");
    expect(document.querySelector(".member-group-title")).toBeNull();
    const rendered = [...document.querySelectorAll(".member-row")].map(
      (row) => [
        row.querySelector("strong")?.textContent ?? "",
        [...row.querySelectorAll(".member-meta .badge")]
          .filter((badge) => !badge.classList.contains("badge-violet"))
          .at(1)?.textContent ?? "",
      ],
    );
    expect(rendered).toEqual([
      ["Alice", "研发一组"],
      ["Bob", "未分配"],
      ["Carol", "先建部门"],
    ]);
  });

  it("creates an organization from the batch bar and puts selected members in it", async () => {
    const createOrganization = vi.fn().mockResolvedValue({
      id: 8,
      name: "研发二组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    });
    const assignUsersOrganization = vi
      .fn()
      .mockResolvedValue({ updatedCount: 1 });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, member] }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      createOrganization,
      assignUsersOrganization,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    fireEvent.click(screen.getByLabelText("选择 Bob"));
    fireEvent.change(screen.getByLabelText("目标组织"), {
      target: { value: "new" },
    });
    fireEvent.change(screen.getByLabelText("新组织名称"), {
      target: { value: "研发二组" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    await waitFor(() => expect(createOrganization).toHaveBeenCalledTimes(1));
    expect(createOrganization).toHaveBeenCalledWith(
      { name: "研发二组" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringContaining("organization-"),
        }),
      }),
    );
    await waitFor(() =>
      expect(assignUsersOrganization).toHaveBeenCalledWith(
        { userIds: [2], organizationId: 8 },
        expect.objectContaining({
          headers: expect.objectContaining({
            "Idempotency-Key": expect.stringContaining("organization-"),
          }),
        }),
      ),
    );
    await screen.findByText(/已把 1 名成员加入「研发二组」/);
  });

  it("only lets members of the managed organization be selected", async () => {
    const assignment = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [{ ...member, organizationId: 7 }, admin],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [assignment] }),
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("tab", { name: /研发一组/ }));
    expect(
      screen.queryByRole("button", { name: "加入组织" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑组织" }));
    expect(screen.getByLabelText("选择 Bob")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择 Alice")).not.toBeInTheDocument();
  });

  it("renames the organization from the edit entry", async () => {
    const assignment = {
      id: 7,
      name: "研发一组",
      rowVersion: 3,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const updateOrganization = vi.fn().mockResolvedValue({
      ...assignment,
      name: "研发二组",
      rowVersion: 4,
    });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [{ ...admin, organizationId: 7 }, member],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [assignment] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      updateOrganization,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("tab", { name: /研发一组/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑组织" }));
    fireEvent.change(screen.getByLabelText("组织名称"), {
      target: { value: "研发二组" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(updateOrganization).toHaveBeenCalledTimes(1));
    expect(updateOrganization).toHaveBeenCalledWith(
      7,
      { name: "研发二组" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringContaining("organization-"),
          "If-Match": JSON.stringify("3"),
        }),
      }),
    );
  });

  it("moves selected members back to unassigned from the organization manager", async () => {
    const assignment = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const assignUsersOrganization = vi
      .fn()
      .mockResolvedValue({ updatedCount: 1 });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [{ ...member, organizationId: 7 }, admin],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [assignment] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      assignUsersOrganization,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("tab", { name: /研发一组/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑组织" }));
    fireEvent.click(screen.getByLabelText("选择 Bob"));
    fireEvent.click(screen.getByRole("button", { name: "移出到未分配" }));
    await waitFor(() =>
      expect(assignUsersOrganization).toHaveBeenCalledTimes(1),
    );
    expect(assignUsersOrganization).toHaveBeenCalledWith(
      { userIds: [2], organizationId: null },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringContaining("organization-"),
        }),
      }),
    );
    await screen.findByText(/已把 1 名成员移出，变为未分配/);
  });

  it("blocks disabling from the editor when the account still owns open tasks", async () => {
    const disableUser = vi.fn().mockResolvedValue(undefined);
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [{ ...member, openTaskCount: 2 }, admin],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      disableUser,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
    expect(
      screen.getByText(/仍有 2 个未完成任务，请先转分配或删除任务后再停用/),
    ).toBeInTheDocument();
    expect(disableUser).not.toHaveBeenCalled();
  });

  it("keeps disabled accounts in the all list, gray and sorted last", async () => {
    const disabled: AdminUserItem = {
      ...member,
      status: "DISABLED",
      disabledAt: "2026-10-19T00:00:00.000Z",
    };
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [disabled, admin] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Bob");
    const rows = [...document.querySelectorAll(".member-row")];
    expect(
      rows.map((row) => row.querySelector("strong")?.textContent ?? ""),
    ).toEqual(["Alice", "Bob"]);
    expect(rows[1]?.className).toContain("is-disabled");
    expect(within(userCard("Bob")).getByText("停用")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /停用|已隐藏/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    expect(
      screen.getByRole("button", { name: "启用账号" }),
    ).toBeInTheDocument();
  });
});
