import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateProjectResponse,
  CurrentUserResponse,
  InpulseApiClient,
  ProjectListItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ProjectsPageView } from "./ProjectsPageView";

const project: ProjectListItem = {
  id: 2,
  code: "INPULSE",
  name: "InPulse 研发交付平台",
  description: "研发交付平台",
  status: "ACTIVE",
  hasCompletedTask: false,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 4,
  stats: {
    activeModuleCount: 8,
    activeFeatureCount: 32,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
  currentUserRole: "MEMBER",
};

const viewerUser: CurrentUserResponse = {
  id: 7,
  loginName: "viewer",
  name: "查看者",
  email: null,
  avatarUrl: null,
  isAdmin: false,
  status: "ACTIVE",
};

function mount(
  overrides: Partial<React.ComponentProps<typeof ProjectsPageView>>,
  options: { readonly user?: CurrentUserResponse } = {},
) {
  const onOpenModules = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <AuthStateProvider
            value={{
              status: "authenticated",
              user: options.user ?? viewerUser,
            }}
          >
            <ProjectsPageView
              creatorName="特哥"
              projects={[project]}
              onOpenModules={onOpenModules}
              client={{} as InpulseApiClient}
              {...overrides}
            />
          </AuthStateProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return { onOpenModules };
}

describe("项目卡", () => {
  it("shows module, feature, task and member counts in the two footer rows", () => {
    mount({});
    expect(screen.getByText(/8 个模块/)).toBeInTheDocument();
    expect(screen.getByText(/32 个功能/)).toBeInTheDocument();
    expect(screen.getByText(/3 项待办/)).toBeInTheDocument();
    expect(screen.getByText(/4 位成员/)).toBeInTheDocument();
  });

  it("项目卡的右下柔光沿用项目图标色系", () => {
    mount({});
    const card = screen
      .getByRole("heading", { name: "InPulse 研发交付平台" })
      .closest(".project-card")!;
    const logo = card.querySelector(".project-logo")!;
    const tone = ["cyan", "blue", "amber"].find((value) =>
      logo.classList.contains(value),
    );

    expect(tone).toBeDefined();
    expect(card.classList.contains(`project-blush-${tone}`)).toBe(true);
  });

  it("opens the module list when the card body itself is clicked", () => {
    const { onOpenModules } = mount({});
    fireEvent.click(
      screen.getByRole("heading", { name: "InPulse 研发交付平台" }),
    );
    expect(onOpenModules).toHaveBeenCalledWith(2);
  });

  it("opens the module list when the card body is activated by keyboard", () => {
    const { onOpenModules } = mount({});
    const card = screen
      .getByRole("heading", { name: "InPulse 研发交付平台" })
      .closest(".project-card")!;
    expect(card.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onOpenModules).toHaveBeenCalledWith(2);
  });

  it("keeps card actions out of the card navigation", () => {
    const { onOpenModules } = mount({ isAdmin: true });
    fireEvent.click(screen.getByTestId("edit-project-2"));
    expect(onOpenModules).not.toHaveBeenCalled();
    expect(screen.getByText("编辑项目")).toBeInTheDocument();
  });

  it("星标点击即生效、再点取消，并且不触发卡片跳转", () => {
    globalThis.localStorage.clear();
    const { onOpenModules } = mount({});
    const star = screen.getByTestId("star-project-2");
    expect(star.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(star);
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.className).toContain("is-starred");
    expect(globalThis.localStorage.getItem("inpulse.projects.starred.7")).toBe(
      "[2]",
    );
    expect(onOpenModules).not.toHaveBeenCalled();

    fireEvent.click(star);
    expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(globalThis.localStorage.getItem("inpulse.projects.starred.7")).toBe(
      "[]",
    );
  });

  it("重新进入页面时按本地记录恢复星标", () => {
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[2]");
    mount({});
    expect(
      screen.getByTestId("star-project-2").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("星标按账号各存一份：换账号登录看不到别人点亮的星", () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[2]");

    mount({}, { user: { ...viewerUser, id: 9, loginName: "other" } });
    const star = screen.getByTestId("star-project-2");
    expect(star.getAttribute("aria-pressed")).toBe("false");

    // 另一个账号点星只写自己那份，7 号账号的记录不动。
    fireEvent.click(star);
    expect(globalThis.localStorage.getItem("inpulse.projects.starred.9")).toBe(
      "[2]",
    );
    expect(globalThis.localStorage.getItem("inpulse.projects.starred.7")).toBe(
      "[2]",
    );
  });

  it("keeps GitHub links off the project card, matching the design reference", () => {
    mount({});
    expect(screen.queryByRole("button", { name: "GitHub 链接" })).toBeNull();
  });

  it("项目状态标签直接映射三态，不再由完成任务数推导", () => {
    mount({
      projects: [
        {
          ...project,
          id: 3,
          code: "K1235",
          name: "未开始项目",
          status: "NOT_STARTED",
          stats: { ...project.stats, completedTaskCount: 9 },
        },
        project,
        {
          ...project,
          id: 4,
          code: "K1236",
          name: "维护中项目",
          status: "MAINTENANCE",
        },
      ],
    });
    // 默认停在「未完成」档：进行中与未开始都在这一档。
    expect(screen.getByText("未开始").className).toContain("badge-cyan");
    expect(screen.getByText("进行中").className).toContain("badge-blue");
    expect(screen.queryByRole("heading", { name: "维护中项目" })).toBeNull();
    // 维护中归到另一档，切过去才可见。
    fireEvent.click(screen.getByRole("button", { name: "维护中" }));
    const card = screen
      .getByRole("heading", { name: "维护中项目" })
      .closest(".project-card");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("维护中").className).toContain(
      "badge-violet",
    );
  });
});

const maintenanceEarly: ProjectListItem = {
  ...project,
  id: 11,
  code: "K1",
  name: "早维护",
  status: "MAINTENANCE",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const maintenanceLate: ProjectListItem = {
  ...project,
  id: 12,
  code: "K2",
  name: "晚维护",
  status: "MAINTENANCE",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("项目列表生命周期滑块（2026-10-09 用户指示）", () => {
  it("两档各带数量，默认停在未完成档", () => {
    mount({ projects: [project, maintenanceEarly, maintenanceLate] });

    const open = screen.getByRole("button", { name: "未完成" });
    const maintenance = screen.getByRole("button", { name: "维护中" });
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(maintenance).toHaveAttribute("aria-pressed", "false");
    expect(within(open).getByText("1")).toBeInTheDocument();
    expect(within(maintenance).getByText("2")).toBeInTheDocument();
    // 维护中的卡片不在未完成档里。
    expect(screen.queryByText("早维护")).toBeNull();
  });

  it("维护中按进入维护的时间从近到远排列", () => {
    mount({ projects: [maintenanceEarly, maintenanceLate] });
    fireEvent.click(screen.getByRole("button", { name: "维护中" }));

    const names = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(["晚维护", "早维护"]);
  });

  it("搜索只在当前档内过滤，两档数字不随关键词变化", () => {
    mount({ projects: [project, maintenanceEarly, maintenanceLate] });
    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "早维护" },
    });

    expect(screen.getByText("没有匹配的项目")).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: "未完成" })).getByText("1"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: "维护中" })).getByText("2"),
    ).toBeInTheDocument();
  });
});

const openSecond: ProjectListItem = {
  ...project,
  id: 22,
  code: "S2",
  name: "乙项目",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const openThird: ProjectListItem = {
  ...project,
  id: 23,
  code: "S3",
  name: "丙项目",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("项目星标排序（2026-10-15 用户指示）", () => {
  const cardNames = () =>
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

  it("点亮的项目排到前面，未标之间保持原有次序", () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[22]");
    mount({ projects: [project, openSecond, openThird] });

    expect(cardNames()).toEqual(["乙项目", "InPulse 研发交付平台", "丙项目"]);

    // 现场点亮另一张卡：它离开未标组、并入星标组，组内仍按原有次序（22 在 23 前）。
    fireEvent.click(screen.getByTestId("star-project-23"));
    expect(cardNames()).toEqual(["乙项目", "丙项目", "InPulse 研发交付平台"]);
  });

  it("取消星标后回到原次序位置", () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[22]");
    mount({ projects: [project, openSecond, openThird] });

    fireEvent.click(screen.getByTestId("star-project-22"));
    expect(cardNames()).toEqual(["InPulse 研发交付平台", "乙项目", "丙项目"]);
  });

  it("维护中一档同样星标优先，其余仍按进入维护时间从近到远", () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[11]");
    mount({ projects: [maintenanceEarly, maintenanceLate] });
    fireEvent.click(screen.getByRole("button", { name: "维护中" }));

    expect(cardNames()).toEqual(["早维护", "晚维护"]);
  });

  it("搜索过滤后仍按星标优先排序", () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[23]");
    mount({ projects: [project, openSecond, openThird] });
    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "项目" },
    });

    expect(cardNames()).toEqual(["丙项目", "乙项目"]);
  });
});

describe("项目归档入口下线（ADR-043）", () => {
  it("项目层面不再有归档入口，系统管理员也只能编辑与管理成员", () => {
    mount({ isAdmin: true });
    expect(screen.getByTestId("edit-project-2")).toBeInTheDocument();
    expect(screen.queryByTestId("archive-project-2")).toBeNull();
    expect(screen.queryByTestId("restore-project-2")).toBeNull();
    expect(screen.queryByTestId("request-archive-2")).toBeNull();
    expect(screen.queryByTestId("approve-archive-request-2")).toBeNull();
    expect(screen.queryByTestId("reject-archive-request-2")).toBeNull();
  });
});

const createdProject: CreateProjectResponse = {
  project: {
    id: 2,
    code: "INPULSE",
    name: "InPulse 研发交付平台",
    description: "研发交付平台",
    status: "NOT_STARTED",
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  },
  members: [
    {
      userId: 1,
      status: "ACTIVE",
      role: "LEADER",
      joinedAt: "2026-09-09T00:00:00.000Z",
    },
  ],
};

describe("创建成功后的下一步（2026-10-10）", () => {
  it("「添加模块」优先走一次性到达信号入口", () => {
    const onAddModule = vi.fn();
    mount({ createdProject, onAddModule });
    fireEvent.click(screen.getByTestId("add-module-after-create"));
    expect(onAddModule).toHaveBeenCalledWith(2);
  });

  it("没有专用入口时「添加模块」退化为打开模块列表", () => {
    const { onOpenModules } = mount({ createdProject });
    fireEvent.click(screen.getByTestId("add-module-after-create"));
    expect(onOpenModules).toHaveBeenCalledWith(2);
  });
});

describe("ADR-064 / ADR-094 项目列表文档导入入口", () => {
  it("顶部入口直接打开工作台，默认是新建整项目", () => {
    mount({});
    fireEvent.click(screen.getByTestId("import-project-document-button"));

    expect(
      screen.getByRole("dialog", { name: "从文档导入" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("document-import-mode")).toBeInTheDocument();
    expect(screen.getByLabelText("导入文档内容")).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "新建整项目" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("在同一个工作台内切换到已有项目，再选择模块 / 功能目标", async () => {
    const listModules = vi.fn().mockResolvedValue({ items: [] });
    const getUserDirectory = vi.fn().mockResolvedValue({ items: [] });
    mount({
      client: {
        listModules,
        getUserDirectory,
      } as unknown as InpulseApiClient,
    });

    fireEvent.click(screen.getByTestId("import-project-document-button"));
    fireEvent.click(screen.getByRole("button", { name: "导入已有项目" }));

    expect(
      screen.getByRole("dialog", { name: "从文档导入" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("document-import-target"),
    ).toBeInTheDocument();
    expect(listModules).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
