import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type {
  InpulseApiClient,
  ProjectMemberRecordItem,
  ProjectMemberUnfinishedTaskItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ProjectMembersPageView } from "./ProjectMembersPageView";

const owner: ProjectMemberRecordItem = {
  membershipId: 10,
  projectId: 7,
  userId: 2,
  name: "开发者 C",
  avatarUrl: null,
  status: "ACTIVE",
  role: "MEMBER",
  joinedAt: "2026-09-09T00:00:00.000Z",
  removedAt: null,
};

const removed: ProjectMemberRecordItem = {
  membershipId: 11,
  projectId: 7,
  userId: 4,
  name: "已移除成员",
  avatarUrl: null,
  status: "REMOVED",
  role: "MEMBER",
  joinedAt: "2026-09-08T00:00:00.000Z",
  removedAt: "2026-09-09T00:00:00.000Z",
};

const memberA: ProjectMemberRecordItem = {
  membershipId: 12,
  projectId: 7,
  userId: 3,
  name: "开发者 A",
  avatarUrl: null,
  status: "ACTIVE",
  role: "MEMBER",
  joinedAt: "2026-09-09T00:00:00.000Z",
  removedAt: null,
};

const memberB: ProjectMemberRecordItem = {
  membershipId: 13,
  projectId: 7,
  userId: 5,
  name: "开发者 B",
  avatarUrl: null,
  status: "ACTIVE",
  role: "MEMBER",
  joinedAt: "2026-09-09T00:00:00.000Z",
  removedAt: null,
};

const unfinishedTask: ProjectMemberUnfinishedTaskItem = {
  taskId: 99,
  projectId: 7,
  moduleId: 12,
  featureId: 33,
  scopeType: "FEATURE",
  code: "SHOP-T-99",
  title: "待办功能",
  description: "描述",
  priority: "NORMAL",
  dueAt: null,
  workStatus: "TODO",
  assigneeId: 2,
  rowVersion: 4,
  impactFeatureIds: [33],
};

function mount(
  client: InpulseApiClient,
  props: {
    readonly isSystemAdmin?: boolean | undefined;
    readonly viewerRole?: "MEMBER" | "LEADER" | null | undefined;
  } = {},
) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter>
        <AuthStateProvider>
          <QueryClientProvider
            client={
              new QueryClient({
                defaultOptions: { queries: { retry: false } },
              })
            }
          >
            <ProjectMembersPageView projectId={7} client={client} {...props} />
          </QueryClientProvider>
        </AuthStateProvider>
      </MemoryRouter>
    </ConfigProvider>,
  );
}

function baseClient() {
  return {
    listProjects: vi.fn().mockResolvedValue({
      items: [
        {
          id: 7,
          code: "INPULSE",
          name: "InPulse 研发交付平台",
          description: "示例项目",
          status: "ACTIVE",
          rowVersion: 2,
          createdBy: 2,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
          memberCount: 2,
          stats: {
            activeModuleCount: 2,
            activeFeatureCount: 5,
            openTaskCount: 3,
            completedTaskCount: 1,
          },
        },
      ],
    }),
    listProjectMembers: vi.fn().mockResolvedValue({ items: [owner, removed] }),
    listProjectMemberUnfinishedTasks: vi.fn().mockResolvedValue({ items: [] }),
    getUserDirectory: vi.fn().mockResolvedValue({ items: [] }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "csrf-token" }),
    getProjectWecomGroup: vi.fn().mockResolvedValue({
      state: "UNBOUND",
      codeExpiresAt: null,
      boundAt: null,
      boundByName: null,
      lastDeliveryError: null,
      botProfileUrl: null,
      notificationOptions: { disabledCategories: [] },
    }),
    createProjectWecomGroupCode: vi.fn().mockResolvedValue({
      code: "ABCD-EFGH-JKMN-PQRS",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
    deleteProjectWecomGroup: vi.fn().mockResolvedValue(undefined),
  };
}

/** CalmSelect 多选交互：打开「选择用户」下拉，按顺序点选目标项；弹层在中途保持展开。 */
async function pickCandidates(
  picks: readonly {
    readonly name: string;
    readonly search?: string;
    /** 输入 search 后应当被过滤掉的候选姓名。 */
    readonly hides?: string;
  }[],
) {
  const trigger = screen
    .getByLabelText("选择要添加的用户")
    .closest(".ant-select");
  if (!trigger) {
    throw new Error("candidate select not found");
  }
  fireEvent.mouseDown(trigger);
  for (const pick of picks) {
    if (pick.search !== undefined) {
      fireEvent.change(screen.getByLabelText("选择要添加的用户"), {
        target: { value: pick.search },
      });
    }
    if (pick.hides !== undefined) {
      expect(screen.queryByTitle(pick.hides, { exact: true })).toBeNull();
    }
    fireEvent.click(await screen.findByTitle(pick.name));
  }
}

describe("ProjectMembersPageView", () => {
  it("lists active project members and opens remove confirmation", async () => {
    const client = baseClient() as unknown as InpulseApiClient;
    mount(client);

    await screen.findAllByText(/开发者 C/);
    // 2026-09-23：列表只展示活跃成员，接口返回的 REMOVED 行不再渲染。
    expect(screen.queryByText("已移除成员")).not.toBeInTheDocument();
    expect(screen.queryByText("历史记录已保留")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /移\s*除/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /移\s*除/ }));
    const dialog = await screen.findByRole("dialog", {
      name: "移除项目成员",
    });
    expect(within(dialog).getByText("移除项目成员")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        (
          client as unknown as {
            listProjectMemberUnfinishedTasks: ReturnType<typeof vi.fn>;
          }
        ).listProjectMemberUnfinishedTasks,
      ).toHaveBeenCalledWith(7, 2, expect.anything()),
    );
    expect(
      within(dialog).getByText("该成员没有未完成任务。"),
    ).toBeInTheDocument();
  });

  it("adds several candidate members in one submit with per-user security headers", async () => {
    const client = baseClient();
    client.listProjectMembers.mockResolvedValue({ items: [owner] });
    client.getUserDirectory.mockResolvedValue({
      items: [
        { id: 3, name: "新成员", avatarUrl: null, isAdmin: false },
        { id: 5, name: "旧同事", avatarUrl: null, isAdmin: true },
      ],
    });
    const addProjectMember = vi.fn().mockResolvedValue({ member: owner });
    const api = {
      ...client,
      addProjectMember,
    } as unknown as InpulseApiClient;
    mount(api);

    await screen.findAllByText(/开发者 C/);
    fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
    const dialog = await screen.findByRole("dialog", {
      name: "添加项目成员",
    });
    // 下拉可搜索且可多选：输入姓名后不匹配的候选被过滤掉，再逐个点选两位候选。
    await pickCandidates([
      { name: "新成员", search: "新", hides: "旧同事" },
      { name: "旧同事" },
    ]);
    expect(
      within(dialog).getByText(/已选择 2 位用户，确认后一次性加入项目。/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "添加成员" }));

    await waitFor(() => expect(addProjectMember).toHaveBeenCalledTimes(2));
    expect(addProjectMember).toHaveBeenNthCalledWith(
      1,
      7,
      { userId: 3 },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringContaining("project-member-add-"),
        }),
      }),
    );
    expect(addProjectMember).toHaveBeenNthCalledWith(
      2,
      7,
      { userId: 5 },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringContaining("project-member-add-"),
        }),
      }),
    );
    const keys = addProjectMember.mock.calls.map(
      (call) =>
        (
          call[2] as {
            readonly headers: { readonly "Idempotency-Key": string };
          }
        ).headers["Idempotency-Key"],
    );
    expect(new Set(keys).size).toBe(2);
    await screen.findByText("已添加 2 位项目成员，项目成员列表已更新。");
  });

  it("removes a member and sends the original unfinished task by default", async () => {
    const client = baseClient();
    client.listProjectMemberUnfinishedTasks.mockResolvedValue({
      items: [unfinishedTask],
    });
    const removeProjectMember = vi.fn().mockResolvedValue({
      member: {
        ...owner,
        status: "REMOVED",
        removedAt: "2026-09-09T01:00:00.000Z",
      },
      reassignedTaskIds: [],
      unfinishedTaskCount: 1,
    });
    const api = {
      ...client,
      removeProjectMember,
    } as unknown as InpulseApiClient;
    mount(api);

    await screen.findAllByText(/开发者 C/);
    fireEvent.click(screen.getByRole("button", { name: /移\s*除/ }));
    const dialog = await screen.findByRole("dialog", {
      name: "移除项目成员",
    });
    await within(dialog).findByText("SHOP-T-99");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));

    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledTimes(1));
    expect(removeProjectMember).toHaveBeenCalledWith(
      7,
      2,
      { reassignments: [] },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringContaining("project-member-remove-"),
        }),
      }),
    );
    await screen.findByText(/成员已移出项目/);
  });

  it("reassigns unfinished tasks to several members in one multi-select (2026-09-24)", async () => {
    const client = baseClient();
    client.listProjectMembers.mockResolvedValue({
      items: [owner, removed, memberA, memberB],
    });
    client.listProjectMemberUnfinishedTasks.mockResolvedValue({
      items: [unfinishedTask],
    });
    const removeProjectMember = vi.fn().mockResolvedValue({
      member: {
        ...owner,
        status: "REMOVED",
        removedAt: "2026-09-09T01:00:00.000Z",
      },
      reassignedTaskIds: [99],
      unfinishedTaskCount: 0,
    });
    const api = {
      ...client,
      removeProjectMember,
    } as unknown as InpulseApiClient;
    mount(api);

    // 三位活跃成员各自有「移除」入口，第一位即被移除的 开发者 C（user 2）。
    const removeButtons = await screen.findAllByRole("button", {
      name: /移\s*除/,
    });
    expect(removeButtons).toHaveLength(3);
    fireEvent.click(removeButtons[0]!);
    const dialog = await screen.findByRole("dialog", {
      name: "移除项目成员",
    });
    await within(dialog).findByText("SHOP-T-99");
    fireEvent.click(within(dialog).getByLabelText("改派任务 SHOP-T-99"));

    // 改派下拉与新建任务的负责人选择一致：可搜索、可多选、弹层保持展开。
    const trigger = within(dialog)
      .getByLabelText("选择 SHOP-T-99 的改派成员")
      .closest(".ant-select");
    if (!trigger) {
      throw new Error("reassignment select not found");
    }
    fireEvent.mouseDown(trigger);
    fireEvent.click(await screen.findByTitle("开发者 A"));
    fireEvent.click(await screen.findByTitle("开发者 B"));

    fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));

    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledTimes(1));
    expect(removeProjectMember).toHaveBeenCalledWith(
      7,
      2,
      {
        reassignments: [
          {
            taskId: 99,
            moduleId: 12,
            featureId: 33,
            rowVersion: 4,
            assigneeIds: [3, 5],
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringContaining("project-member-remove-"),
        }),
      }),
    );
    await screen.findByText(/成员已移出项目/);
  });

  it("lets a system admin promote a member through a confirmation dialog (ADR-039)", async () => {
    const client = baseClient();
    const setProjectMemberRole = vi.fn().mockResolvedValue({
      member: { ...owner, role: "LEADER" },
    });
    const api = {
      ...client,
      setProjectMemberRole,
    } as unknown as InpulseApiClient;
    mount(api, { isSystemAdmin: true, viewerRole: "MEMBER" });

    await screen.findAllByText(/开发者 C/);
    fireEvent.click(screen.getByRole("button", { name: "设为组长" }));
    const dialog = await screen.findByRole("dialog", { name: "确认设为组长" });
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "确认设为组长" }),
    );

    await waitFor(() => expect(setProjectMemberRole).toHaveBeenCalledTimes(1));
    expect(setProjectMemberRole).toHaveBeenCalledWith(
      7,
      2,
      { role: "LEADER" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringContaining("project-member-role-"),
        }),
      }),
    );
    await screen.findByText(/已将 开发者 C 设为项目组长/);
  });

  it("offers leader promotion to system admins and protects the leader card from removal", async () => {
    const client = baseClient();
    const leader: ProjectMemberRecordItem = {
      ...owner,
      membershipId: 12,
      userId: 6,
      name: "组长本人",
      role: "LEADER",
    };
    client.listProjectMembers.mockResolvedValue({ items: [owner, leader] });
    const api = client as unknown as InpulseApiClient;
    mount(api, { isSystemAdmin: true });

    await screen.findByText("组长本人");
    expect(screen.getByText("组长")).toBeInTheDocument();
    const removeButtons = screen.getAllByRole("button", { name: /移\s*除/ });
    // 组长卡片既不能移除也不能改角色，只有普通成员两样都有。
    expect(removeButtons).toHaveLength(1);
    fireEvent.click(removeButtons[0]!);
    const dialog = await screen.findByRole("dialog", {
      name: "移除项目成员",
    });
    expect(within(dialog).getByText(/开发者 C/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /取\s*消/ }));

    const roleButtons = screen.getAllByRole("button", { name: "设为组长" });
    expect(roleButtons).toHaveLength(1);
    fireEvent.click(roleButtons[0]!);
    const roleDialog = await screen.findByRole("dialog", {
      name: "确认设为组长",
    });
    expect(
      within(roleDialog).getByText(/将 开发者 C 设为项目组长/),
    ).toBeInTheDocument();
    expect(within(roleDialog).queryByRole("radio")).toBeNull();
  });

  it("lets the project leader transfer the role to another member only (ADR-053)", async () => {
    const client = baseClient();
    const leader: ProjectMemberRecordItem = {
      ...owner,
      membershipId: 12,
      userId: 6,
      name: "组长本人",
      role: "LEADER",
    };
    client.listProjectMembers.mockResolvedValue({ items: [owner, leader] });
    const setProjectMemberRole = vi.fn().mockResolvedValue({
      member: { ...owner, role: "LEADER" },
    });
    const api = {
      ...client,
      setProjectMemberRole,
    } as unknown as InpulseApiClient;
    mount(api, { isSystemAdmin: false, viewerRole: "LEADER" });

    await screen.findByText("组长本人");
    // 组长自己的卡片没有动作按钮，其他成员卡片只有「转移组长」。
    expect(screen.queryByRole("button", { name: "设为组长" })).toBeNull();
    const transferButtons = screen.getAllByRole("button", {
      name: "转移组长",
    });
    expect(transferButtons).toHaveLength(1);
    fireEvent.click(transferButtons[0]!);

    const dialog = await screen.findByRole("dialog", { name: "确认转移组长" });
    expect(
      within(dialog).getByText(/将组长身份转交给 开发者 C/),
    ).toBeInTheDocument();
    // 组长不能撤销组长：弹窗不再提供角色选项，只确认转移。
    expect(within(dialog).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认转移" }));

    await waitFor(() => expect(setProjectMemberRole).toHaveBeenCalledTimes(1));
    expect(setProjectMemberRole).toHaveBeenCalledWith(
      7,
      2,
      { role: "LEADER" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-token",
          "Idempotency-Key": expect.stringContaining("project-member-role-"),
        }),
      }),
    );
    await screen.findByText(/已将组长身份转交给 开发者 C/);
  });

  it("lets a non-admin member remove members but never appoint roles (ADR-039/ADR-053)", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient, {
      isSystemAdmin: false,
      viewerRole: "MEMBER",
    });
    await screen.findAllByText(/开发者 C/);
    expect(
      screen.queryByRole("button", { name: "设为组长" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "转移组长" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /移\s*除/ })).toBeInTheDocument();
  });
});
