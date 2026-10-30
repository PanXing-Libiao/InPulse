import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type CurrentUserResponse,
  type InpulseApiClient,
  type ModuleItem,
  type ProjectDetailResponse,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ModuleEditorModal } from "./ModuleEditorModal";

const normalModule: ModuleItem = {
  id: 9,
  projectId: 2,
  code: "PAY-M-2",
  name: "结算模块",
  description: "结算相关能力",
  kind: "NORMAL",
  sortOrder: 0,
  rowVersion: 7,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  stats: { openTaskCount: 3, completedTaskCount: 1 },
};

const unclassifiedModule: ModuleItem = {
  ...normalModule,
  id: 3,
  code: "PAY-M-0",
  name: "未分类模块",
  kind: "UNCLASSIFIED",
  stats: { openTaskCount: 0, completedTaskCount: 1 },
};

const project: ProjectDetailResponse["project"] = {
  id: 2,
  code: "PAY",
  name: "结算系统",
  description: "",
  status: "ACTIVE",
  hasCompletedTask: true,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  memberCount: 3,
  stats: {
    activeModuleCount: 2,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

function user(isAdmin: boolean): CurrentUserResponse {
  return {
    id: 7,
    loginName: isAdmin ? "tege" : "shaochenyu",
    name: isAdmin ? "管理员" : "邵晨宇",
    email: null,
    avatarUrl: null,
    isAdmin,
    status: "ACTIVE",
  };
}

function mount(options: {
  readonly item: ModuleItem;
  readonly role: "MEMBER" | "LEADER" | null;
  readonly isAdmin: boolean;
  readonly deleteModule?: typeof vi.fn | undefined;
}) {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const client = {
    listModules: vi.fn().mockResolvedValue({ items: [options.item] }),
    getProject: vi.fn().mockResolvedValue({
      project,
      currentUserRole: options.role,
    } satisfies ProjectDetailResponse),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    deleteModule:
      options.deleteModule ??
      vi.fn().mockResolvedValue({
        id: options.item.id,
        projectId: 2,
        code: options.item.code,
        name: options.item.name,
        kind: options.item.kind,
        deletedTaskCount: 4,
        deletedRecordCount: 1,
        removedLinkCount: 3,
      }),
  } as unknown as InpulseApiClient;

  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider
        value={{ status: "authenticated", user: user(options.isAdmin) }}
      >
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter>
            <ModuleEditorModal
              projectId={2}
              client={client}
              projectName="结算系统"
              request={{ action: "update", item: options.item }}
              onClose={onClose}
              onDeleted={onDeleted}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthStateProvider>
    </ConfigProvider>,
  );
  return { client, onClose, onDeleted };
}

describe("ADR-096 模块编辑弹窗的删除入口", () => {
  it("组长编辑普通模块时显示删除入口，按影响面确认后带 If-Match 删除", async () => {
    const { client, onClose, onDeleted } = mount({
      item: normalModule,
      role: "LEADER",
      isAdmin: false,
    });

    const entry = await screen.findByRole("button", { name: "删除模块" });
    expect(entry.className).toContain("danger-button");
    fireEvent.click(entry);

    expect(await screen.findByText("确认删除模块")).toBeTruthy();
    expect(
      screen.getByText(/该模块下有 3 项未完成任务与 1 项已完成任务/),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/全部迭代记录、版本、遗留项与 GitHub 链接关联/)
        .length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("confirm-delete-module"));

    await waitFor(() =>
      expect(client.deleteModule).toHaveBeenCalledWith(
        2,
        9,
        { reason: null },
        {
          headers: {
            "x-csrf-token": "a".repeat(43),
            "Idempotency-Key": expect.stringMatching(/^module-delete-/),
            "If-Match": '"7"',
          },
        },
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("空模块的影响面说明只影响模块自身", async () => {
    mount({
      item: {
        ...normalModule,
        stats: {
          openTaskCount: 0,
          completedTaskCount: 0,
        },
      },
      role: "LEADER",
      isAdmin: false,
    });

    fireEvent.click(await screen.findByRole("button", { name: "删除模块" }));

    expect(
      await screen.findByText(
        /该模块下没有未完成或已完成的任务：确认删除只影响模块自身。/,
      ),
    ).toBeTruthy();
  });

  it("普通成员看不到删除入口", async () => {
    mount({ item: normalModule, role: "MEMBER", isAdmin: false });

    // 弹窗本身照常打开（标题「编辑模块」），只是没有删除入口。
    expect(await screen.findByText("编辑模块")).toBeTruthy();
    // antd 会在两个汉字的按钮文案中间自动插一个空格（「保 存」）。
    expect(await screen.findByRole("button", { name: /保\s*存/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除模块" })).toBeNull();
  });

  it("未分类模块即使系统管理员也不渲染删除入口", async () => {
    mount({ item: unclassifiedModule, role: "LEADER", isAdmin: true });

    expect(await screen.findByText("编辑模块")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除模块" })).toBeNull();
  });

  it("系统管理员可删除普通模块", async () => {
    mount({ item: normalModule, role: null, isAdmin: true });

    expect(
      await screen.findByRole("button", { name: "删除模块" }),
    ).toBeTruthy();
  });

  it("服务端拒绝时把原因透出，确认弹层保持打开且不回调宿主", async () => {
    const deleteModule = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "MODULE_UNCLASSIFIED_PROTECTED",
        message: "未分类模块不能删除",
        details: {},
        requestId: "test",
      }),
    );
    const { onDeleted, onClose } = mount({
      item: normalModule,
      role: "LEADER",
      isAdmin: false,
      deleteModule,
    });

    fireEvent.click(await screen.findByRole("button", { name: "删除模块" }));
    fireEvent.click(await screen.findByTestId("confirm-delete-module"));

    expect(await screen.findByText("未分类模块不能删除。")).toBeTruthy();
    expect(screen.getByText("确认删除模块")).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
