import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MyOrganizationPanel } from "./MyOrganizationPanel";

vi.mock("./organization-query", () => ({
  useMyOrganizationMembers: () => ({
    isPending: false,
    isError: false,
    data: {
      organization: { id: 3, name: "第一小组" },
      items: [
        { id: 1, name: "邵晨宇", avatarUrl: null, isAdmin: false },
        { id: 2, name: "林雨妍", avatarUrl: null, isAdmin: true },
      ],
    },
  }),
  organizationErrorMessage: () => "组织服务暂时不可用，请重试。",
}));

describe("MyOrganizationPanel", () => {
  it("highlights the organization name once above the member list", () => {
    const { container } = render(<MyOrganizationPanel currentUserId={1} />);

    const title = container.querySelector(
      ".my-org-panel .calm-section-title h3",
    );
    expect(title).toHaveTextContent("第一小组");
    expect(screen.getByText("共 2 位成员")).toBeVisible();

    const rows = Array.from(container.querySelectorAll(".member-row"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).not.toContain("第一小组");
    }
    expect(screen.getByText("当前账号", { exact: true })).toBeVisible();
    expect(screen.getByText("系统管理员", { exact: true })).toBeVisible();
  });
});
