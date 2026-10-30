import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { InpulseApiClient, SearchItem } from "@generated/api";
import { SearchPage } from "./SearchPage";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("SearchPage", () => {
  it("loads search results from the q URL parameter", async () => {
    const getSearch = vi.fn().mockResolvedValue({
      items: [
        {
          projectId: 1,
          entityType: "MODULE",
          entityId: 3,
          moduleId: 2,
          recordId: null,
          title: "InPulse 模块",
          summary: "模块摘要",
        } satisfies SearchItem,
      ],
      nextCursor: null,
      hasMore: false,
    });
    const client = { getSearch } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/search?q=inpulse"]}>
          <Routes>
            <Route path="/search" element={<SearchPage client={client} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("InPulse 模块")).toBeInTheDocument();
    expect(getSearch).toHaveBeenCalledWith({
      q: "inpulse",
      cursor: undefined,
      limit: 20,
    });
  });

  it("navigates to the result's own page instead of staying on the search page", async () => {
    const user = userEvent.setup();
    const getSearch = vi.fn().mockResolvedValue({
      items: [
        {
          projectId: 1,
          entityType: "MODULE",
          entityId: 3,
          moduleId: 2,
          recordId: null,
          title: "InPulse 模块",
          summary: "模块摘要",
        } satisfies SearchItem,
      ],
      nextCursor: null,
      hasMore: false,
    });
    const client = { getSearch } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/search?q=inpulse"]}>
          <Routes>
            <Route path="/search" element={<SearchPage client={client} />} />
            <Route
              path="/projects/:projectId/modules/:moduleId/tasks"
              element={<div>模块任务落地页</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("link", { name: /InPulse 模块/ }));
    expect(await screen.findByText("模块任务落地页")).toBeInTheDocument();
  });
});
