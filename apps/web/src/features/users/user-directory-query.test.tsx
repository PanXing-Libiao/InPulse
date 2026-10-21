import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type InpulseApiClient } from "@generated/api";
import {
  describeUserDirectoryError,
  useUserDirectoryQuery,
} from "./user-directory-query";

describe("user directory query", () => {
  it("consumes the generated API and returns only the exposed fields", async () => {
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false }],
    });
    const client = { getUserDirectory } as unknown as InpulseApiClient;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { readonly children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUserDirectoryQuery({ client }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getUserDirectory).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual([
      { id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false },
    ]);
  });

  it("maps the server 401 without leaking internal details", async () => {
    const getUserDirectory = vi.fn().mockRejectedValue(
      new ApiError(401, {
        code: "USER_DIRECTORY_UNAUTHENTICATED",
        message: "internal-auth-message",
        details: {},
        requestId: "request-1",
      }),
    );
    const error = describeUserDirectoryError(
      await getUserDirectory().catch((value: unknown) => value),
    );
    expect(error).toBe("登录状态已失效，请重新登录。");
    expect(error).not.toContain("internal-auth-message");
  });
});
