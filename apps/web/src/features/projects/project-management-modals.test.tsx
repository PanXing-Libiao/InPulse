import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type ProjectItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { EditProjectModal } from "./ProjectManagementModals";

const project: ProjectItem = {
  id: 7,
  code: "SHOP",
  name: "商城系统",
  description: "商城项目描述",
  status: "ACTIVE",
  hasCompletedTask: false,
  rowVersion: 3,
  createdBy: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 3,
    openTaskCount: 5,
    completedTaskCount: 1,
  },
};

function renderWithProviders(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthStateProvider
        value={{
          status: "authenticated",
          user: {
            id: 1,
            loginName: "developer",
            name: "开发者 C",
            email: null,
            avatarUrl: null,
            isAdmin: true,
            status: "ACTIVE",
          },
        }}
      >
        {node}
      </AuthStateProvider>
    </QueryClientProvider>,
  );
}

describe("EditProjectModal", () => {
  it("submits name and description with CSRF, If-Match and idempotency headers", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const updateProject = vi.fn().mockResolvedValue({
      project: { ...project, name: "商城系统二期", rowVersion: 4 },
    });
    const client = {
      issueCsrfToken,
      updateProject,
    } as unknown as InpulseApiClient;
    const onUpdated = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        onUpdated={onUpdated}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(
      within(dialog).queryByRole("button", { name: "保存状态" }),
    ).toBeNull();
    const nameInput = within(dialog).getByLabelText("项目名称");
    fireEvent.change(nameInput, { target: { value: "商城系统二期" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存修改" }),
    );

    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject).toHaveBeenCalledWith(
      7,
      { name: "商城系统二期", description: "商城项目描述" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "If-Match": '"3"',
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ name: "商城系统二期", rowVersion: 4 }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces version conflicts without closing the form", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const updateProject = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "PROJECT_VERSION_CONFLICT",
        message: "项目版本已变化",
        details: {},
        requestId: "req-1",
      }),
    );
    const client = {
      issueCsrfToken,
      updateProject,
    } as unknown as InpulseApiClient;
    const onClose = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        onUpdated={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    fireEvent.change(within(dialog).getByLabelText("项目名称"), {
      target: { value: "商城系统二期" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存修改" }),
    );

    expect(
      await within(dialog).findByText(
        "项目内容已被他人更新，请加载最新版本后重试。",
      ),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("只改状态时点「保存修改」即保存并关闭弹窗", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const updateProject = vi.fn();
    const changeProjectStatus = vi.fn().mockResolvedValue({
      project: { ...project, status: "MAINTENANCE", rowVersion: 3 },
    });
    const client = {
      issueCsrfToken,
      updateProject,
      changeProjectStatus,
    } as unknown as InpulseApiClient;
    const onUpdated = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        canChangeStatus
        onUpdated={onUpdated}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    const save = within(dialog).getByRole("button", { name: "保存修改" });
    expect(save).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "维护中" }),
    );
    expect(save).not.toBeDisabled();
    await userEvent.click(save);

    await waitFor(() => expect(changeProjectStatus).toHaveBeenCalledTimes(1));
    expect(changeProjectStatus).toHaveBeenCalledWith(
      7,
      { status: "MAINTENANCE" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "If-Match": '"3"',
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    expect(updateProject).not.toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "MAINTENANCE", rowVersion: 3 }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("字段与状态同时改动时按新版本串行保存，只回调最终结果", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const updateProject = vi.fn().mockResolvedValue({
      project: { ...project, name: "商城系统二期", rowVersion: 4 },
    });
    const changeProjectStatus = vi.fn().mockResolvedValue({
      project: {
        ...project,
        name: "商城系统二期",
        status: "MAINTENANCE",
        rowVersion: 4,
      },
    });
    const client = {
      issueCsrfToken,
      updateProject,
      changeProjectStatus,
    } as unknown as InpulseApiClient;
    const onUpdated = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        canChangeStatus
        onUpdated={onUpdated}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    fireEvent.change(within(dialog).getByLabelText("项目名称"), {
      target: { value: "商城系统二期" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "维护中" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存修改" }),
    );

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledTimes(1);
      expect(changeProjectStatus).toHaveBeenCalledTimes(1);
    });
    expect(updateProject).toHaveBeenCalledWith(
      7,
      { name: "商城系统二期", description: "商城项目描述" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "If-Match": '"3"',
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    expect(changeProjectStatus).toHaveBeenCalledWith(
      7,
      { status: "MAINTENANCE" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "If-Match": '"4"',
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    expect(updateProject.mock.invocationCallOrder[0]!).toBeLessThan(
      changeProjectStatus.mock.invocationCallOrder[0]!,
    );
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "商城系统二期",
        status: "MAINTENANCE",
        rowVersion: 4,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("已有完成任务时不能再退回「未开始」，越级切换「维护中」也置灰", async () => {
    const client = {
      issueCsrfToken: vi.fn(),
      changeProjectStatus: vi.fn(),
    } as unknown as InpulseApiClient;
    renderWithProviders(
      <EditProjectModal
        open
        project={{ ...project, hasCompletedTask: true }}
        client={client}
        canChangeStatus
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(
      within(dialog).getByRole("button", { name: "未开始" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "维护中" }),
    ).not.toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "未开始" }).title).toBe(
      "项目里已经出现过已完成任务，不能再退回未开始",
    );
  });

  it("未开始的项目不能直接切到维护中", async () => {
    const client = {
      issueCsrfToken: vi.fn(),
      changeProjectStatus: vi.fn(),
    } as unknown as InpulseApiClient;
    renderWithProviders(
      <EditProjectModal
        open
        project={{ ...project, status: "NOT_STARTED" }}
        client={client}
        canChangeStatus
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(within(dialog).getByRole("button", { name: "维护中" }).title).toBe(
      "未开始与维护中不能直接互相切换，请先切到进行中",
    );
    expect(
      within(dialog).getByRole("button", { name: "进行中" }),
    ).not.toBeDisabled();
  });

  it("维护中的项目不能直接切回未开始", async () => {
    const client = {
      issueCsrfToken: vi.fn(),
      changeProjectStatus: vi.fn(),
    } as unknown as InpulseApiClient;
    renderWithProviders(
      <EditProjectModal
        open
        project={{ ...project, status: "MAINTENANCE" }}
        client={client}
        canChangeStatus
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(
      within(dialog).getByRole("button", { name: "未开始" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "进行中" }),
    ).not.toBeDisabled();
  });

  it("无状态变更权限时只展示标签，保存修改保持禁用", async () => {
    const client = {
      issueCsrfToken: vi.fn(),
      changeProjectStatus: vi.fn(),
    } as unknown as InpulseApiClient;
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(within(dialog).queryByRole("button", { name: "维护中" })).toBeNull();
    expect(within(dialog).getByText("进行中")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "保存修改" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(
        "只有本项目活跃成员或系统管理员可以更改项目状态。",
      ),
    ).toBeTruthy();
  });

  it("没有任何改动时不发请求，也不递增版本号", async () => {
    const issueCsrfToken = vi.fn();
    const updateProject = vi.fn();
    const changeProjectStatus = vi.fn();
    const client = {
      issueCsrfToken,
      updateProject,
      changeProjectStatus,
    } as unknown as InpulseApiClient;
    const onClose = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        canChangeStatus
        onUpdated={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(
      within(dialog).getByRole("button", { name: "保存修改" }),
    ).toBeDisabled();
    const form = dialog.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(issueCsrfToken).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    expect(changeProjectStatus).not.toHaveBeenCalled();
  });

  it("有删除权限时展示删除入口，二次确认后带 CSRF、If-Match 与幂等键调用 deleteProject", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-9" });
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const client = {
      issueCsrfToken,
      deleteProject,
    } as unknown as InpulseApiClient;
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        canDeleteProject
        onUpdated={vi.fn()}
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    const entry = within(dialog).getByRole("button", { name: "删除项目" });
    // ADR-062：删除入口位于弹窗页脚最左侧，与取消/保存修改分开。
    expect(entry.closest(".calm-action-footer")).not.toBeNull();
    expect(entry.classList.contains("footer-leading")).toBe(true);
    // 编辑弹窗本身不直接删除，先打开二次确认。
    await userEvent.click(entry);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("dialog", {
      name: "确认删除项目",
    });
    expect(
      within(confirm).getByText("确认删除项目「商城系统」？"),
    ).toBeTruthy();
    expect(within(confirm).getByText(/该项目的历史审计链会保留/)).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "确认删除" }),
    );

    await waitFor(() => expect(deleteProject).toHaveBeenCalledTimes(1));
    expect(deleteProject).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-9",
          "If-Match": '"3"',
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("无删除权限时不渲染删除入口", async () => {
    const client = {
      issueCsrfToken: vi.fn(),
      deleteProject: vi.fn(),
    } as unknown as InpulseApiClient;
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    expect(within(dialog).queryByTestId("delete-project-button")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "删除项目" }),
    ).toBeNull();
    expect(screen.queryByRole("dialog", { name: "确认删除项目" })).toBeNull();
  });

  it("删除被拒绝时展示服务端文案、不触发 onDeleted 且确认弹窗保持打开", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-9" });
    const deleteProject = vi.fn().mockRejectedValue(
      new ApiError(403, {
        code: "PROJECT_DELETE_FORBIDDEN",
        message: "只有项目组长或系统管理员可以删除项目",
        details: {},
        requestId: "req-del",
      }),
    );
    const client = {
      issueCsrfToken,
      deleteProject,
    } as unknown as InpulseApiClient;
    const onDeleted = vi.fn();
    renderWithProviders(
      <EditProjectModal
        open
        project={project}
        client={client}
        canDeleteProject
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "编辑项目" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "删除项目" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "确认删除项目",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "确认删除" }),
    );

    await waitFor(() => expect(deleteProject).toHaveBeenCalledTimes(1));
    expect(
      await within(confirm).findByText(
        "只有项目组长或系统管理员可以删除项目。",
      ),
    ).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认删除项目" })).toBeTruthy();
  });
});
