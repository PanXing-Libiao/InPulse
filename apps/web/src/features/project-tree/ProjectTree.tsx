import React, { useEffect, useMemo, useState } from "react";
import type {
  FeatureItem,
  InpulseApiClient,
  ModuleItem,
  ProjectItem,
} from "@generated/api";
import {
  InpulseIcon,
  type InpulseIconName,
} from "@features/common/components/InpulseIcon";
import { ProjectLogo } from "@features/common/components/ProjectLogo";
import { projectTier } from "@features/common/resource-lifecycle";
import { useProjectTier } from "@features/common/project-tier-context";
import { useFeatures } from "@features/features/feature-query";
import { useModules } from "@features/modules/module-query";
import { useProjects } from "@features/projects/project-query";
import {
  orderProjectsStarredFirst,
  useProjectStars,
} from "@features/projects/project-star";
import { treePath, type TreeScope, type TreeSelection } from "./tree-selection";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

/**
 * 导航预取：鼠标悬停 / 按下 / 键盘聚焦时提前把这行的目标页面 chunk 拉进模块缓存。
 * 回调由 app 层注入（AppLayout 传 `preloadRoutePath`）——features 不能反向依赖
 * app/router，所以在这里用局部 context 把它透给同一文件里的各行，不再层层传 prop。
 */
const noopPreload = () => undefined;

const RoutePreloadContext =
  React.createContext<(path: string) => void>(noopPreload);

function usePreloadHandlers(path: string) {
  const preload = React.useContext(RoutePreloadContext);
  return {
    onPointerEnter: () => preload(path),
    onPointerDown: () => preload(path),
    onFocus: () => preload(path),
  } as const;
}

export interface ProjectTreeProps {
  readonly activeScope: TreeScope | null;
  /** 当前项目页分段（overview/modules/task-board/members/activity），非项目页为 null。 */
  readonly activePageSegment?: string | null;
  readonly onNavigate: (path: string) => void;
  /** 导航意图预取回调（app 层注入）：悬停/按下/聚焦时预热目标页面 chunk。 */
  readonly onPreloadPath?: ((path: string) => void) | undefined;
  readonly client?: InpulseApiClient | undefined;
}

/**
 * 项目节点下的子页行：点击跳转既有项目页，与目录树共用导航语义。
 * 「项目成员」不再单列一行（项目主页头部的「成员与设置」已覆盖），
 * 任务看板排在模块与功能之前，但项目默认落点仍是模块与功能。
 */
/** 展开键归属的项目 ID：project:<id>[:...]；非项目键返回 null。 */
function projectOwnerOf(key: string): number | null {
  const match = /^project:(\d+)(?::|$)/.exec(key);
  return match ? Number(match[1]) : null;
}

/** 收起动画时长（毫秒）：与 design-system.css 里折叠区块 grid-template-rows 的
 * 过渡时长一致——收起时等高度与淡出动画走完再卸载内容，展开时立即挂载。 */
const COLLAPSE_MS = 240;

/**
 * 折叠区块的挂载保持：展开立即可见，收起延迟卸载。
 * 既保住模块 / 功能列表的懒加载（未展开不请求），又让收起有完整动画，
 * 不会出现「容器还在收缩、内容已经消失」的断层。
 */
function useRetainedMount(open: boolean): boolean {
  const [retained, setRetained] = React.useState(open);
  React.useEffect(() => {
    if (open) {
      setRetained(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setRetained(false), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  return retained;
}

const PROJECT_PAGE_ROWS: readonly {
  readonly segment: string;
  readonly label: string;
  readonly icon: InpulseIconName;
}[] = [
  { segment: "task-board", label: "任务看板", icon: "kanban" },
  // 层级语义：layers=模块与功能目录，boxes=模块容器，fileText=功能档案条目。
  { segment: "modules", label: "模块与功能", icon: "layers" },
];

interface ProjectPageRowProps {
  readonly projectId: number;
  readonly segment: string;
  readonly label: string;
  readonly icon: InpulseIconName;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly onClick: (segment: string, projectId: number) => void;
}

const ProjectPageRow: React.FC<ProjectPageRowProps> = ({
  projectId,
  segment,
  label,
  icon,
  active,
  expanded,
  onClick,
}) => (
  <button
    type="button"
    className={`tree-row page-node${active ? " selected" : ""}${
      expanded ? " expanded" : ""
    }`}
    aria-expanded={segment === "modules" ? expanded : undefined}
    aria-current={active ? "true" : undefined}
    {...usePreloadHandlers(`/projects/${projectId}/${segment}`)}
    onClick={() => onClick(segment, projectId)}
  >
    <InpulseIcon name={icon} size={16} className="tree-icon" />
    <span className="tree-label">
      <strong>{label}</strong>
    </span>
  </button>
);

interface FeatureRowProps {
  readonly moduleId: number;
  readonly projectId: number;
  readonly item: FeatureItem;
  readonly selection: TreeSelection | null;
  readonly onFeatureClick: (selection: TreeSelection) => void;
}

interface FeatureListProps {
  readonly projectId: number;
  readonly moduleId: number;
  readonly selection: TreeSelection | null;
  readonly onFeatureClick: (selection: TreeSelection) => void;
  readonly client?: InpulseApiClient | undefined;
}
const FeatureRow: React.FC<FeatureRowProps> = ({
  moduleId,
  projectId,
  item,
  selection,
  onFeatureClick,
}) => {
  const isSelected =
    selection?.kind === "feature" &&
    selection.moduleId === moduleId &&
    selection.featureId === item.id;
  return (
    <button
      type="button"
      className={`tree-row feature-node${isSelected ? " selected" : ""}`}
      aria-current={isSelected ? "true" : undefined}
      title={item.name}
      {...usePreloadHandlers(
        `/projects/${projectId}/modules/${moduleId}/features/${item.id}`,
      )}
      onClick={() =>
        onFeatureClick({ kind: "feature", moduleId, featureId: item.id })
      }
    >
      <InpulseIcon name="fileText" size={16} className="tree-icon" />
      <span className="tree-label">
        <strong>{item.name}</strong>
      </span>
    </button>
  );
};

const FeatureList: React.FC<FeatureListProps> = ({
  projectId,
  moduleId,
  selection,
  onFeatureClick,
  client,
}) => {
  const features = useFeatures(projectId, moduleId, undefined, client);
  if (features.query.isPending) {
    return (
      <CalmSkeleton
        variant="lines"
        rows={3}
        compact
        tone="sidebar"
        label="正在加载功能…"
      />
    );
  }
  if (features.query.isError) {
    return <p className="tree-hint">功能加载失败</p>;
  }
  const items = features.query.data?.items ?? [];
  if (items.length === 0) {
    return <p className="tree-hint">暂无功能</p>;
  }
  return (
    <>
      {items.map((item) => (
        <FeatureRow
          key={item.id}
          projectId={projectId}
          item={item}
          moduleId={moduleId}
          selection={selection}
          onFeatureClick={onFeatureClick}
        />
      ))}
    </>
  );
};

interface ModuleBranchProps {
  readonly projectId: number;
  readonly item: ModuleItem;
  readonly expanded: boolean;
  readonly selection: TreeSelection | null;
  readonly onModuleClick: (
    key: string,
    projectId: number,
    selection: TreeSelection,
  ) => void;
  readonly onFeatureClick: (
    projectId: number,
    selection: TreeSelection,
  ) => void;
  readonly client?: InpulseApiClient | undefined;
}

const ModuleBranch: React.FC<ModuleBranchProps> = ({
  projectId,
  item,
  expanded,
  selection,
  onModuleClick,
  onFeatureClick,
  client,
}) => {
  const key = `project:${projectId}:module:${item.id}`;
  const featuresRendered = useRetainedMount(expanded);
  const isSelected =
    selection?.kind === "module" && selection.moduleId === item.id;
  const inPath =
    selection?.kind === "feature" && selection.moduleId === item.id;
  return (
    <div className="tree-project">
      <button
        type="button"
        className={`tree-row module-node${isSelected ? " selected" : ""}${
          inPath ? " in-path" : ""
        }${expanded ? " expanded" : ""}`}
        aria-expanded={expanded}
        aria-current={isSelected ? "true" : undefined}
        title={item.name}
        onClick={() =>
          onModuleClick(key, projectId, { kind: "module", moduleId: item.id })
        }
      >
        <InpulseIcon name="boxes" size={16} className="tree-icon" />
        <span className="tree-label">
          <strong>{item.name}</strong>
        </span>
      </button>
      <div
        className="tree-children"
        data-open={expanded ? "true" : "false"}
        aria-hidden={expanded ? undefined : true}
      >
        <div className="tree-children-clip">
          {featuresRendered ? (
            <FeatureList
              projectId={projectId}
              moduleId={item.id}
              selection={selection}
              onFeatureClick={(next) => onFeatureClick(projectId, next)}
              client={client}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

/**
 * 侧栏系统目录：项目与功能导航展开后先罗列所有项目，点击项目再罗列模块、
 * 点击模块再罗列功能；点击节点跳转到既有的项目主页、功能目录与功能档案
 * 页面，内容区功能不在此重复实现。当前路由所在链路自动展开，且展开状态在
 * 跳转到其它层级或页面后保持不变，避免回到项目概况时子级被收起。
 */
interface ModuleListProps {
  readonly projectId: number;
  readonly selection: TreeSelection | null;
  readonly expandedKeys: ReadonlySet<string>;
  readonly onModuleClick: (
    key: string,
    projectId: number,
    selection: TreeSelection,
  ) => void;
  readonly onFeatureClick: (
    projectId: number,
    selection: TreeSelection,
  ) => void;
  readonly client?: InpulseApiClient | undefined;
}

const ModuleList: React.FC<ModuleListProps> = ({
  projectId,
  selection,
  expandedKeys,
  onModuleClick,
  onFeatureClick,
  client,
}) => {
  const modules = useModules(projectId, client);
  if (modules.query.isPending) {
    return (
      <CalmSkeleton
        variant="lines"
        rows={3}
        compact
        tone="sidebar"
        label="正在加载模块…"
      />
    );
  }
  if (modules.query.isError) {
    return <p className="tree-hint">模块加载失败</p>;
  }
  const items = modules.query.data?.items ?? [];
  if (items.length === 0) {
    return <p className="tree-hint">暂无模块</p>;
  }
  return (
    <>
      {items.map((item) => (
        <ModuleBranch
          key={item.id}
          projectId={projectId}
          item={item}
          expanded={expandedKeys.has(`project:${projectId}:module:${item.id}`)}
          selection={selection}
          onModuleClick={onModuleClick}
          onFeatureClick={onFeatureClick}
          client={client}
        />
      ))}
    </>
  );
};

interface ProjectBranchProps {
  readonly item: ProjectItem;
  readonly expanded: boolean;
  readonly modulesExpanded: boolean;
  readonly activeScope: TreeScope | null;
  readonly activePageSegment: string | null;
  readonly expandedKeys: ReadonlySet<string>;
  readonly onProjectClick: (projectId: number) => void;
  readonly onPageClick: (segment: string, projectId: number) => void;
  readonly onModuleClick: (
    key: string,
    projectId: number,
    selection: TreeSelection,
  ) => void;
  readonly onFeatureClick: (
    projectId: number,
    selection: TreeSelection,
  ) => void;
  readonly client?: InpulseApiClient | undefined;
}

const ProjectBranch: React.FC<ProjectBranchProps> = ({
  item,
  expanded,
  modulesExpanded,
  activeScope,
  activePageSegment,
  expandedKeys,
  onProjectClick,
  onPageClick,
  onModuleClick,
  onFeatureClick,
  client,
}) => {
  const branchRendered = useRetainedMount(expanded);
  const modulesRendered = useRetainedMount(modulesExpanded);
  const isActiveProject = activeScope?.projectId === item.id;
  const isSelected =
    isActiveProject && activeScope?.selection.kind === "project";
  const pageSegment = isActiveProject ? activePageSegment : null;
  return (
    <div className="tree-project">
      <button
        type="button"
        className={`tree-row project-node${isSelected ? " selected" : ""}${
          expanded ? " expanded" : ""
        }`}
        aria-expanded={expanded}
        aria-current={isSelected ? "true" : undefined}
        title={item.name}
        {...usePreloadHandlers(`/projects/${item.id}/modules`)}
        onClick={() => onProjectClick(item.id)}
      >
        <ProjectLogo code={item.code} className="tree-logo" />
        <span className="tree-label">
          <strong>{item.name}</strong>
        </span>
        {/* 项目编码是唯一短标识：同名/相近的项目行靠它区分。 */}
        <span className="tree-code">{item.code}</span>
      </button>
      <div
        className="tree-children"
        data-open={expanded ? "true" : "false"}
        aria-hidden={expanded ? undefined : true}
      >
        <div className="tree-children-clip">
          {branchRendered ? (
            <>
              {PROJECT_PAGE_ROWS.map((row) => (
                <ProjectPageRow
                  key={row.segment}
                  projectId={item.id}
                  segment={row.segment}
                  label={row.label}
                  icon={row.icon}
                  active={pageSegment === row.segment}
                  expanded={row.segment === "modules" && modulesExpanded}
                  onClick={onPageClick}
                />
              ))}
              {/* 模块列表单独放进滚动区：展开某个项目时其它项目仍然完整露出，滚动条只
              属于这个项目，且滚动条槽常驻，长短变化不再挤动行宽（限高与槽位见
              design-system.css 的 .tree-modules-scroll）。 */}
              <div
                className="tree-modules"
                data-open={modulesExpanded ? "true" : "false"}
                aria-hidden={modulesExpanded ? undefined : true}
              >
                <div className="tree-modules-scroll">
                  {modulesRendered ? (
                    <ModuleList
                      projectId={item.id}
                      selection={isActiveProject ? activeScope.selection : null}
                      expandedKeys={expandedKeys}
                      onModuleClick={onModuleClick}
                      onFeatureClick={onFeatureClick}
                      client={client}
                    />
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const ProjectTree: React.FC<ProjectTreeProps> = ({
  activeScope,
  activePageSegment = null,
  onNavigate,
  onPreloadPath,
  client,
}) => {
  const projects = useProjects({ client });
  const { tier } = useProjectTier();
  const { isStarred } = useProjectStars();
  const [extraExpanded, setExtraExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 当前项目：手风琴规则的唯一依据（见下方 expandedKeys 与切换副作用）。
  const activeProjectId = activeScope?.projectId ?? null;
  const chainKeys = useMemo(() => {
    const keys = new Set<string>();
    if (activeScope === null) {
      return keys;
    }
    keys.add(`project:${activeScope.projectId}`);
    // 模块列表挂在「模块与功能」子页行下：只有停留在该页时才自动展开。
    if (activePageSegment === "modules") {
      keys.add(`project:${activeScope.projectId}:pages:modules`);
    }
    if (activeScope.selection.kind !== "project") {
      keys.add(
        `project:${activeScope.projectId}:module:${activeScope.selection.moduleId}`,
      );
    }
    return keys;
  }, [activeScope, activePageSegment]);
  // 手风琴（2026-10-09 用户指示）：树里任何时刻至多铺开一个项目，且只有「当前项目」
  // 能铺开——展开态由路由推导，不靠点击累积。项目列表页没有当前项目，整棵树因此默认
  // 收起；进入项目默认打开、点开另一个项目自动收起前一个，都由 activeProjectId 统一
  // 驱动，从目录树、项目卡片或面包屑进来结果一致。
  const expandedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (activeProjectId === null) {
      return keys;
    }
    const ownedByCurrentProject = (key: string) =>
      projectOwnerOf(key) === activeProjectId;
    for (const key of chainKeys) {
      if (ownedByCurrentProject(key) && !collapsed.has(key)) {
        keys.add(key);
      }
    }
    for (const key of extraExpanded) {
      if (ownedByCurrentProject(key) && !collapsed.has(key)) {
        keys.add(key);
      }
    }
    return keys;
  }, [activeProjectId, chainKeys, collapsed, extraExpanded]);
  // 链路只负责自动展开、不负责收回：展开过的节点写入 extraExpanded 保留，
  // 用面包屑回到项目概况等上层页面时子级不自动收起，只有点击节点才开合。
  useEffect(() => {
    setExtraExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const key of chainKeys) {
        if (!next.has(key) && !collapsed.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [chainKeys, collapsed]);

  // 切换（含进入 / 离开）项目时只保留当前项目的展开痕迹，并清掉收起标记：
  // 上一个项目的残留键不会带到新项目，重新进入某个项目也总是「默认打开」，
  // 而不是继承上一次在树上把它收起的状态。
  useEffect(() => {
    setExtraExpanded((prev) => {
      if (activeProjectId === null) {
        return prev.size === 0 ? prev : new Set<string>();
      }
      const next = new Set<string>();
      for (const key of prev) {
        if (projectOwnerOf(key) === activeProjectId) {
          next.add(key);
        }
      }
      return next.size === prev.size ? prev : next;
    });
    setCollapsed((prev) => (prev.size === 0 ? prev : new Set<string>()));
  }, [activeProjectId]);

  const toggle = (key: string) => {
    if (expandedKeys.has(key)) {
      setExtraExpanded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setCollapsed((prev) => new Set(prev).add(key));
      return;
    }
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setExtraExpanded((prev) => new Set(prev).add(key));
  };
  const handleProjectClick = (projectId: number) => {
    // 与模块节点一致：点击导航到项目主页并开合切换，再次点击收回子页列表。
    // 其它项目的收起由下方手风琴副作用统一负责。
    onNavigate(treePath(projectId, { kind: "project" }));
    toggle(`project:${projectId}`);
  };
  const handlePageClick = (segment: string, projectId: number) => {
    onNavigate(`/projects/${projectId}/${segment}`);
    // 只有「模块与功能」行控制模块列表开合；其余子页行只导航，不收起项目子级。
    if (segment === "modules") {
      toggle(`project:${projectId}:pages:modules`);
    }
  };
  const handleModuleClick = (
    key: string,
    projectId: number,
    next: TreeSelection,
  ) => {
    onNavigate(treePath(projectId, next));
    toggle(key);
  };
  const handleFeatureClick = (projectId: number, next: TreeSelection) => {
    onNavigate(treePath(projectId, next));
  };

  const allProjects = projects.data?.items ?? [];
  // 侧栏与项目列表页共享同一分档（`ProjectTierProvider`，2026-10-09 用户指示）：
  // 未完成档只列进行中 / 未开始，维护中档只列维护中项目。
  // 当前所在项目始终保留：分档是浏览过滤器，不该把正在看的项目从树上摘掉，
  // 否则从「维护中」档点进项目后侧栏立刻找不到它。
  // 星标项目置顶与项目列表页共用同一条规则（2026-10-21 用户指示）。
  const items = orderProjectsStarredFirst(
    allProjects.filter(
      (item) =>
        projectTier(item.status) === tier || item.id === activeProjectId,
    ),
    isStarred,
  );
  // 空态要分清「一个项目都没有」和「这一档没有项目」，后者是筛选结果
  // 而不是系统里真的没有项目。
  const emptyHint =
    allProjects.length === 0
      ? "暂无项目"
      : tier === "maintenance"
        ? "暂无维护中的项目"
        : "暂无未完成的项目";
  return (
    <div className="project-tree">
      <RoutePreloadContext.Provider value={onPreloadPath ?? noopPreload}>
        <div className="project-tree-scroll">
          {projects.isPending ? (
            <CalmSkeleton
              variant="lines"
              rows={3}
              compact
              tone="sidebar"
              label="正在加载项目…"
            />
          ) : projects.isError ? (
            <p className="tree-hint">项目加载失败</p>
          ) : items.length === 0 ? (
            <p className="tree-hint">{emptyHint}</p>
          ) : (
            items.map((item) => (
              <ProjectBranch
                key={item.id}
                item={item}
                expanded={expandedKeys.has(`project:${item.id}`)}
                modulesExpanded={expandedKeys.has(
                  `project:${item.id}:pages:modules`,
                )}
                activeScope={activeScope}
                activePageSegment={activePageSegment}
                expandedKeys={expandedKeys}
                onProjectClick={handleProjectClick}
                onPageClick={handlePageClick}
                onModuleClick={handleModuleClick}
                onFeatureClick={handleFeatureClick}
                client={client}
              />
            ))
          )}
        </div>
      </RoutePreloadContext.Provider>
    </div>
  );
};
