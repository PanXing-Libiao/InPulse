import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isProjectSetupComplete, ProjectSetupGuide } from "./ProjectSetupGuide";

interface GuideInputs {
  readonly moduleCount?: number;
  readonly taskCount?: number;
}

function mountGuide(inputs: GuideInputs = {}) {
  const handlers = {
    onCreateModule: vi.fn(),
    onCreateTask: vi.fn(),
  };
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ProjectSetupGuide
        moduleCount={inputs.moduleCount ?? 0}
        taskCount={inputs.taskCount ?? 0}
        {...handlers}
      />
    </ConfigProvider>,
  );
  return { view, ...handlers };
}

describe("ProjectSetupGuide（新项目搭建引导）", () => {
  it("空项目停在第一步：任务步骤给出先决条件提示", () => {
    const { onCreateModule } = mountGuide();
    expect(screen.getByText("开始搭建这个项目")).toBeInTheDocument();
    expect(screen.getByTestId("setup-step-module").className).toContain(
      "is-current",
    );
    expect(screen.getByTestId("setup-step-task").className).toContain(
      "is-blocked",
    );
    expect(screen.getAllByText("先完成第 1 步")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "创建任务" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新增模块" }));
    expect(onCreateModule).toHaveBeenCalledTimes(1);
  });

  it("已有模块时任务步骤成为当前步，按钮触发创建任务", () => {
    const { onCreateModule, onCreateTask } = mountGuide({ moduleCount: 2 });
    const moduleStep = screen.getByTestId("setup-step-module");
    expect(moduleStep.className).toContain("is-done");
    expect(
      within(moduleStep).getByText("已完成 · 2 个模块"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("setup-step-task").className).toContain(
      "is-current",
    );
    const createTask = screen.getByRole("button", { name: "创建任务" });
    expect(createTask.className).toContain("primary-button");
    fireEvent.click(createTask);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(onCreateModule).not.toHaveBeenCalled();
  });

  it("模块与任务齐备后整体隐藏", () => {
    const { view } = mountGuide({ moduleCount: 1, taskCount: 3 });
    expect(view.container.firstChild).toBeNull();
  });

  it("isProjectSetupComplete 需模块与任务各有一条记录", () => {
    expect(isProjectSetupComplete(0, 0)).toBe(false);
    expect(isProjectSetupComplete(1, 0)).toBe(false);
    expect(isProjectSetupComplete(0, 3)).toBe(false);
    expect(isProjectSetupComplete(1, 3)).toBe(true);
  });
});
