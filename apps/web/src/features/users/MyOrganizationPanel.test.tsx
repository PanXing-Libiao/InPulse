import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MyOrganizationPanel } from "./MyOrganizationPanel";

vi.mock("./organization-query", () => ({
  useMyOrganizationMembers: () => ({
    isPending: false,
    isError: false,
    data: {
      organizations: [
        {
          id: 3,
          name: "第一小组",
          source: "LOCAL",
          groupPath: null,
        },
        {
          id: 8,
          name: "平台组",
          source: "CASDOOR",
          groupPath: "libiaorobot.com/研发/平台组",
        },
      ],
      items: [
        {
          id: 1,
          name: "邵晨宇",
          avatarUrl: null,
          isAdmin: false,
          organizationIds: [3, 8],
        },
        {
          id: 2,
          name: "林雨妍",
          avatarUrl: null,
          isAdmin: true,
          organizationIds: [8],
        },
      ],
    },
  }),
  organizationErrorMessage: () => "组织服务暂时不可用，请重试。",
}));

describe("MyOrganizationPanel", () => {
  it("renders all organizations and keeps member organization badges", () => {
    const { container } = render(<MyOrganizationPanel currentUserId={1} />);

    const title = container.querySelector(
      ".my-org-panel .calm-section-title h3",
    );
    expect(title).toHaveTextContent("成员与角色");
    expect(screen.getByText("共 2 位成员")).toBeVisible();

    const organizationBadges = container.querySelectorAll(
      ".my-org-panel .permission-note .badge",
    );
    expect(organizationBadges).toHaveLength(2);
    expect(organizationBadges[0]).toHaveTextContent("第一小组");
    expect(organizationBadges[1]).toHaveTextContent(
      "libiaorobot.com/研发/平台组",
    );

    const rows = Array.from(container.querySelectorAll(".member-row"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("第一小组");
    expect(rows[0]).toHaveTextContent("平台组");
    expect(screen.getByText("当前账号", { exact: true })).toBeVisible();
    expect(screen.getByText("系统管理员", { exact: true })).toBeVisible();
  });
});
