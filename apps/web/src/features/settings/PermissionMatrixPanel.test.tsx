import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionMatrixPanel } from "./PermissionMatrixPanel";
import { permissionMatrixRows } from "./settings-content";

function cell(rowLabel: string, columnIndex: number): HTMLElement {
  const row = screen.getByText(rowLabel).closest("tr");
  if (!row) throw new Error(`permission row not found: ${rowLabel}`);
  const cells = within(row as HTMLElement).getAllByRole("cell");
  const target = cells[columnIndex];
  if (!target) throw new Error(`column not found: ${columnIndex}`);
  return target;
}

function expectAllowed(target: HTMLElement): void {
  expect(target.querySelector(".badge-green")).not.toBeNull();
}

describe("PermissionMatrixPanel", () => {
  it("renders the four documented columns over every matrix row", () => {
    render(<PermissionMatrixPanel />);
    const table = screen.getByRole("table", { name: "权限矩阵" });
    for (const header of ["功能", "系统管理员", "项目成员", "规则说明"]) {
      expect(
        within(table).getByRole("columnheader", { name: header }),
      ).toBeInTheDocument();
    }
    expect(within(table).getAllByRole("row")).toHaveLength(
      permissionMatrixRows.length + 1,
    );
  });

  it("marks admin-only capabilities and keeps their rule notes", () => {
    render(<PermissionMatrixPanel />);
    expectAllowed(cell("作废/恢复迭代记录", 1));
    expect(cell("作废/恢复迭代记录", 2)).toHaveTextContent("—");
    expectAllowed(cell("系统管理与审计", 1));
    expect(cell("系统管理与审计", 2)).toHaveTextContent("—");
    expect(cell("系统管理与审计", 3)).toHaveTextContent("原始审计快照");
  });

  it("omits removed and nobody-can-do capabilities and never shows a version tag", () => {
    render(<PermissionMatrixPanel />);
    for (const row of [
      "修改项目编码",
      "配置 GitHub 应用或 Token",
      "归档/恢复项目",
      "归档/恢复模块",
      "归档/恢复功能",
      "彻底删除项目",
      "删除/还原项目",
    ]) {
      expect(screen.queryByText(row)).not.toBeInTheDocument();
    }
    expect(screen.queryAllByText(/V1\.1/)).toHaveLength(0);
  });

  it("renders only the panel title, without a caption line or version tag", () => {
    render(<PermissionMatrixPanel />);
    expect(
      screen.getByRole("heading", { name: "权限矩阵" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("系统管理员与项目成员的权限对照"),
    ).not.toBeInTheDocument();
  });

  it("documents personal notification isolation and project group notification policy", () => {
    render(<PermissionMatrixPanel />);
    expect(cell("个人通知与企业微信", 3)).toHaveTextContent("仅本人");
    expect(cell("个人通知与企业微信", 3)).toHaveTextContent(
      "关闭只抑制后续新通知",
    );
    expectAllowed(cell("项目企业微信群", 1));
    expect(cell("项目企业微信群", 2)).toHaveTextContent("仅组长");
    expect(cell("项目企业微信群", 3)).toHaveTextContent("普通成员只读");
  });

  it("distinguishes member-wide and leader-only capabilities", () => {
    render(<PermissionMatrixPanel />);
    for (const row of [
      "查看项目与动态",
      "创建项目与成员选择",
      "编辑项目与变更状态",
      "添加/移除项目成员",
      "导入文档与 AI 辅助",
      "创建/编辑模块、功能与说明",
      "创建/编辑/指派任务",
      "任务状态、合并与删除",
      "迭代记录与 GitHub 链接",
      "个人通知与企业微信",
    ]) {
      expectAllowed(cell(row, 1));
      expectAllowed(cell(row, 2));
    }
    for (const row of [
      "组长转移与删除项目",
      "删除模块/功能",
      "项目企业微信群",
    ]) {
      expectAllowed(cell(row, 1));
      expect(cell(row, 2)).toHaveTextContent("仅组长");
    }
  });
});
