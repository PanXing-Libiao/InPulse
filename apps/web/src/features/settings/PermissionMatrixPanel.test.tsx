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

  it("marks high-risk permissions as admin only and keeps their rule note", () => {
    render(<PermissionMatrixPanel />);
    expectAllowed(cell("查看所有项目", 1));
    expect(cell("查看所有项目", 2)).toHaveTextContent("—");
    expect(cell("查看所有项目", 3)).toHaveTextContent(
      "项目成员只能看已加入项目",
    );
    expectAllowed(cell("用户账号管理", 1));
    expect(cell("用户账号管理", 2)).toHaveTextContent("—");
    expect(cell("系统配置", 3)).toHaveTextContent(
      "含 AI 辅助与企业微信机器人配置",
    );
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

  it("distinguishes member-wide, leader-only and admin-only capabilities", () => {
    render(<PermissionMatrixPanel />);
    for (const row of [
      "变更项目状态",
      "添加/移除项目成员",
      "导入文档到项目",
      "整项目文档导入",
      "AI 辅助文档转换",
      "AI 改写迭代总结",
      "绑定企业微信机器人",
    ]) {
      expectAllowed(cell(row, 1));
      expectAllowed(cell(row, 2));
    }
    for (const row of [
      "组长转移",
      "删除项目",
      "删除模块/删除功能",
      "项目企业微信群绑定",
    ]) {
      expectAllowed(cell(row, 1));
      expect(cell(row, 2)).toHaveTextContent("仅组长");
    }
  });
});
