import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUCCESS_NOTICE_DURATION_MS, SuccessToast } from "./SuccessToast";

afterEach(() => {
  vi.useRealTimers();
});

describe("SuccessToast", () => {
  it("到时间后请求关闭，避免成功提示长期占住页面", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <SuccessToast
        testId="operation-success"
        title="操作成功"
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("操作成功");
    act(() => {
      vi.advanceTimersByTime(SUCCESS_NOTICE_DURATION_MS - 1);
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
      <SuccessToast
        testId="operation-success"
        title="功能操作成功"
        description="功能档案已更新"
        actions={<button type="button">查看功能</button>}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("功能档案已更新")).toBeTruthy();
    expect(screen.getByText("查看功能")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "关闭成功提示" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
