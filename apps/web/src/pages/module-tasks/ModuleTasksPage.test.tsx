import React from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import ModuleTasksPage from "./ModuleTasksPage";

vi.mock("@features/modules/module-query", () => ({
  useModules: () => ({
    query: {
      isPending: false,
      isError: false,
      isFetching: false,
      data: {
        items: [
          {
            id: 3,
            projectId: 2,
            code: "MOD-3",
            name: "交易模块",
            description: "处理支付与退款流程",
            kind: "NORMAL",
            sortOrder: 0,
            rowVersion: 4,
            createdAt: "2026-09-01T08:00:00.000Z",
            updatedAt: "2026-10-30T06:00:00.000Z",
            stats: { openTaskCount: 2, completedTaskCount: 1 },
          },
        ],
      },
    },
  }),
}));

vi.mock("@features/projects/project-query", () => ({
  useProjectDetail: () => ({
    isPending: false,
    data: { project: { name: "商品系统" } },
  }),
}));

vi.mock("@features/tasks/TasksPanel", () => ({
  TasksPanel: () => null,
}));

vi.mock("@features/modules/ModuleEditorModal", () => ({
  ModuleEditorModal: () => null,
}));

function mount() {
  return render(
    <MemoryRouter initialEntries={["/projects/2/modules/3/tasks"]}>
      <Routes>
        <Route
          path="/projects/:projectId/modules/:moduleId/tasks"
          element={<ModuleTasksPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("模块任务页阅读型布局", () => {
  it("用模块档案布局承载直属任务，不再出现功能档案", () => {
    const { container } = mount();

    expect(
      screen.getByRole("heading", { level: 1, name: "交易模块" }),
    ).toBeInTheDocument();
    expect(screen.getByText("处理支付与退款流程")).toBeInTheDocument();
    expect(container.querySelector(".module-document")).not.toBeNull();
    expect(container.querySelector(".module-document-grid")).not.toBeNull();

    const facts = screen.getByRole("complementary", { name: "模块档案" });
    expect(within(facts).getByText("MOD-3")).toBeInTheDocument();
    expect(within(facts).getByText("商品系统")).toBeInTheDocument();
    expect(
      within(facts).getByText("2 项待办 · 1 项已完成"),
    ).toBeInTheDocument();
    expect(within(facts).getByText("v4")).toBeInTheDocument();
    expect(screen.queryByText("功能档案")).toBeNull();
  });
});
