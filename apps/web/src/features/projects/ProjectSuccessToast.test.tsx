import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_SUCCESS_NOTICE_DURATION_MS,
  ProjectSuccessToast,
} from "./ProjectSuccessToast";

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectSuccessToast", () => {
  it("到时间后请求关闭，避免成功提示长期占住页面", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <ProjectSuccessToast
        testId="project-success"
        title="项目创建成功"
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("项目创建成功");
    act(() => {
      vi.advanceTimersByTime(PROJECT_SUCCESS_NOTICE_DURATION_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("支持手动关闭，并展示说明和后续操作", async () => {
    const onDismiss = vi.fn();
    render(
      <ProjectSuccessToast
        testId="project-success"
        title="项目已更新"
        description="当前版本 5"
        actions={<button type="button">查看项目动态</button>}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("当前版本 5")).toBeTruthy();
    expect(screen.getByText("查看项目动态")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "关闭成功提示" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
