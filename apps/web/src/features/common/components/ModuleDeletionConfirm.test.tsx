import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@generated/api";
import {
  ModuleDeletionConfirm,
  catalogDeletionError,
} from "./ModuleDeletionConfirm";

function apiError(status: number, message: string): ApiError {
  return new ApiError(status, {
    code: "TEST",
    message,
    details: {},
    requestId: "test",
  });
}

function mount(
  overrides: Partial<React.ComponentProps<typeof ModuleDeletionConfirm>> = {},
) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ModuleDeletionConfirm
        open
        name="结算模块"
        code="PAY-M-2"
        impact="该模块下有 2 项未完成任务：确认删除会连同这些任务一起删除。"
        pending={false}
        error={undefined}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...overrides}
      />
    </ConfigProvider>,
  );
  return { onCancel, onConfirm };
}

describe("ADR-109 模块删除确认", () => {
  it("给出影响面与不可恢复声明，确认与取消各自回调", () => {
    const { onCancel, onConfirm } = mount();

    expect(screen.getByText("确认删除模块")).toBeTruthy();
    expect(screen.getByText("PAY-M-2 / 删除模块")).toBeTruthy();
    expect(screen.getByText(/确认删除模块「结算模块」？/)).toBeTruthy();
    expect(
      screen.getByText(
        /该模块下有 2 项未完成任务：确认删除会连同这些任务一起删除。/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/删除后不可恢复/)).toBeTruthy();
    expect(screen.getByText(/仅保留审计日志与项目动态/)).toBeTruthy();

    const confirm = screen.getByTestId("confirm-delete-module");
    expect(confirm.className).toContain("danger-button");

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("没有编号时眉标只写动作", () => {
    mount({ code: undefined });
    expect(screen.getByText("删除模块")).toBeTruthy();
  });

  it("目标缺失时不渲染弹层", () => {
    mount({ name: undefined });
    expect(screen.queryByText("确认删除模块")).toBeNull();
    expect(screen.queryByTestId("confirm-delete-module")).toBeNull();
  });

  it("把服务端 409 原因原样透出，不追加编辑话术", () => {
    mount({ error: apiError(409, "未分类模块不能删除") });
    expect(screen.getByText("未分类模块不能删除。")).toBeTruthy();
    expect(screen.queryByText(/加载最新版本后继续编辑/)).toBeNull();
  });
});

describe("ADR-109 catalogDeletionError", () => {
  it.each([
    [401, apiError(401, "unauthorized"), "登录状态已失效，请重新登录。"],
    [
      403,
      apiError(403, "forbidden"),
      "权限或安全校验未通过，请重新登录后重试。",
    ],
    [404, apiError(404, "missing"), "模块不存在，或你已无权访问。"],
    [429, apiError(429, "too-many"), "请求过于频繁，请稍后重试。"],
  ])("把 %i 映射为固定文案", (_status, error, expected) => {
    expect(catalogDeletionError(error)).toBe(expected);
  });

  it("409 与 422 都带服务端原因", () => {
    expect(
      catalogDeletionError(apiError(409, "模块版本已变化，请重新加载后删除")),
    ).toBe("模块版本已变化，请重新加载后删除。");
    expect(
      catalogDeletionError(apiError(422, "请检查删除原因与模块版本")),
    ).toBe("请检查删除原因与模块版本。");
  });

  it("非 ApiError 与未覆盖状态码回落到通用文案", () => {
    expect(catalogDeletionError(new Error("boom"))).toBe(
      "服务暂时不可用，请稍后重试。",
    );
    expect(catalogDeletionError(apiError(500, "internal"))).toBe(
      "服务暂时不可用，请稍后重试。",
    );
  });
});
