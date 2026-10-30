import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InpulseApiClient, SearchItem, SearchPage } from "@generated/api";
import { useSearchInfiniteQuery } from "./search-query";

function createQueryWrapper() {
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

function createSearchItem(
  entityType: SearchItem["entityType"],
  id: number,
): SearchItem {
  return {
    projectId: 1,
    entityType,
    entityId: id,
    moduleId: null,
    recordId: null,
    title: `title-${id}`,
    summary: `summary-${id}`,
  };
}

describe("useSearchInfiniteQuery", () => {
  it("sends normalized query and follows the next cursor", async () => {
    const firstPage: SearchPage = {
      items: [createSearchItem("PROJECT", 1)],
      nextCursor: "cursor-1",
      hasMore: true,
    };
    const secondPage: SearchPage = {
      items: [createSearchItem("TASK", 2)],
      nextCursor: null,
      hasMore: false,
    };
    const getSearch = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const client = { getSearch } as unknown as InpulseApiClient;
    const { wrapper } = createQueryWrapper();

    const { result } = renderHook(
      () => useSearchInfiniteQuery({ query: " inpulse ", client }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getSearch).toHaveBeenCalledWith({
      q: "inpulse",
      cursor: undefined,
      limit: 20,
    });
    expect(result.current.data?.pages).toEqual([firstPage]);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(getSearch).toHaveBeenLastCalledWith({
      q: "inpulse",
      cursor: "cursor-1",
      limit: 20,
    });
  });

  it("does not issue a request for an empty query", () => {
    const getSearch = vi.fn();
    const client = { getSearch } as unknown as InpulseApiClient;
    const { wrapper } = createQueryWrapper();

    renderHook(() => useSearchInfiniteQuery({ query: "   ", client }), {
      wrapper,
    });

    expect(getSearch).not.toHaveBeenCalled();
  });

  it("issues a request for a single-character query", async () => {
    const getSearch = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    const client = { getSearch } as unknown as InpulseApiClient;
    const { wrapper } = createQueryWrapper();

    renderHook(() => useSearchInfiniteQuery({ query: "甲", client }), {
      wrapper,
    });

    await waitFor(() => expect(getSearch).toHaveBeenCalledTimes(1));
    expect(getSearch).toHaveBeenCalledWith({
      q: "甲",
      cursor: undefined,
      limit: 20,
    });
  });
});
