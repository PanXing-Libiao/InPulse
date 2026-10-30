import { describe, expect, it } from "vitest";
import { PROJECT_OVERVIEW_MOCK_ADAPTER } from "./project-overview-mock";

describe("project overview mock adapter", () => {
  it("serves a mock skeleton result with the proposal metrics", async () => {
    expect(PROJECT_OVERVIEW_MOCK_ADAPTER.source).toBe("mock");
    const result = await PROJECT_OVERVIEW_MOCK_ADAPTER.fetchProjectOverview({
      projectId: 1,
    });
    expect(result.stats).toEqual({
      activeModules: 4,
      openTasks: 6,
      publishedRecords: 9,
      openLeftovers: 2,
    });
    expect(result.recentIterations).toHaveLength(3);
    expect(result.leftovers).toHaveLength(result.stats.openLeftovers);
  });

  it("keeps recent iterations ordered by publishedAt descending", async () => {
    const result = await PROJECT_OVERVIEW_MOCK_ADAPTER.fetchProjectOverview({
      projectId: 1,
    });
    const stamps = result.recentIterations.map((item) => item.publishedAt);
    const sorted = stamps.slice().sort((a, b) => b.localeCompare(a));
    expect(stamps).toEqual(sorted);
    expect(stamps.every((stamp) => !Number.isNaN(Date.parse(stamp)))).toBe(
      true,
    );
  });

  it("ignores the project id until the server contract is frozen", async () => {
    const result = await PROJECT_OVERVIEW_MOCK_ADAPTER.fetchProjectOverview({
      projectId: 999,
    });
    expect(result.stats.activeModules).toBe(4);
  });
});
