import type { NavigateFunction } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { navigatePrepared } from "./navigate-prepared";
import { preloadRoutePath } from "./route-preload";

vi.mock("./route-preload", () => ({ preloadRoutePath: vi.fn() }));

const preload = vi.mocked(preloadRoutePath);

beforeEach(() => {
  preload.mockReset();
  preload.mockResolvedValue(undefined);
});

describe("navigatePrepared", () => {
  it("waits for the target chunk and prepared data before navigating", async () => {
    const events: string[] = [];
    preload.mockImplementation(async () => {
      events.push("route");
    });
    const navigate = vi.fn(() => {
      events.push("navigate");
    });

    await navigatePrepared(
      navigate as unknown as NavigateFunction,
      "/records?publishedId=9",
      {
        prepare: async () => {
          events.push("data");
        },
      },
    );

    expect(events).toEqual(["data", "route", "navigate"]);
    expect(navigate).toHaveBeenCalledWith("/records?publishedId=9", {});
  });

  it("still navigates when data preparation fails", async () => {
    const navigate = vi.fn();

    await navigatePrepared(navigate as unknown as NavigateFunction, "/tasks", {
      prepare: () => Promise.reject(new Error("prefetch failed")),
    });

    expect(navigate).toHaveBeenCalledWith("/tasks", {});
  });

  it("still navigates when data preparation throws synchronously", async () => {
    const navigate = vi.fn();

    await navigatePrepared(navigate as unknown as NavigateFunction, "/tasks", {
      prepare: () => {
        throw new Error("prefetch failed");
      },
    });

    expect(navigate).toHaveBeenCalledWith("/tasks", {});
  });

  it("forwards replace and state without leaking prepare", async () => {
    const navigate = vi.fn();
    const state = { createModule: true };

    await navigatePrepared(
      navigate as unknown as NavigateFunction,
      "/projects/8/modules",
      { replace: true, state },
    );

    expect(navigate).toHaveBeenCalledWith("/projects/8/modules", {
      replace: true,
      state,
    });
  });
});
