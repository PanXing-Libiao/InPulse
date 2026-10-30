import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiError,
  type CreateProjectResponse,
  type InpulseApiClient,
  type ProjectItem,
} from "@generated/api";
import {
  canDeleteProject,
  describeCreateProjectError,
  useCreateProject,
  useProjects,
} from "./project-query";

const projectItem: ProjectItem = {
  id: 7,
  code: "SHOP",
  name: "商城系统",
  description: "商城项目描述",
  status: "ACTIVE",
  hasCompletedTask: false,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 1,
  stats: {
    activeModuleCount: 0,
    openTaskCount: 0,
    completedTaskCount: 1,
  },
};

const createdProject: CreateProjectResponse = {
  project: {
    id: 7,
    code: "SHOP",
    name: "商城系统",
    description: "商城项目描述",
    status: "NOT_STARTED",
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  },
  members: [
    {
      userId: 1,
      status: "ACTIVE",
      role: "LEADER",
      joinedAt: "2026-09-09T00:00:00.000Z",
    },
  ],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { readonly children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe("project creation query", () => {
  it("loads the server-side visible project list", async () => {
    const listProjects = vi.fn().mockResolvedValue({
      items: [projectItem],
    });
    const client = { listProjects } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjects({ client }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.data).toEqual({ items: [projectItem] });
  });

  it("issues CSRF and sends an idempotency key", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const client = {
      issueCsrfToken,
      createProject,
    } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateProject({ client }), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        name: "商城系统",
        code: "SHOP",
        description: "商城项目描述",
        memberIds: [],
      });
    });

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith(
      {
        name: "商城系统",
        code: "SHOP",
        description: "商城项目描述",
        memberIds: [],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
  });

  it("maps the server conflict without leaking internal messages", () => {
    const error = new ApiError(409, {
      code: "PROJECT_BOOTSTRAP_CONFLICT",
      message: "internal-conflict-message",
      details: {},
      requestId: "request-1",
    });
    const message = describeCreateProjectError(error);
    expect(message).toBe("项目编码已存在或创建请求发生冲突，请刷新后重试。");
    expect(message).not.toContain("internal-conflict-message");
  });

  it("points at the project code when the server reports PROJECT_CODE_CONFLICT", () => {
    const error = new ApiError(409, {
      code: "PROJECT_CODE_CONFLICT",
      message: "internal-code-conflict-message",
      details: {},
      requestId: "request-2",
    });
    const message = describeCreateProjectError(error);
    expect(message).toBe("项目编码已被占用，请更换项目编码后重试。");
    expect(message).not.toContain("internal-code-conflict-message");
  });
});

describe("canDeleteProject", () => {
  it("只对系统管理员与本项目组长放行（ADR-062）", () => {
    expect(canDeleteProject(true, null)).toBe(true);
    expect(canDeleteProject(true, "MEMBER")).toBe(true);
    expect(canDeleteProject(false, "LEADER")).toBe(true);
    expect(canDeleteProject(false, "MEMBER")).toBe(false);
    expect(canDeleteProject(false, null)).toBe(false);
    expect(canDeleteProject(false, undefined)).toBe(false);
  });
});
