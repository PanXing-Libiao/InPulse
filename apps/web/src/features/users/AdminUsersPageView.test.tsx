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

const membership = (id: number, name: string) => ({
  id,
  name,
  source: "LOCAL" as const,
  groupPath: null,
});

const admin: AdminUserItem = {
  id: 1,
  loginName: "alice",
  name: "Alice",
  email: "alice@example.com",
  avatarUrl: null,
  isAdmin: true,
  organizations: [],
  managedBySso: false,
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

/** CalmSelect 交互：打开组织下拉并点选目标项（弹层项带 title 属性）。 */
async function pickOrganizationOption(optionTitle: string) {
  const trigger = screen.getByLabelText("目标组织").closest(".ant-select");
  if (!trigger) {
    throw new Error("organization select trigger not found");
  }
  fireEvent.mouseDown(trigger);
  const options = await screen.findAllByTitle(optionTitle);
  const option = options.find(
    (candidate) => candidate.getAttribute("role") === "option",
  );
  if (!option) {
    throw new Error(`organization option not found: ${optionTitle}`);
  }
  fireEvent.click(option);
}

describe("F-03 admin users page", () => {
  it("shows direct lifecycle actions for other members", async () => {
    const disabled: AdminUserItem = {
      ...member,
      id: 3,
      loginName: "carol",
      name: "Carol",
      status: "DISABLED",
      disabledAt: "2026-10-19T00:00:00.000Z",
      rowVersion: 2,
    };
    mount({
      listAdminUsers: vi
        .fn()
        .mockResolvedValue({ items: [admin, member, disabled] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    const aliceEdit = within(userCard("Alice")).getByRole("button", {
      name: /编\s*辑/,
    });
    expect(aliceEdit).toBeInTheDocument();
    expect(
      aliceEdit.parentElement?.querySelector(".member-action-placeholder"),
    ).not.toBeNull();
    expect(
      within(userCard("Alice")).queryByRole("button", { name: /停\s*用/ }),
    ).not.toBeInTheDocument();
    const bobEdit = within(userCard("Bob")).getByRole("button", {
      name: /编\s*辑/,
    });
    const bobDisable = within(userCard("Bob")).getByRole("button", {
      name: /停\s*用/,
    });
    expect(bobEdit).toBeInTheDocument();
    expect(bobDisable).toBeInTheDocument();
    expect(
      bobDisable.compareDocumentPosition(bobEdit) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(userCard("Bob")).queryByRole("button", { name: /启\s*用/ }),
    ).not.toBeInTheDocument();
    expect(
      within(userCard("Bob")).queryByRole("button", { name: "强制删除" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("group", { name: "成员状态筛选" })).getByRole(
        "button",
        { name: "已停用" },
      ),
    );
    const carol = userCard("Carol");
    expect(
      within(carol).getByRole("button", { name: /编\s*辑/ }),
    ).toBeInTheDocument();
    expect(
      within(carol).getByRole("button", { name: /启\s*用/ }),
    ).toBeInTheDocument();
    expect(
      within(carol).getByRole("button", { name: "强制删除" }),
    ).toBeInTheDocument();
    expect(
      within(carol).queryByRole("button", { name: /停\s*用/ }),
    ).not.toBeInTheDocument();
  });

  it("places unfinished task counts in the last member column", async () => {
    const busy: AdminUserItem = { ...member, openTaskCount: 3 };
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, busy] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Bob");
    expect(
      userCard("Bob").querySelector(".member-meta")?.lastElementChild,
    ).toHaveTextContent("3 个未完成任务");
    expect(
      within(userCard("Alice")).queryByText(/个未完成任务/),
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
  });

  it("starts every member tag row with the role badge", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    mount({ listAdminUsers } as unknown as InpulseApiClient, admin.id);
    await screen.findByText("Alice");

    expect(within(userCard("Alice")).queryByText("当前账号")).toBeNull();
    expect(
      userCard("Alice").querySelector(".member-meta")?.firstElementChild,
    ).toHaveTextContent("系统管理员");
    expect(
      userCard("Bob").querySelector(".member-meta")?.firstElementChild,
    ).toHaveTextContent("项目成员");
  });

  it("groups optional organization badges before the status column", async () => {
    const ssoUser: AdminUserItem = {
      ...member,
      organizations: [
        membership(7, "研发一组"),
        {
          id: 8,
          name: "测试部",
          source: "CASDOOR" as const,
          groupPath: "libiaorobot.com/测试部",
        },
      ],
      managedBySso: true,
    };
    mount(
      {
        listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, ssoUser] }),
      } as unknown as InpulseApiClient,
      admin.id,
    );
    await screen.findByText("Bob");

    const meta = userCard("Bob").querySelector(".member-meta");
    expect(meta?.children[0]).toHaveTextContent("项目成员");
    expect(meta?.children[1]).toHaveClass("member-org-tags");
    expect(meta?.children[1]).toHaveTextContent("研发一组");
    expect(meta?.children[1]).toHaveTextContent("测试部");
    expect(meta?.children[1]).not.toHaveTextContent("libiaorobot.com/测试部");
    expect(meta?.children[1]).not.toHaveTextContent("统一身份");
    expect(meta?.children[2]).toHaveClass("member-status");
    const organizationBadges = meta?.children[1]?.querySelectorAll(".badge");
    expect(organizationBadges).toHaveLength(2);
    expect(organizationBadges?.[0]?.getAttribute("title")).toBe("研发一组");
    expect(organizationBadges?.[1]?.getAttribute("title")).toBe(
      "libiaorobot.com/测试部",
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

  it("disables a target user through the handover dialog and keeps self actions protected", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    const disableUser = vi.fn().mockResolvedValue(undefined);
    const getAdminUserOffboarding = vi
      .fn()
      .mockResolvedValue({ user: member, projects: [] });
    const client = {
      listAdminUsers,
      issueCsrfToken,
      disableUser,
      getAdminUserOffboarding,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /停\s*用/ }),
    );
    const confirm = screen.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await within(confirm).findByText("全部项目已完成。");
    fireEvent.click(within(confirm).getByRole("button", { name: /确认停用/ }));
    await waitFor(() => expect(disableUser).toHaveBeenCalledTimes(1));
    expect(disableUser).toHaveBeenCalledWith(
      2,
      { tasks: [], leaderTransfers: [] },
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-Match": '"1"',
          "Idempotency-Key": expect.stringContaining("admin-user-"),
        }),
      }),
    );
    await screen.findByText("用户已停用");
  });

  it("does not claim there are no open tasks when the handover list fails to load", async () => {
    const listAdminUsers = vi
      .fn()
      .mockResolvedValue({ items: [admin, member] });
    const getAdminUserOffboarding = vi.fn().mockRejectedValue(
      new ApiError(404, {
        code: "ADMIN_USER_NOT_FOUND",
        message: "用户不存在",
        details: {},
        requestId: "t",
      }),
    );
    const client = {
      listAdminUsers,
      getAdminUserOffboarding,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /停\s*用/ }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await within(dialog).findByText("任务清单未加载");
    expect(
      within(dialog).queryByText("没有未完成任务"),
    ).not.toBeInTheDocument();
    await within(dialog).findByText("任务清单加载失败，请重试后再停用。");
    expect(
      within(dialog).getByRole("button", { name: /确认停用/ }),
    ).toBeDisabled();
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

  it("defaults to active members and shows disabled members under the departed filter", async () => {
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
    const scope = screen.getByRole("group", { name: "成员状态筛选" });
    expect(scope).toHaveClass("segmented-equal-width");
    const search = screen.getByLabelText("搜索成员");
    expect(scope.closest(".member-head-tools")).not.toBeNull();
    expect(scope.closest(".member-head-tools")?.contains(search)).toBe(true);
    expect(
      scope.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(scope).getByRole("button", { name: "启用中" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText("离职成员")).not.toBeInTheDocument();
    expect(screen.queryByText("删除用户")).not.toBeInTheDocument();

    fireEvent.click(within(scope).getByRole("button", { name: "已停用" }));
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.getByText("离职成员")).toBeInTheDocument();
    expect(screen.queryByText("删除用户")).not.toBeInTheDocument();
    expect(userCard("离职成员").className).toContain("is-disabled");
  });

  it("confirms force deletion from the member row with CSRF, idempotency key and If-Match", async () => {
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
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("group", { name: "成员状态筛选" })).getByRole(
        "button",
        { name: "已停用" },
      ),
    );
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: "强制删除" }),
    );
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
    await screen.findByText("账号已删除，审计与项目动态保留事件当时姓名");
  });

  it("keeps disabled and deleted accounts out of organization adjustment", async () => {
    const organization = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      source: "LOCAL",
      groupPath: null,
      parentId: null,
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
      organizations: [membership(7, "研发一组")],
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
      organizations: [membership(7, "研发一组")],
    };
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [
          { ...member, organizations: [membership(7, "研发一组")] },
          admin,
          disabled,
          deleted,
        ],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [organization] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Bob");
    fireEvent.click(await screen.findByRole("tab", { name: /研发一组/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑组织" }));
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText("离职成员")).not.toBeInTheDocument();
    expect(screen.queryByText("删除用户")).not.toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("group", { name: "成员状态筛选" })).getByRole(
        "button",
        { name: "已停用" },
      ),
    );
    expect(screen.getByText("离职成员")).toBeInTheDocument();
    expect(screen.queryByText("删除用户")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tablist", { name: "按组织筛选成员" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑组织" }),
    ).not.toBeInTheDocument();
  });
});

describe("F-03 settings sections", () => {
  it("switches between the member, permission matrix and notification panels", async () => {
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, member] }),
      getProjectMemberPermissions: vi.fn().mockResolvedValue({
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
      }),
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Alice");

    const rail = screen.getByRole("navigation", { name: "成员与设置导航" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual([
      "成员与角色",
      "项目成员",
      "通知策略",
      "权限矩阵",
      "AI 辅助转换",
      "企业微信机器人",
    ]);
    const memberTab = within(rail).getByRole("button", { name: "成员与角色" });
    const matrixTab = within(rail).getByRole("button", { name: "权限矩阵" });
    const notifyTab = within(rail).getByRole("button", { name: "通知策略" });
    expect(memberTab).toHaveAttribute("aria-current", "page");

    fireEvent.click(matrixTab);
    expect(matrixTab).toHaveAttribute("aria-current", "page");
    expect(memberTab).not.toHaveAttribute("aria-current");
    expect(
      await screen.findByRole("table", {
        name: "全平台项目成员权限矩阵",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();

    fireEvent.click(notifyTab);
    expect(notifyTab).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("table", { name: "通知场景" })).toBeInTheDocument();
    expect(
      screen.queryByRole("table", {
        name: "全平台项目成员权限矩阵",
      }),
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
      .mockResolvedValue({ organizations: [], items: [] });
    mount(
      {
        listAdminUsers,
        getMyOrganizationMembers,
      } as unknown as InpulseApiClient,
      member.id,
      { isAdmin: false },
    );
    await screen.findByText("当前为未分类");
    const rail = screen.getByRole("navigation", { name: "成员与设置导航" });
    expect(
      within(rail).queryByRole("button", { name: "AI 辅助转换" }),
    ).not.toBeInTheDocument();
  });
});

describe("ADR-081 organizations", () => {
  it("renders the read-only same-organization view for regular members", async () => {
    const getMyOrganizationMembers = vi.fn().mockResolvedValue({
      organizations: [membership(7, "研发一组")],
      items: [
        {
          id: 2,
          name: "Bob",
          avatarUrl: null,
          isAdmin: false,
          organizationIds: [7],
        },
        {
          id: 9,
          name: "Alice",
          avatarUrl: null,
          isAdmin: false,
          organizationIds: [7],
        },
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
      .mockResolvedValue({ organizations: [], items: [] });
    mount({ getMyOrganizationMembers } as unknown as InpulseApiClient, 2, {
      isAdmin: false,
    });
    await screen.findByText("当前为未分类");
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

  it("keeps members without an organization in the flat list without an unclassified tab", async () => {
    const organization = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      source: "LOCAL" as const,
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const classified: AdminUserItem = {
      ...member,
      id: 3,
      loginName: "carol",
      name: "Carol",
      organizations: [membership(7, "研发一组")],
    };
    mount({
      listAdminUsers: vi
        .fn()
        .mockResolvedValue({ items: [admin, member, classified] }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [organization] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Carol");

    expect(screen.queryByRole("tab", { name: /未分类/ })).toBeNull();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /全部/ }));
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("hides filters with no members", async () => {
    const emptyOrganization = {
      id: 9,
      name: "空组织",
      rowVersion: 1,
      source: "LOCAL",
      groupPath: null,
      parentId: null,
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
      source: "LOCAL",
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const client = {
      listAdminUsers: vi
        .fn()
        .mockResolvedValueOnce({
          items: [
            { ...member, organizations: [membership(7, "研发一组")] },
            admin,
          ],
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
    fireEvent.click(screen.getByRole("button", { name: "移出到未分类" }));
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
      source: "LOCAL",
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const assignUsersOrganization = vi
      .fn()
      .mockResolvedValue({ updatedCount: 1 });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [
          { ...admin, organizations: [membership(7, "研发一组")] },
          member,
        ],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [organization] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      assignUsersOrganization,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    expect(within(userCard("Bob")).getByText("未分类")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择 Bob")).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "编辑组织" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    expect(
      screen.getByRole("button", { name: "退出调整" }),
    ).toBeInTheDocument();
    const batchBar = screen.getByRole("region", { name: "批量操作" });
    const memberList =
      document.querySelector<HTMLElement>(".admin-member-list");
    expect(memberList).not.toBeNull();
    expect(
      batchBar.compareDocumentPosition(memberList as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("选择 Bob"));
    expect(
      screen.getByLabelText("目标组织").closest(".calm-select"),
    ).not.toBeNull();
    expect(document.querySelector(".member-batchbar select")).toBeNull();
    await pickOrganizationOption("研发一组");
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
    const successToast = await screen.findByTestId("admin-user-success");
    expect(successToast).toHaveTextContent("已把 1 名成员加入「研发一组」");
    expect(successToast).toHaveClass("success-toast");
    expect(successToast.closest(".permission-note")).toBeNull();
    expect(screen.queryByLabelText("选择 Bob")).not.toBeInTheDocument();
  });

  it("selects a member from the row while keeping row actions usable", async () => {
    const getAdminUserOffboarding = vi
      .fn()
      .mockResolvedValue({ user: member, projects: [] });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({ items: [admin, member] }),
      getAdminUserOffboarding,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    const bobCheckbox = screen.getByLabelText("选择 Bob");
    expect(bobCheckbox).not.toBeChecked();

    fireEvent.click(screen.getByText("Bob"));
    expect(bobCheckbox).toBeChecked();
    expect(screen.getByText("已选 1 人")).toBeInTheDocument();

    fireEvent.click(bobCheckbox);
    expect(bobCheckbox).not.toBeChecked();
    expect(screen.getByText("已选 0 人")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Bob"));
    expect(bobCheckbox).toBeChecked();

    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    const editorDialog = screen.getByRole("dialog", { name: "编辑用户" });
    expect(editorDialog).toBeInTheDocument();
    expect(bobCheckbox).toBeChecked();
    fireEvent.click(
      within(editorDialog).getByRole("button", { name: /取\s*消/ }),
    );

    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /停\s*用/ }),
    );
    expect(
      screen.getByRole("dialog", { name: "停用账号 · 任务交接" }),
    ).toBeInTheDocument();
    expect(bobCheckbox).toBeChecked();
  });

  it("keeps account lifecycle actions in the save row on the right", async () => {
    const disabled: AdminUserItem = {
      ...member,
      id: 3,
      loginName: "carol",
      name: "Carol",
      status: "DISABLED",
      disabledAt: "2026-10-19T00:00:00.000Z",
      rowVersion: 2,
    };
    mount({
      listAdminUsers: vi
        .fn()
        .mockResolvedValue({ items: [admin, member, disabled] }),
    } as unknown as InpulseApiClient);
    await screen.findByText("Bob");

    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /编\s*辑/ }),
    );
    let dialog = screen.getByRole("dialog", { name: "编辑用户" });
    let footer = dialog.querySelector<HTMLElement>(".admin-user-footer");
    expect(footer).not.toBeNull();
    const activeFooter = footer as HTMLElement;
    const save = within(activeFooter).getByRole("button", { name: /保\s*存/ });
    const disable = within(activeFooter).getByRole("button", {
      name: "停用账号",
    });
    expect(
      within(activeFooter).getByRole("button", { name: /取\s*消/ }),
    ).toBeInTheDocument();
    expect(
      within(activeFooter).queryByRole("button", { name: "启用账号" }),
    ).not.toBeInTheDocument();
    expect(
      save.compareDocumentPosition(disable) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(dialog.querySelector(".admin-user-status")?.contains(disable)).toBe(
      false,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /取\s*消/ }));

    fireEvent.click(
      within(screen.getByRole("group", { name: "成员状态筛选" })).getByRole(
        "button",
        { name: "已停用" },
      ),
    );
    await screen.findByText("Carol");
    fireEvent.click(
      within(userCard("Carol")).getByRole("button", { name: /编\s*辑/ }),
    );
    dialog = screen.getByRole("dialog", { name: "编辑用户" });
    footer = dialog.querySelector<HTMLElement>(".admin-user-footer");
    expect(footer).not.toBeNull();
    const disabledFooter = footer as HTMLElement;
    const disabledSave = within(disabledFooter).getByRole("button", {
      name: /保\s*存/,
    });
    const enable = within(disabledFooter).getByRole("button", {
      name: "启用账号",
    });
    const forceDelete = within(disabledFooter).getByRole("button", {
      name: "强制删除",
    });
    expect(
      disabledSave.compareDocumentPosition(enable) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      enable.compareDocumentPosition(forceDelete) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(dialog.querySelector(".admin-user-status")?.contains(enable)).toBe(
      false,
    );
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
    expect(screen.queryByText("Carol")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入组织" }));
    expect(screen.getByLabelText("选择 Bob")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择 Carol")).not.toBeInTheDocument();
    expect(screen.queryByText("Carol")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出调整" }));
    expect(screen.queryByText("Carol")).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("group", { name: "成员状态筛选" })).getByRole(
        "button",
        { name: "已停用" },
      ),
    );
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("orders current account, unassigned, then assigned members", async () => {
    const firstOrganization = {
      id: 3,
      name: "先建部门",
      rowVersion: 1,
      source: "LOCAL",
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const selfOrganization = {
      id: 7,
      name: "研发一组",
      rowVersion: 1,
      source: "LOCAL",
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [
          { ...admin, organizations: [membership(7, "研发一组")] },
          {
            ...member,
            id: 3,
            loginName: "carol",
            name: "Carol",
            organizations: [membership(3, "先建部门")],
          },
          { ...member, organizations: [] },
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
      ["Bob", "未分类"],
      ["Carol", "先建部门"],
    ]);
  });

  it("creates an organization from the batch bar and puts selected members in it", async () => {
    const createOrganization = vi.fn().mockResolvedValue({
      id: 8,
      name: "研发二组",
      rowVersion: 1,
      source: "LOCAL",
      groupPath: null,
      parentId: null,
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
    await pickOrganizationOption("＋ 新建组织");
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
      source: "LOCAL",
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [
          { ...member, organizations: [membership(7, "研发一组")] },
          admin,
        ],
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
      source: "LOCAL",
      groupPath: null,
      parentId: null,
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
        items: [
          { ...admin, organizations: [membership(7, "研发一组")] },
          member,
        ],
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
      source: "LOCAL",
      groupPath: null,
      parentId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const assignUsersOrganization = vi
      .fn()
      .mockResolvedValue({ updatedCount: 1 });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [
          { ...member, organizations: [membership(7, "研发一组")] },
          admin,
        ],
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
    fireEvent.click(screen.getByRole("button", { name: "移出到未分类" }));
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
    await screen.findByText(/已把 1 名成员移出，变为未分类/);
  });

  it("keeps sole-owner tasks unresolved until a handover member or deletion is chosen", async () => {
    const target: AdminUserItem = { ...member, openTaskCount: 3 };
    const disableUser = vi.fn().mockResolvedValue(undefined);
    const getAdminUserOffboarding = vi.fn().mockResolvedValue({
      user: target,
      projects: [
        {
          projectId: 12,
          projectCode: "DATA_BI",
          projectName: "数据看板自助分析平台",
          members: [
            { userId: 1, name: "Alice", avatarUrl: null },
            { userId: 3, name: "Carol", avatarUrl: null },
          ],
          tasks: [
            {
              taskId: 70,
              projectId: 12,
              moduleId: 4,
              featureId: null,
              scopeType: "MODULE",
              code: "DATA_BI-T-6",
              title: "定时任务与推送模板",
              rowVersion: 3,
              assignees: [{ userId: 2, name: "Bob" }],
              requiresHandover: true,
            },
            {
              taskId: 71,
              projectId: 12,
              moduleId: 4,
              featureId: null,
              scopeType: "MODULE",
              code: "DATA_BI-T-7",
              title: "指标口径复核",
              rowVersion: 2,
              assignees: [
                { userId: 2, name: "Bob" },
                { userId: 1, name: "Alice" },
              ],
              requiresHandover: false,
            },
          ],
        },
      ],
    });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({
        items: [target, admin],
      }),
      listOrganizations: vi.fn().mockResolvedValue({ items: [] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      disableUser,
      getAdminUserOffboarding,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /停\s*用/ }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await within(dialog).findByText("定时任务与推送模板");
    const confirm = within(dialog).getByRole("button", {
      name: /确认停用/,
    });
    expect(confirm).toBeDisabled();
    expect(disableUser).not.toHaveBeenCalled();

    const soleRow = within(dialog)
      .getByText("定时任务与推送模板")
      .closest("tr");
    if (!soleRow) throw new Error("sole task row missing");
    fireEvent.click(
      within(soleRow as HTMLElement).getByRole("button", {
        name: "＋ 添加成员",
      }),
    );
    fireEvent.click(within(soleRow as HTMLElement).getByLabelText("Alice"));
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() => expect(disableUser).toHaveBeenCalledTimes(1));
    expect(disableUser).toHaveBeenCalledWith(
      2,
      {
        tasks: [
          {
            projectId: 12,
            moduleId: 4,
            featureId: null,
            taskId: 70,
            rowVersion: 3,
            assigneeIds: [1],
            delete: false,
          },
        ],
        leaderTransfers: [],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-Match": '"1"',
          "Idempotency-Key": expect.stringContaining("admin-user-"),
        }),
      }),
    );
  });

  it("lists projects and tasks that require handover first", async () => {
    const target: AdminUserItem = { ...member, openTaskCount: 3 };
    const task = (
      projectId: number,
      taskId: number,
      title: string,
      requiresHandover: boolean,
    ) => ({
      taskId,
      projectId,
      moduleId: 4,
      featureId: null,
      scopeType: "MODULE" as const,
      code: "T-" + taskId,
      title,
      rowVersion: 1,
      assignees: requiresHandover
        ? [{ userId: 2, name: "Bob" }]
        : [
            { userId: 2, name: "Bob" },
            { userId: 1, name: "Alice" },
          ],
      requiresHandover,
    });
    const getAdminUserOffboarding = vi.fn().mockResolvedValue({
      user: target,
      projects: [
        {
          projectId: 30,
          projectCode: "NORMAL",
          projectName: "普通项目",
          members: [{ userId: 1, name: "Alice", avatarUrl: null }],
          tasks: [task(30, 90, "普通项目多负责人任务", false)],
        },
        {
          projectId: 20,
          projectCode: "URGENT",
          projectName: "必须处理项目",
          members: [{ userId: 1, name: "Alice", avatarUrl: null }],
          tasks: [
            task(20, 82, "第二优先唯一任务", true),
            task(20, 81, "普通多负责人任务", false),
            task(20, 80, "第一优先唯一任务", true),
          ],
        },
      ],
    });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({ items: [target, admin] }),
      getAdminUserOffboarding,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /停\s*用/ }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await within(dialog).findByText("必须处理项目");
    expect(
      Array.from(dialog.querySelectorAll(".disable-project-copy strong")).map(
        (node) => node.textContent,
      ),
    ).toEqual(["必须处理项目", "普通项目"]);
    const urgent = Array.from(dialog.querySelectorAll(".disable-project")).find(
      (node) => node.textContent?.includes("必须处理项目"),
    );
    if (!urgent) throw new Error("urgent project card missing");
    expect(
      Array.from(urgent.querySelectorAll(".disable-task-title")).map(
        (node) => node.textContent,
      ),
    ).toEqual(["第一优先唯一任务", "第二优先唯一任务", "普通多负责人任务"]);
  });

  it("requires a new leader when the disabled account leads a project", async () => {
    const target: AdminUserItem = { ...member, openTaskCount: 0 };
    const disableUser = vi.fn().mockResolvedValue(undefined);
    const getAdminUserOffboarding = vi.fn().mockResolvedValue({
      user: target,
      projects: [
        {
          projectId: 42,
          projectCode: "CORE",
          projectName: "核心平台",
          members: [
            { userId: 1, name: "Alice", avatarUrl: null },
            { userId: 3, name: "Carol", avatarUrl: null },
          ],
          tasks: [],
          requiresLeaderTransfer: true,
        },
      ],
    });
    const client = {
      listAdminUsers: vi.fn().mockResolvedValue({ items: [target, admin] }),
      issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
      disableUser,
      getAdminUserOffboarding,
    } as unknown as InpulseApiClient;
    mount(client);
    await screen.findByText("Bob");
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /停\s*用/ }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await within(dialog).findByLabelText("为 核心平台 选择新组长");
    expect(
      within(dialog).queryByText("全部项目已完成。"),
    ).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", {
      name: /确认停用/,
    });
    expect(confirm).toBeDisabled();

    const trigger = screen
      .getByLabelText("为 核心平台 选择新组长")
      .closest(".ant-select");
    if (!trigger) throw new Error("leader select not found");
    fireEvent.mouseDown(trigger);
    fireEvent.click(await screen.findByTitle("Alice"));
    await waitFor(() => expect(confirm).toBeEnabled());

    fireEvent.click(confirm);
    await waitFor(() => expect(disableUser).toHaveBeenCalledTimes(1));
    expect(disableUser).toHaveBeenCalledWith(
      2,
      {
        tasks: [],
        leaderTransfers: [{ projectId: 42, newLeaderUserId: 1 }],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-Match": '"1"',
          "Idempotency-Key": expect.stringContaining("admin-user-"),
        }),
      }),
    );
  });

  it("shows disabled accounts only in the departed filter and keeps them gray", async () => {
    const disabled: AdminUserItem = {
      ...member,
      status: "DISABLED",
      disabledAt: "2026-10-19T00:00:00.000Z",
    };
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValue({ csrfToken: "a".repeat(43) });
    const enableUser = vi.fn().mockResolvedValue(undefined);
    mount({
      listAdminUsers: vi.fn().mockResolvedValue({ items: [disabled, admin] }),
      issueCsrfToken,
      enableUser,
    } as unknown as InpulseApiClient);
    await screen.findByText("Alice");
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();

    const scope = screen.getByRole("group", { name: "成员状态筛选" });
    fireEvent.click(within(scope).getByRole("button", { name: "已停用" }));
    const rows = [...document.querySelectorAll(".member-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Bob");
    expect(rows[0]?.className).toContain("is-disabled");
    expect(within(userCard("Bob")).getByText("停用")).toBeInTheDocument();
    expect(
      within(userCard("Bob")).getByRole("button", { name: "强制删除" }),
    ).toBeInTheDocument();
    expect(
      within(userCard("Bob")).queryByRole("button", { name: /停\s*用/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(userCard("Bob")).getByRole("button", { name: /启\s*用/ }),
    );
    const dialog = screen.getByRole("dialog", {
      name: /启\s*用\s*用\s*户/,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*认/ }));
    await waitFor(() => expect(enableUser).toHaveBeenCalledTimes(1));
    expect(enableUser).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.stringContaining("admin-user-"),
        }),
      }),
    );
    await screen.findByText("用户已启用");
  });
});
