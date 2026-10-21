import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  CurrentUserResponse,
  FeatureItem,
  InpulseApiClient,
  ModuleItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import type { ProjectTier } from "@features/common/resource-lifecycle";
import {
  ProjectTierProvider,
  useProjectTier,
} from "@features/common/project-tier-context";
import { ProjectTree } from "./ProjectTree";
import type { TreeSelection, TreeScope } from "./tree-selection";

const projectItem = {
  id: 2,
  code: "AGV",
  name: "AGV 智能搬运平台",
  status: "ACTIVE",
};

const otherProjectItem = {
  id: 9,
  code: "WMS",
  name: "WMS 仓储管理",
  status: "ACTIVE",
};

const moduleItem = {
  id: 3,
  name: "调度模块",
  status: "ACTIVE",
} as unknown as ModuleItem;

const featureItem = {
  id: 5,
  name: "车辆调度",
  status: "ACTIVE",
} as unknown as FeatureItem;

const signedInUser: CurrentUserResponse = {
  id: 7,
  loginName: "viewer",
  name: "查看者",
  email: null,
  avatarUrl: null,
  isAdmin: false,
  status: "ACTIVE",
};

const TestAuthProvider: React.FC<{ readonly children: React.ReactNode }> = ({
  children,
}) => (
  <AuthStateProvider value={{ status: "authenticated", user: signedInUser }}>
    {children}
  </AuthStateProvider>
);

function createClient() {
  return {
    listProjects: vi
      .fn()
      .mockResolvedValue({ items: [projectItem, otherProjectItem] }),
    getProject: vi.fn().mockResolvedValue({ project: projectItem }),
    listModules: vi.fn().mockResolvedValue({ items: [moduleItem] }),
    listFeatures: vi.fn().mockResolvedValue({ items: [featureItem] }),
  } as unknown as InpulseApiClient;
}

function scopeOf(selection: TreeSelection): TreeScope {
  return { projectId: 2, selection };
}

function mount(
  client: InpulseApiClient,
  onNavigate: (path: string) => void,
  activeScope: TreeScope | null = scopeOf({ kind: "project" }),
  activePageSegment: string | null = null,
) {
  return render(
    <TestAuthProvider>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProjectTree
          activeScope={activeScope}
          activePageSegment={activePageSegment}
          onNavigate={onNavigate}
          client={client}
        />
      </QueryClientProvider>
    </TestAuthProvider>,
  );
}

/**
 * 会随导航更新 activeScope 的壳：展开态由「当前项目」推导，点击项目行只负责导航，
 * 因此测试必须让 scope 跟着路径走，否则树看不到「当前项目」的变化。
 */
const RoutedTree: React.FC<{
  readonly client: InpulseApiClient;
  readonly onNavigate: (path: string) => void;
}> = ({ client, onNavigate }) => {
  const [scope, setScope] = React.useState<TreeScope | null>(null);
  const [segment, setSegment] = React.useState<string | null>(null);
  const handleNavigate = (path: string) => {
    onNavigate(path);
    const page = /^\/projects\/(\d+)\/([a-z-]+)/.exec(path);
    if (!page) {
      return;
    }
    setScope({
      projectId: Number(page[1]),
      selection: { kind: "project" },
    });
    setSegment(page[2] ?? null);
  };
  return (
    <ProjectTree
      activeScope={scope}
      activePageSegment={segment}
      onNavigate={handleNavigate}
      client={client}
    />
  );
};

function mountRouted(
  client: InpulseApiClient,
  onNavigate: (path: string) => void = vi.fn(),
) {
  return render(
    <TestAuthProvider>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RoutedTree client={client} onNavigate={onNavigate} />
      </QueryClientProvider>
    </TestAuthProvider>,
  );
}

describe("ProjectTree", () => {
  it("lists every project first and expands modules after entering a project", async () => {
    const onNavigate = vi.fn();
    mountRouted(createClient(), onNavigate);
    // 先罗列所有项目，未点击时不加载模块；列表页整棵树默认收起。
    expect(
      await screen.findByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /WMS 仓储管理/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /调度模块/ })).toBeNull();

    // 点击进入项目（真实路由停在 /projects/2/modules）：当前项目默认铺开，
    // 「模块与功能」子页行随之自动展开，模块列表随后加载。
    fireEvent.click(screen.getByRole("button", { name: /AGV 智能搬运平台/ }));
    expect(onNavigate).toHaveBeenCalledWith("/projects/2/modules");
    expect(
      await screen.findByRole("button", { name: /调度模块/ }),
    ).toBeTruthy();
  });

  it("keeps the module list in its own scroll area so other projects stay visible", async () => {
    const { container } = mountRouted(createClient());

    fireEvent.click(
      await screen.findByRole("button", { name: /AGV 智能搬运平台/ }),
    );
    const moduleButton = await screen.findByRole("button", {
      name: /调度模块/,
    });

    // 回归防线：模块列表必须落在自己的滚动区（.tree-modules-scroll，CSS 限高
    // 200px 且滚动条槽常驻）里，侧栏不再让所有项目共用一条滚动条；子页行留在
    // 滚动区之外，始终可见。折叠动画在 .tree-children / .tree-modules 两层上，
    // 中间多一层 .tree-children-clip 负责裁剪，故这里用后代选择器定位。
    const scrollArea = container.querySelector(
      ".project-tree-scroll > .tree-project > .tree-children .tree-modules-scroll",
    );
    expect(scrollArea?.contains(moduleButton)).toBe(true);
    expect(
      scrollArea?.contains(screen.getByRole("button", { name: "模块与功能" })),
    ).toBe(false);
  });

  it("marks collapsed branches as hidden while the fold animation runs", async () => {
    const { container } = mountRouted(createClient());
    const agv = await screen.findByRole("button", { name: /AGV 智能搬运平台/ });
    const branch = container.querySelector(
      ".project-tree-scroll > .tree-project > .tree-children",
    );
    // 收起态：高度交给 CSS 的 grid-template-rows 过渡压到 0，data-open 记录状态，
    // aria-hidden 让内容在收起（含动画窗口）期间对辅助技术与查询都不可见。
    expect(branch).toHaveAttribute("data-open", "false");
    expect(branch).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(agv);
    expect(branch).toHaveAttribute("data-open", "true");
    expect(branch).not.toHaveAttribute("aria-hidden");

    // 再次点击立即翻转状态：内容仍在 DOM 里等收起动画走完（延迟卸载），
    // 但已不可查询，不会出现「动画还在放、列表却已能点到」的中间态。
    fireEvent.click(agv);
    expect(branch).toHaveAttribute("data-open", "false");
    expect(branch).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: "模块与功能" })).toBeNull();
  });

  it("keeps every project row listed while one project is expanded", async () => {
    mountRouted(createClient());
    fireEvent.click(
      await screen.findByRole("button", { name: /AGV 智能搬运平台/ }),
    );
    expect(
      await screen.findByRole("button", { name: /调度模块/ }),
    ).toBeTruthy();
    // 展开的子树只挂在被打开的项目下面：其它项目行仍留在同一个罗列区里，
    // 不因为某个项目展开而消失（产品要求 2026-09-21）。
    expect(screen.getByRole("button", { name: /WMS 仓储管理/ })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toHaveLength(1);
  });

  it("collapses the project branch when its node is clicked again", async () => {
    const onNavigate = vi.fn();
    mountRouted(createClient(), onNavigate);

    const projectButton = await screen.findByRole("button", {
      name: /AGV 智能搬运平台/,
    });
    fireEvent.click(projectButton);
    expect(projectButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      await screen.findByRole("button", { name: /调度模块/ }),
    ).toBeTruthy();

    // 再次点击项目节点收回整个子页列表（含模块列表），并仍导航到项目主页。
    fireEvent.click(projectButton);
    expect(projectButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /调度模块/ })).toBeNull();
    expect(onNavigate).toHaveBeenLastCalledWith("/projects/2/modules");
  });

  it("collapses every project branch back on the project list page", async () => {
    const client = createClient();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (activeScope: TreeScope | null) => (
      <TestAuthProvider>
        <QueryClientProvider client={queryClient}>
          <ProjectTree
            activeScope={activeScope}
            activePageSegment={activeScope === null ? null : "modules"}
            onNavigate={vi.fn()}
            client={client}
          />
        </QueryClientProvider>
      </TestAuthProvider>
    );
    const view = render(tree(scopeOf({ kind: "project" })));
    const projectRow = () =>
      screen.getByRole("button", { name: /AGV 智能搬运平台/ });
    expect(
      await screen.findByRole("button", { name: /调度模块/ }),
    ).toBeTruthy();
    expect(projectRow().getAttribute("aria-expanded")).toBe("true");

    // 回到项目列表页（没有当前项目）：整棵树收起，不保留刚离开项目的展开态，
    // 也不会出现两个项目同时铺开。
    view.rerender(tree(null));
    expect(projectRow().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "模块与功能" })).toBeNull();
    expect(screen.queryByRole("button", { name: /调度模块/ })).toBeNull();
  });

  it("drives the existing project pages for every tree level", async () => {
    const onNavigate = vi.fn();
    mount(createClient(), onNavigate);

    // 当前项目作用域自动铺开子页行；模块列表要点开「模块与功能」。
    fireEvent.click(await screen.findByRole("button", { name: "模块与功能" }));
    fireEvent.click(await screen.findByRole("button", { name: /调度模块/ }));
    expect(onNavigate).toHaveBeenCalledWith("/projects/2/modules/3/features");

    fireEvent.click(await screen.findByRole("button", { name: /车辆调度/ }));
    expect(onNavigate).toHaveBeenCalledWith("/projects/2/modules/3/features/5");
  });

  it("auto-expands the chain of the active project scope", async () => {
    mount(
      createClient(),
      vi.fn(),
      scopeOf({ kind: "module", moduleId: 3 }),
      "modules",
    );
    const projectButton = await screen.findByRole("button", {
      name: /AGV 智能搬运平台/,
    });
    expect(projectButton.getAttribute("aria-expanded")).toBe("true");
    const moduleButton = await screen.findByRole("button", {
      name: /调度模块/,
    });
    expect(moduleButton.getAttribute("aria-current")).toBe("true");
    expect(
      await screen.findByRole("button", { name: /车辆调度/ }),
    ).toBeTruthy();
  });

  it("keeps the expanded chain when returning to the project overview", async () => {
    const client = createClient();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (activeScope: TreeScope, activePageSegment: string) => (
      <TestAuthProvider>
        <QueryClientProvider client={queryClient}>
          <ProjectTree
            activeScope={activeScope}
            activePageSegment={activePageSegment}
            onNavigate={vi.fn()}
            client={client}
          />
        </QueryClientProvider>
      </TestAuthProvider>
    );
    const view = render(
      tree(scopeOf({ kind: "feature", moduleId: 3, featureId: 5 }), "modules"),
    );
    expect(
      (await screen.findByRole("button", { name: /调度模块/ })).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    await screen.findByRole("button", { name: /车辆调度/ });

    // 面包屑回到项目概况（系统级作用域）后，已展开的模块与功能保持可见。
    view.rerender(tree(scopeOf({ kind: "project" }), "overview"));
    expect(
      screen
        .getByRole("button", { name: /调度模块/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /车辆调度/ })).toBeTruthy();
  });

  it("keeps the module branch expanded while its features load", async () => {
    mount(
      createClient(),
      vi.fn(),
      scopeOf({ kind: "module", moduleId: 3 }),
      "modules",
    );
    const moduleButton = await screen.findByRole("button", {
      name: /调度模块/,
    });
    expect(moduleButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      await screen.findByRole("button", { name: /车辆调度/ }),
    ).toBeTruthy();
    fireEvent.click(moduleButton);
    expect(moduleButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("highlights the feature row and keeps its module in path", async () => {
    mount(
      createClient(),
      vi.fn(),
      scopeOf({ kind: "feature", moduleId: 3, featureId: 5 }),
      "modules",
    );
    const featureButton = await screen.findByRole("button", {
      name: /车辆调度/,
    });
    expect(featureButton.getAttribute("aria-current")).toBe("true");
    const moduleButton = screen.getByRole("button", { name: /调度模块/ });
    expect(moduleButton.getAttribute("aria-expanded")).toBe("true");
    expect(moduleButton.classList.contains("in-path")).toBe(true);
  });

  it("marks the project node when the project main page is active", async () => {
    mount(createClient(), vi.fn(), scopeOf({ kind: "project" }));
    const projectButton = await screen.findByRole("button", {
      name: /AGV 智能搬运平台/,
    });
    expect(projectButton.getAttribute("aria-current")).toBe("true");
  });
});

/**
 * 侧栏项目树的分档（2026-10-09 用户指示）：与项目列表页的滑块共享同一份状态，
 * 未完成档只列进行中 / 未开始，维护中档只列维护中项目；当前所在项目始终保留。
 */
describe("ProjectTree 分档过滤", () => {
  const maintenanceProjectItem = {
    id: 12,
    code: "OLD",
    name: "老平台维护",
    status: "MAINTENANCE",
  };

  function tierClient(
    items: readonly unknown[] = [projectItem, maintenanceProjectItem],
  ) {
    return {
      listProjects: vi.fn().mockResolvedValue({ items }),
      listModules: vi.fn().mockResolvedValue({ items: [] }),
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;
  }

  /** 模拟项目列表页的滑块：把共享分档拨到指定档位。 */
  const TierSetter: React.FC<{ readonly tier: ProjectTier }> = ({ tier }) => {
    const { selectTier } = useProjectTier();
    React.useEffect(() => {
      selectTier(tier);
    }, [selectTier, tier]);
    return null;
  };

  function mountTiered(
    tier: ProjectTier,
    activeScope: TreeScope | null = null,
    client: InpulseApiClient = tierClient(),
  ) {
    return render(
      <TestAuthProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <ProjectTierProvider>
            <TierSetter tier={tier} />
            <ProjectTree
              activeScope={activeScope}
              onNavigate={vi.fn()}
              client={client}
            />
          </ProjectTierProvider>
        </QueryClientProvider>
      </TestAuthProvider>,
    );
  }

  it("lists only unfinished projects on the default tier", async () => {
    mountTiered("open");
    expect(
      await screen.findByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /老平台维护/ })).toBeNull();
  });

  it("switches the sidebar list to maintenance projects", async () => {
    mountTiered("maintenance");
    expect(
      await screen.findByRole("button", { name: /老平台维护/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toBeNull();
  });

  it("keeps the project being viewed even when the tier would hide it", async () => {
    mountTiered("maintenance", scopeOf({ kind: "project" }));
    expect(
      await screen.findByRole("button", { name: /老平台维护/ }),
    ).toBeTruthy();
    // AGV 属未完成档，但它是当前所在项目：分档只收窄浏览范围，
    // 不能把正在看的项目从树上摘掉。
    expect(
      screen.getByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toBeTruthy();
  });

  it("explains an empty list by tier instead of claiming there are no projects", async () => {
    const view = mountTiered("maintenance", null, tierClient([projectItem]));
    expect(await screen.findByText("暂无维护中的项目")).toBeTruthy();
    view.unmount();

    mountTiered("maintenance", null, tierClient([]));
    expect(await screen.findByText("暂无项目")).toBeTruthy();
  });
});
