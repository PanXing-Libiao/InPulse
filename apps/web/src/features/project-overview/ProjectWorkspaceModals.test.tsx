import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CurrentUserResponse, InpulseApiClient } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import {
  ProjectWorkspaceModals,
  type ProjectWorkspaceModalKind,
} from "./ProjectWorkspaceModals";

/**
 * 弹层内容 chunk 的闸门（2026-10-12）：用它把「chunk 还没到位」这段窗口固定下来。
 *
 * 旧实现把 Suspense 边界放在弹层内部、fallback 为 null，于是点「查看全部」时弹层先以
 * 「只有标题、正文空白」的空壳出现（本机实测 129px、约 330ms），chunk 到位后才跳成骨架
 * 与内容——用户看到的是「闪出一个没有记录的迭代记录弹窗」。本用例是这条回归的防线：
 * chunk 未就绪时整块不渲染，就绪后才出现弹层。
 */
const chunkGate = vi.hoisted(() => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate: gate, release: () => release() };
});

vi.mock("@features/records/RecordsWorkspace", async () => {
  await chunkGate.gate;
  return {
    RecordsWorkspace: () => <p>记录工作区内容</p>,
  };
});

const member: CurrentUserResponse = {
  id: 3,
  loginName: "dev-c",
  name: "开发者 C",
  email: null,
  avatarUrl: null,
  isAdmin: false,
  status: "ACTIVE",
};

const wecomStatus = {
  state: "UNBOUND",
  codeExpiresAt: null,
  boundAt: null,
  boundByName: null,
  lastDeliveryError: null,
  botProfileUrl: null,
  webhookTargets: [],
  notificationOptions: { disabledCategories: [] },
};

const client = {
  getProjectWecomGroup: vi.fn().mockResolvedValue(wecomStatus),
  getProject: vi.fn().mockResolvedValue({
    project: {
      id: 3,
      code: "FIELD_APP",
      name: "移动端现场作业 App",
      description: "",
      status: "ACTIVE",
      hasCompletedTask: false,
      rowVersion: 1,
      createdBy: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      memberCount: 2,
      stats: {
        activeModuleCount: 1,
        activeFeatureCount: 2,
        openTaskCount: 3,
        completedTaskCount: 0,
      },
    },
    currentUserRole: "MEMBER",
  }),
} as unknown as InpulseApiClient;

const renderModals = ({
  open = "records",
  modalClient = client,
}: {
  readonly open?: ProjectWorkspaceModalKind;
  readonly modalClient?: InpulseApiClient;
} = {}) =>
  render(
    <AuthStateProvider value={{ status: "authenticated", user: member }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProjectWorkspaceModals
          projectId={3}
          client={modalClient}
          open={open}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    </AuthStateProvider>,
  );

describe("ProjectWorkspaceModals", () => {
  it("内容 chunk 就绪前不渲染弹层，避免先闪出没有内容的空壳", async () => {
    renderModals();
    // chunk 未到位：弹层整块不渲染（旧实现在这里会立刻出现标题为「迭代记录」的空壳）。
    expect(screen.queryByRole("dialog", { name: "迭代记录" })).toBeNull();
    chunkGate.release();
    expect(
      await screen.findByRole("dialog", { name: "迭代记录" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("记录工作区内容")).toBeInTheDocument();
  });

  it("在项目主页企微弹窗中为普通成员保留只读视图", async () => {
    renderModals({ open: "wecom" });

    expect(
      await screen.findByRole("dialog", { name: "企业微信项目群" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("只有项目组长或系统管理员可以生成绑定码或解绑。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成绑定码" })).toBeNull();
  });

  it("在项目主页企微弹窗中为组长显示绑定操作", async () => {
    const leaderClient = {
      getProjectWecomGroup: vi.fn().mockResolvedValue(wecomStatus),
      getProject: vi.fn().mockResolvedValue({
        project: {
          id: 3,
          code: "FIELD_APP",
          name: "移动端现场作业 App",
          description: "",
          status: "ACTIVE",
          hasCompletedTask: false,
          rowVersion: 1,
          createdBy: 3,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
          memberCount: 2,
          stats: {
            activeModuleCount: 1,
            activeFeatureCount: 2,
            openTaskCount: 3,
            completedTaskCount: 0,
          },
        },
        currentUserRole: "LEADER",
      }),
    } as unknown as InpulseApiClient;

    renderModals({ open: "wecom", modalClient: leaderClient });

    expect(
      await screen.findByRole("button", { name: "生成绑定码" }),
    ).toBeInTheDocument();
  });
});
