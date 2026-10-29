import React, {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchActivityRoute } from "@features/activity/activity-query";
import { prefetchTaskCenterRoute } from "@features/my-tasks/my-tasks-query";
import {
  prefetchRecordPath,
  prefetchRecordsRoute,
} from "@features/records/records-route-prefetch";
import { prefetchIssuesRoute } from "@features/issues/issues-query";
import { prefetchSettingsRoute } from "@features/users/settings-route-prefetch";
import { CommandPalette } from "@features/command-palette/CommandPalette";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import {
  InpulseIcon,
  type InpulseIconName,
} from "@features/common/components/InpulseIcon";
import { NotificationBell } from "@features/notifications/NotificationBell";
import { createNotificationTaskOpenState } from "@features/notifications/notification-task-state";
import { WecomBindingModal } from "@features/settings/WecomBindingModal";
import { WecomBindingPromptModal } from "@features/settings/WecomBindingPromptModal";
import { ProjectTree } from "@features/project-tree/ProjectTree";
import { useProjects } from "@features/projects/project-query";
import { preloadRoutePath } from "../router/route-preload";
import { treeScopeOf } from "@features/project-tree/tree-selection";
import { useShellCounters } from "./shell-data";

interface NavigationItem {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly icon?: InpulseIconName;
  /** 系统管理员专属入口：普通成员不渲染该项。 */
  readonly adminOnly?: boolean;
}

/** 工作台：个人日常入口；系统目录树内嵌在「项目列表」行下。 */
const workspaceNavigation: readonly NavigationItem[] = [
  { key: "tasks", label: "任务中心", path: "/tasks", icon: "clipboard" },
  { key: "projects", label: "项目列表", path: "/projects", icon: "folder" },
];

/** 交付记录：跨项目的迭代记录与遗留问题台账。 */
const deliveryNavigation: readonly NavigationItem[] = [
  { key: "records", label: "迭代记录", path: "/records", icon: "gitBranch" },
  { key: "issues", label: "遗留问题", path: "/issues", icon: "alert" },
];

/** 全局导航：通知与搜索已收敛到侧栏底部工具条；成员与设置对全体开放（普通成员只读），审计仅管理员可见。 */
const globalNavigation: readonly NavigationItem[] = [
  {
    key: "activity",
    label: "项目动态",
    path: "/activity",
    icon: "activity",
  },
  {
    key: "settings",
    label: "成员与设置",
    path: "/settings",
    icon: "settings",
  },
  {
    key: "audit",
    label: "审计日志",
    path: "/audit",
    icon: "shield",
    adminOnly: true,
  },
];

const sections = [
  { prefix: "/tasks", key: "tasks", label: "任务中心" },
  { prefix: "/projects", key: "projects", label: "项目列表" },
  { prefix: "/records", key: "records", label: "迭代记录" },
  { prefix: "/issues", key: "issues", label: "遗留问题" },
  { prefix: "/activity", key: "activity", label: "项目动态" },
  { prefix: "/audit", key: "audit", label: "审计日志" },
  { prefix: "/settings", key: "settings", label: "成员与设置" },
  { prefix: "/search", key: "search", label: "全局搜索" },
  { prefix: "/notifications", key: "notifications", label: "站内通知" },
] as const;

/** 项目子页面：/projects/:projectId/<segment> 的分段、选中键与面包屑标签。 */
const projectPages = [
  { segment: "modules", key: "project-catalog", label: "项目与功能" },
  { segment: "task-board", key: "project-task-board", label: "任务看板" },
  { segment: "members", key: "project-members", label: "项目成员" },
  { segment: "activity", key: "project-activity", label: "项目动态" },
] as const;

const PROJECT_PAGE_PATTERN = /^\/projects\/\d+\/([a-z-]+)(?:\/|$)/;

function resolveProjectPage(
  pathname: string,
): (typeof projectPages)[number] | null {
  const match = PROJECT_PAGE_PATTERN.exec(pathname);
  if (!match) {
    return null;
  }
  return projectPages.find((page) => page.segment === match[1]) ?? null;
}

/** `/projects/:projectId[/modules/:moduleId[/features/:featureId]]` 的路径解析。 */
interface CatalogScope {
  readonly projectId: number | null;
  readonly moduleId: number | null;
  readonly featureId: number | null;
}

const EMPTY_CATALOG_SCOPE: CatalogScope = {
  projectId: null,
  moduleId: null,
  featureId: null,
};

const CATALOG_SCOPE_PATTERN =
  /^\/projects\/(\d+)(?:\/modules\/(\d+)(?:\/features(?:\/(\d+))?)?)?(?:\/|$)/;

function readEntityId(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 2147483647
    ? value
    : null;
}

function readCatalogScope(pathname: string): CatalogScope {
  const match = CATALOG_SCOPE_PATTERN.exec(pathname);
  if (!match) {
    return EMPTY_CATALOG_SCOPE;
  }
  const projectId = readEntityId(match[1]);
  if (projectId === null) {
    return EMPTY_CATALOG_SCOPE;
  }
  return {
    projectId,
    moduleId: readEntityId(match[2]),
    featureId: readEntityId(match[3]),
  };
}

function resolveSection(pathname: string) {
  const projectPage = resolveProjectPage(pathname);
  if (projectPage) {
    return { key: projectPage.key, label: projectPage.label };
  }
  return sections.find((section) => pathname.startsWith(section.prefix));
}

function resolveSelectedKey(pathname: string): string | undefined {
  const section = resolveSection(pathname);
  return section?.key === "project-activity" ? "activity" : section?.key;
}

export interface AppLayoutProps {
  readonly notificationClient?: InpulseApiClient;
  readonly projectClient?: InpulseApiClient;
}

/** 侧栏收起 / 展开的宽度过渡时长，与 design-system.css 中 .sidebar 的 transition 一致。 */
const NAV_COLLAPSE_MS = 240;

export const AppLayout: React.FC<AppLayoutProps> = ({
  notificationClient,
  projectClient,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const navigationPreparationRef = useRef<Map<string, Promise<void>>>(
    new Map(),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [wecomOpen, setWecomOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // 桌面端把左侧导航整体收起（≤700px 走抽屉与汉堡开关，该状态不参与）。
  const [navCollapsed, setNavCollapsed] = useState(false);
  // 收起 / 展开过渡期间开启裁切：整栏宽度的内容在被宽度动画压缩时不能画到内容区上。
  const [navAnimating, setNavAnimating] = useState(false);
  const navAnimationTimerRef = useRef<number | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const accountRootRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const { status, user, logout } = useAuth();
  const selectedKey = resolveSelectedKey(location.pathname);
  const catalogScope = useMemo(
    () => readCatalogScope(location.pathname),
    [location.pathname],
  );
  const treeScope = useMemo(() => treeScopeOf(catalogScope), [catalogScope]);
  const displayName = user?.name.trim() || "访客";
  const avatarText = user?.name.trim().charAt(0) || "访";
  const roleLabel = user?.isAdmin ? "系统管理员" : user ? "成员" : "未登录";
  const popoverRoleLabel = user?.isAdmin
    ? "系统管理员 · 可执行高风险操作"
    : roleLabel;
  const shellCounters = useShellCounters({
    client: projectClient,
    enabled: status === "authenticated",
  });
  const accessibleProjects = useProjects({
    client: projectClient,
    enabled: status === "authenticated",
  });
  const projectCount = accessibleProjects.data?.items.length ?? 0;
  const shellCounts: Readonly<Record<string, number>> = useMemo(
    () => ({
      tasks: shellCounters.myOpenTaskCount ?? 0,
      projects: projectCount,
      issues: shellCounters.openLeftoverCount ?? 0,
    }),
    [
      shellCounters.myOpenTaskCount,
      shellCounters.openLeftoverCount,
      projectCount,
    ],
  );
  const projectPage = useMemo(
    () => resolveProjectPage(location.pathname),
    [location.pathname],
  );
  const projectScopeId = catalogScope.projectId;
  // 全局「项目动态」在项目上下文内直达该项目动态页，避免与「当前项目」语义重复。
  const visibleGlobalNavigation = useMemo(
    () =>
      globalNavigation
        .filter((item) => user?.isAdmin === true || item.adminOnly !== true)
        .map((item) =>
          item.key === "activity" && projectScopeId !== null
            ? { ...item, path: "/projects/" + projectScopeId + "/activity" }
            : item,
        ),
    [user?.isAdmin, projectScopeId],
  );
  useLayoutEffect(() => {
    // 关闭浏览器自动恢复历史滚动位置：短页从长页返回时，浏览器可能在本次 React
    // 渲染后再次写回旧 scrollTop，表现为内容已完整展示却仍停在页面底部。
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    // 路径切换后新页面从顶部开始；查询参数变化（筛选、分页）不打断当前阅读位置。
    // scrollTo 覆盖以 body 或 documentElement 为滚动元素的浏览器差异。
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [location.pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(
    () => () => {
      if (navAnimationTimerRef.current !== null) {
        window.clearTimeout(navAnimationTimerRef.current);
      }
    },
    [],
  );

  // 退出登录状态只在路由真正落到 /login 后解除：退出跳转是低优先级过渡，
  // 若提前解除，匿名渲染会重建受保护页面并触发 /login?from=... 的回跳。
  useEffect(() => {
    if (isLoggingOut && location.pathname === "/login") {
      setIsLoggingOut(false);
    }
  }, [isLoggingOut, location.pathname]);

  useEffect(() => {
    if (!accountOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!accountRootRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (!projectMenuOpen) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const insideSidebar = sidebarRef.current?.contains(target) ?? false;
      const insideProjectMenu =
        projectMenuRef.current?.contains(target) ?? false;
      if (insideSidebar && !insideProjectMenu) {
        setProjectMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [projectMenuOpen]);

  const handleNavigation = (path: string) => {
    setMobileNavOpen(false);
    if (path !== location.pathname) {
      navigate(path);
    }
  };

  // 收起与展开都先打开裁切类，过渡结束后再撤掉；收起态本身也保留裁切，无需等定时器。
  const handleToggleNav = (collapsed: boolean) => {
    setNavCollapsed(collapsed);
    setNavAnimating(true);
    if (navAnimationTimerRef.current !== null) {
      window.clearTimeout(navAnimationTimerRef.current);
    }
    navAnimationTimerRef.current = window.setTimeout(() => {
      navAnimationTimerRef.current = null;
      setNavAnimating(false);
    }, NAV_COLLAPSE_MS);
  };

  /**
   * 任务通知先落到通知汇总页，由通知页就地打开任务详情；关闭弹窗后仍停留在
   * /notifications，不再把人带到项目内部。其余通知保持原有跳转。
   */
  const handleOpenTarget = (targetPath: string) => {
    const taskState = createNotificationTaskOpenState(targetPath);
    if (taskState !== null) {
      navigate("/notifications", { state: taskState });
      return;
    }
    // 目标页 chunk 与记录详情都就绪后再切换，避免铃铛弹层关闭后先露出骨架。
    const records = prefetchRecordPath(queryClient, targetPath, projectClient);
    void Promise.all([
      preloadRoutePath(targetPath),
      records ?? Promise.resolve(),
    ]).finally(() => navigate(targetPath));
  };

  const handleOpenSearch = (query: string) => {
    navigate(`/search?${new URLSearchParams({ q: query.trim() }).toString()}`);
  };

  const handleAccountAction = async () => {
    setAccountOpen(false);
    if (status !== "authenticated") {
      // 未登录先回登录页：登录页默认直达统一身份认证（ADR-080）。
      navigate("/login");
      return;
    }
    setIsLoggingOut(true);
    const loggedOut = await logout()
      .then(() => true)
      .catch(() => false);
    if (!loggedOut) {
      setIsLoggingOut(false);
      return;
    }
    // 退出后回到干净的 /login（不带 from），登录页随后自动发起统一身份认证
    // （ADR-080；SSO 未启用时由服务端 302 回落到本地应急口令入口）。退出态
    // 必须保持到路由真正落到 /login（见 isLoggingOut 的 effect）：认证态一旦
    // 收敛为匿名，受保护页面若仍在渲染，RequireAuth 会先把当前地址写成
    // /login?from=...，换账号登录就会落回上一个账号的页面。
    navigate("/login");
  };

  const renderNavigationItem = (item: NavigationItem) => {
    const count = shellCounts[item.key] ?? 0;
    // chunk 预取之外，项目动态还要预取首屏数据：只预取 chunk 时页面已切过去，
    // 但动态查询仍会先渲染一帧时间线骨架，观感就是“闪一下”。
    const preloadNavigation = (): Promise<void> => {
      const chunk = preloadRoutePath(item.path);
      let data = Promise.resolve();
      if (item.key === "activity") {
        data = prefetchActivityRoute(queryClient, {
          ...(projectScopeId === null ? {} : { projectId: projectScopeId }),
          includeAdminOnly: user?.isAdmin === true,
          ...(projectClient === undefined ? {} : { client: projectClient }),
        });
      } else if (item.key === "tasks") {
        data = prefetchTaskCenterRoute(queryClient, {
          viewerId: user?.id ?? null,
          isAdmin: user?.isAdmin === true,
          ...(projectClient === undefined ? {} : { client: projectClient }),
        });
      } else if (item.key === "records") {
        data = prefetchRecordsRoute(queryClient, projectClient);
      } else if (item.key === "issues") {
        data = prefetchIssuesRoute(queryClient, projectClient);
      } else if (item.key === "settings") {
        data = prefetchSettingsRoute(queryClient, {
          isAdmin: user?.isAdmin === true,
          ...(projectClient === undefined ? {} : { client: projectClient }),
        });
      }
      return Promise.all([chunk, data]).then(() => undefined);
    };
    const prepareNavigation = (): Promise<void> => {
      const existing = navigationPreparationRef.current.get(item.key);
      if (existing !== undefined) return existing;
      const prepared = preloadNavigation();
      navigationPreparationRef.current.set(item.key, prepared);
      return prepared;
    };
    return (
      <React.Fragment key={item.key}>
        <button
          type="button"
          className={"nav-item" + (selectedKey === item.key ? " active" : "")}
          aria-current={selectedKey === item.key ? "page" : undefined}
          aria-expanded={item.key === "projects" ? projectMenuOpen : undefined}
          {...(item.key === "projects"
            ? { "aria-controls": "sidebar-project-menu" }
            : {})}
          onPointerEnter={() => void prepareNavigation()}
          onPointerDown={() => void prepareNavigation()}
          onFocus={() => void prepareNavigation()}
          onClick={() => {
            // 「项目列表」同时完成两件事：跳到项目列表页，并展开侧栏项目抽屉。
            if (item.key === "projects") {
              setProjectMenuOpen(true);
            }
            void prepareNavigation().finally(() => {
              navigationPreparationRef.current.delete(item.key);
              handleNavigation(item.path);
            });
          }}
        >
          {item.icon ? <InpulseIcon name={item.icon} size={17} /> : null}
          <span>{item.label}</span>
          {count > 0 ? (
            <em
              aria-hidden="true"
              title={
                item.key === "projects"
                  ? `${count} 个项目`
                  : `${count} 项待处理`
              }
            >
              {count}
            </em>
          ) : null}
        </button>
      </React.Fragment>
    );
  };

  if (location.pathname === "/login") {
    // 登录页使用独立的全屏视觉，不渲染工作台外壳。它同样是 React.lazy 路由，
    // 直接访问 /login 时需要自己的 Suspense；工作台外壳那层边界在这里不参与渲染。
    return (
      <Suspense
        fallback={
          <div
            style={{
              minHeight: "100vh",
              display: "grid",
              placeItems: "center",
              background: "#f4f6fa",
              color: "#6f7787",
              fontSize: 14,
            }}
          >
            正在载入登录页...
          </div>
        }
      >
        <Outlet />
      </Suspense>
    );
  }

  return (
    <>
      <div
        className={
          "app-shell" +
          (navCollapsed ? " nav-collapsed" : "") +
          (navAnimating ? " nav-animating" : "")
        }
      >
        {/* 顶栏已移除：窄屏导航开关改为左上角悬浮按钮（仅 ≤700px 显示）。 */}
        <button
          type="button"
          className="icon-button menu-button"
          aria-label={mobileNavOpen ? "关闭导航" : "打开导航"}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((current) => !current)}
        >
          <InpulseIcon name="menu" size={20} />
        </button>
        {navCollapsed ? (
          // 桌面端收起后沿用窄屏开关的位置与外观，只负责把导航放回来（仅 >700px 显示）。
          <button
            type="button"
            className="icon-button sidebar-expand-button"
            aria-label="展开导航"
            title="展开导航"
            aria-controls="app-sidebar"
            aria-expanded={false}
            onClick={() => handleToggleNav(false)}
          >
            <InpulseIcon name="menu" size={20} />
          </button>
        ) : null}
        <aside
          ref={sidebarRef}
          id="app-sidebar"
          className={`sidebar${mobileNavOpen ? " sidebar-open" : ""}`}
        >
          <div className="brand brand-joint">
            <div className="joint-logo-frame">
              <img
                src="/inpulse-joint-logo.png"
                alt="Libiao Robotics | InPulse"
                width={480}
                height={174}
                className="joint-logo"
              />
            </div>
            <button
              type="button"
              className="icon-button sidebar-collapse-button"
              aria-label="收起导航"
              title="收起导航"
              aria-controls="app-sidebar"
              aria-expanded
              onClick={() => handleToggleNav(true)}
            >
              {/* 收起导航用「面板」图标（2026-10-09 用户指示，替换原来的左箭头）。 */}
              <InpulseIcon name="panelLeft" size={18} />
            </button>
          </div>
          <nav className="nav-group" aria-label="工作区导航">
            <p>工作台</p>
            {workspaceNavigation.map((item) =>
              item.key === "projects" ? (
                <div
                  key={item.key}
                  className="nav-project-menu"
                  ref={projectMenuRef}
                >
                  {renderNavigationItem(item)}
                  {projectMenuOpen ? (
                    <div
                      id="sidebar-project-menu"
                      className="nav-tree-panel project-menu-panel"
                    >
                      <ProjectTree
                        activeScope={treeScope}
                        activePageSegment={projectPage?.segment ?? null}
                        onNavigate={handleNavigation}
                        onPreloadPath={preloadRoutePath}
                        {...(projectClient ? { client: projectClient } : {})}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                renderNavigationItem(item)
              ),
            )}
            <p className="nav-section">交付记录</p>
            {deliveryNavigation.map(renderNavigationItem)}
            <p className="nav-section">全局</p>
            {visibleGlobalNavigation.map(renderNavigationItem)}
          </nav>
          <div className="sidebar-footer">
            {/* 顶栏移除后账户菜单并入身份区：点击头像与姓名打开同一分组菜单。 */}
            <div
              className="popover-wrap footer-account-wrap"
              ref={accountRootRef}
            >
              <button
                type="button"
                className="footer-account"
                aria-label="账户菜单"
                aria-expanded={accountOpen}
                onClick={() => setAccountOpen((current) => !current)}
              >
                <span className="person-avatar">{avatarText}</span>
                <span className="footer-account-text">
                  <strong>{displayName}</strong>
                  <small>{roleLabel}</small>
                </span>
              </button>
              {accountOpen ? (
                <div
                  className="popover account-popover"
                  role="dialog"
                  aria-label="账户菜单"
                >
                  <div className="account-identity">
                    <span className="person-avatar">{avatarText}</span>
                    <div>
                      <strong>{displayName}</strong>
                      <small>{user?.email ?? "未绑定邮箱"}</small>
                      <small>{popoverRoleLabel}</small>
                    </div>
                  </div>
                  {user?.isAdmin ? (
                    <button
                      type="button"
                      onClick={() => handleNavigation("/settings")}
                    >
                      <InpulseIcon name="users" size={15} />
                      成员与权限
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setAccountOpen(false);
                      setWecomOpen(true);
                    }}
                  >
                    <InpulseIcon name="bell" size={15} />
                    绑定企业微信
                  </button>
                  <button
                    type="button"
                    disabled={isLoggingOut}
                    onClick={() => void handleAccountAction()}
                  >
                    <InpulseIcon name="logout" size={15} />
                    {isLoggingOut
                      ? "正在退出..."
                      : status === "authenticated"
                        ? "退出登录"
                        : "前往登录"}
                  </button>
                </div>
              ) : null}
            </div>
            {/* 搜索与通知收敛为底部常驻图标：窄屏不再隐藏，导航列表也不再重复入口。 */}
            <button
              type="button"
              className="icon-button"
              aria-label="打开全局搜索"
              title="全局搜索（Ctrl K）"
              onClick={() => setPaletteOpen(true)}
            >
              <InpulseIcon name="search" size={18} />
            </button>
            <NotificationBell
              client={notificationClient}
              enabled={status === "authenticated"}
              userId={user?.id ?? null}
              onOpen={() => handleNavigation("/notifications")}
              onOpenTarget={handleOpenTarget}
            />
          </div>
        </aside>

        <main className="content-shell">
          <div className="page-content">
            {isLoggingOut ? (
              // 退出登录期间先整体卸载受保护子树：logout() 会把认证态收敛为匿
              // 名，若页面此时仍在渲染，RequireAuth 会在跳转前先把当前地址写成
              // /login?from=...，导致换另一个账号登录后又落回上一个账号的页面。
              // 退出完成后由 handleAccountAction 统一落到干净的 /login。
              <div data-testid="logout-pending" style={{ padding: 48 }}>
                <CalmSkeleton
                  variant="lines"
                  rows={4}
                  label="正在退出登录..."
                />
              </div>
            ) : (
              <Suspense
                fallback={
                  <div style={{ padding: 48 }}>
                    <CalmSkeleton
                      variant="lines"
                      rows={4}
                      label="正在加载页面..."
                    />
                  </div>
                }
              >
                <Outlet />
              </Suspense>
            )}
          </div>
        </main>
      </div>
      <WecomBindingModal
        open={wecomOpen}
        onClose={() => setWecomOpen(false)}
        {...(notificationClient ? { client: notificationClient } : {})}
      />
      {/* ADR-079：未绑定企业微信的主动提醒；「去绑定」复用上面的绑定弹窗。 */}
      <WecomBindingPromptModal
        enabled={status === "authenticated" && !isLoggingOut}
        userId={user?.id ?? null}
        onGoBind={() => setWecomOpen(true)}
        {...(notificationClient ? { client: notificationClient } : {})}
      />
      <CommandPalette
        open={paletteOpen}
        isAdmin={user?.isAdmin === true}
        {...(notificationClient ? { client: notificationClient } : {})}
        onClose={() => setPaletteOpen(false)}
        onNavigate={handleNavigation}
        onOpenSearch={handleOpenSearch}
      />
    </>
  );
};
