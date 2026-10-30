import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type ProjectMemberRecordItem,
} from "@generated/api";
import {
  projectMemberErrorMessage,
  useProjectMembers,
} from "./project-member-query";

const activeMember: ProjectMemberRecordItem = {
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

describe("project member query", () => {
  it("reads the admin member history through the generated client", async () => {
    const listProjectMembers = vi.fn().mockResolvedValue({
      items: [activeMember],
    });
    const client = {
      listProjectMembers,
    } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectMembers(7, client), {
      wrapper,
    });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(listProjectMembers).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.query.data?.items).toEqual([activeMember]);
  });

  it("sends CSRF and idempotency key when adding a member", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const addProjectMember = vi
      .fn()
      .mockResolvedValue({ member: activeMember });
    const client = {
      issueCsrfToken,
      addProjectMember,
    } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectMembers(7, client), {
      wrapper,
    });

    await act(async () => {
      await result.current.addMutation.mutateAsync({ userIds: [2] });
    });

    expect(addProjectMember).toHaveBeenCalledWith(
      7,
      { userId: 2 },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "Idempotency-Key": expect.stringContaining("project-member-add-"),
        }),
      }),
    );
  });

  it("adds several members in one submit with one idempotency key per user", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const addProjectMember = vi
      .fn()
      .mockResolvedValue({ member: activeMember });
    const client = {
      issueCsrfToken,
      addProjectMember,
    } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectMembers(7, client), {
      wrapper,
    });

    let outcome: Awaited<
      ReturnType<typeof result.current.addMutation.mutateAsync>
    > | null = null;
    await act(async () => {
      outcome = await result.current.addMutation.mutateAsync({
        userIds: [2, 4, 6],
      });
    });

    expect(addProjectMember).toHaveBeenCalledTimes(3);
    expect(addProjectMember.mock.calls.map((call) => call[1])).toEqual([
      { userId: 2 },
      { userId: 4 },
      { userId: 6 },
    ]);
    const keys = addProjectMember.mock.calls.map(
      (call) =>
        (
          call[2] as {
            readonly headers: { readonly "Idempotency-Key": string };
          }
        ).headers["Idempotency-Key"],
    );
    expect(new Set(keys).size).toBe(3);
    expect(outcome).toEqual({ added: [2, 4, 6], failures: [] });
  });

  it("keeps the same idempotency key when retrying after a failed attempt", async () => {
    const issueCsrfToken = vi
      .fn()
      .mockResolvedValueOnce({ csrfToken: "csrf-1" })
      .mockResolvedValueOnce({ csrfToken: "csrf-2" });
    const addProjectMember = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: "PROJECT_MEMBER_ALREADY_ACTIVE",
          message: "internal",
          details: {},
          requestId: "r1",
        }),
      )
      .mockResolvedValueOnce({ member: activeMember });
    const client = {
      issueCsrfToken,
      addProjectMember,
    } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectMembers(7, client), {
      wrapper,
    });

    await expect(
      result.current.addMutation.mutateAsync({ userIds: [2] }),
    ).resolves.toMatchObject({ added: [], failures: [{ userId: 2 }] });
    await expect(
      result.current.addMutation.mutateAsync({ userIds: [2] }),
    ).resolves.toMatchObject({ added: [2], failures: [] });

    const firstKey = (
      addProjectMember.mock.calls[0]![2] as {
        readonly headers: { readonly "Idempotency-Key": string };
      }
    ).headers["Idempotency-Key"];
    const secondKey = (
      addProjectMember.mock.calls[1]![2] as {
        readonly headers: { readonly "Idempotency-Key": string };
      }
    ).headers["Idempotency-Key"];
    expect(secondKey).toBe(firstKey);
  });

  it("sends reassignment details when removing a member", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const removeProjectMember = vi.fn().mockResolvedValue({
      member: {
        ...activeMember,
        status: "REMOVED",
        removedAt: "2026-09-09T01:00:00.000Z",
      },
      reassignedTaskIds: [99],
      unfinishedTaskCount: 0,
    });
    const client = {
      issueCsrfToken,
      removeProjectMember,
    } as unknown as InpulseApiClient;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProjectMembers(7, client), {
      wrapper,
    });

    await act(async () => {
      await result.current.removeMutation.mutateAsync({
        userId: 2,
        reassignments: [
          {
            taskId: 99,
            moduleId: 12,
            rowVersion: 4,
            assigneeIds: [3],
          },
        ],
      });
    });

    expect(removeProjectMember).toHaveBeenCalledWith(
      7,
      2,
      {
        reassignments: [
          {
            taskId: 99,
            moduleId: 12,
            rowVersion: 4,
            assigneeIds: [3],
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-1",
          "Idempotency-Key": expect.stringContaining("project-member-remove-"),
        }),
      }),
    );
  });

  it("maps member errors without leaking internal messages", () => {
    // ADR-039 后服务端不再返回 `PROJECT_MEMBER_MANAGE_FORBIDDEN`，这里用旧码
    // 验证 403 兜底文案仍然泛化、不泄露内部信息。
    const forbidden = new ApiError(403, {
      code: "PROJECT_MEMBER_MANAGE_FORBIDDEN",
      message: "internal-forbidden",
      details: {},
      requestId: "r",
    });
    const roleForbidden = new ApiError(403, {
      code: "PROJECT_MEMBER_ROLE_FORBIDDEN",
      message: "internal-role-forbidden",
      details: {},
      requestId: "r",
    });
    const leaderProtected = new ApiError(409, {
      code: "PROJECT_MEMBER_LEADER_PROTECTED",
      message: "internal-leader-protected",
      details: {},
      requestId: "r",
    });
    const notFound = new ApiError(404, {
      code: "PROJECT_MEMBER_NOT_FOUND",
      message: "internal-404",
      details: {},
      requestId: "r",
    });
    expect(projectMemberErrorMessage(forbidden)).toBe(
      "安全校验未通过，请刷新页面后重试。",
    );
    expect(projectMemberErrorMessage(roleForbidden)).toBe(
      "只有系统管理员或本项目组长可以设定组长，且组长只能把身份转交给其他成员。",
    );
    expect(projectMemberErrorMessage(leaderProtected)).toBe(
      "项目组长不能被直接移除，请先把其他成员设为组长（转移）。",
    );
    expect(projectMemberErrorMessage(notFound)).toBe(
      "项目或成员不存在，或你已无权访问。",
    );
    expect(projectMemberErrorMessage(notFound)).not.toContain("internal-404");
  });
});
