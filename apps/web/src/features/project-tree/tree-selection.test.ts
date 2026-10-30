import { describe, expect, it } from "vitest";
import { treePath, treeScopeOf } from "./tree-selection";

describe("project tree selection", () => {
  it("resolves the active tree node from the catalog path ids", () => {
    expect(treeScopeOf({ projectId: null, moduleId: null })).toBeNull();
    expect(treeScopeOf({ projectId: 2, moduleId: null })).toEqual({
      projectId: 2,
      selection: { kind: "project" },
    });
    expect(treeScopeOf({ projectId: 2, moduleId: 3 })).toEqual({
      projectId: 2,
      selection: { kind: "module", moduleId: 3 },
    });
  });

  it("maps every tree level onto an existing project page", () => {
    expect(treePath(2, { kind: "project" })).toBe("/projects/2/modules");
    expect(treePath(2, { kind: "module", moduleId: 3 })).toBe(
      "/projects/2/modules/3/tasks",
    );
  });
});
