import React, { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { SearchParamsScope } from "@features/common/search-params-scope";
import { useOpenLeftoverCount } from "@features/issues/issues-query";
import { useProjects } from "@features/projects/project-query";
import type {
  MyTaskFilters,
  MyTasksAdapter,
} from "@features/my-tasks/my-tasks-types";
import {
  readMyTaskAdvancedOpen,
  readMyTaskFilters,
  writeMyTaskFilters,
} from "@features/my-tasks/my-tasks-url";
import { createMyTasksServerAdapter } from "@features/my-tasks/my-tasks-server";
import type { TaskLocation } from "@features/tasks/task-links";
import { TaskCenterPageView } from "@features/my-tasks/TaskCenterPageView";
import {
  loadIssuesPageView,
  loadTaskDetailOverlay,
} from "@features/project-overview/project-workspace-chunks";

/**
 * 任务详情弹窗按需加载：任务中心的初始包不引入模块任务页的完整任务面板，
 * 首次点击任务卡片时才加载详情弹窗与配套写入口。
 */
const TaskDetailOverlay = lazy(loadTaskDetailOverlay);

/**
 * 遗留问题弹窗同样按需加载：与项目主页共用 F-20 视图，任务中心不再整页跳转到
 * `/issues`。视图自带 `useSearchParams` 状态，弹窗内用 `SearchParamsScope` 给它
 * 一份独立地址（项目筛选跟随任务中心当前筛选，与页面上的计数同口径），
 * 交互不污染浏览器地址栏。
 *
 * 装载与预热统一在 project-workspace-chunks：chunk 没到位时靠弹层外的 Suspense 整块不
 * 渲染，入口按钮悬停即预热，详见该文件顶部的说明。
 */
const IssuesPageView = lazy(loadIssuesPageView);

export interface TasksPageProps {
  readonly client?: InpulseApiClient;
  readonly adapter?: MyTasksAdapter;
}

export const TasksPage: React.FC<TasksPageProps> = ({ client, adapter }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [detailTarget, setDetailTarget] = useState<TaskLocation | null>(null);
  /** 遗留问题就地弹窗：false 表示关闭，打开时按当前项目筛选初始化视图作用域。 */
  const [issuesOpen, setIssuesOpen] = useState(false);
  const { user } = useAuth();
  const projectList = useProjects({ client });
  /**
   * 页头「遗留问题」入口的计数与侧栏导航同源（2026-09-22 修）：两者都是 R-6 未闭环
   * 桶条数，共用同一个查询键与写后失效，数字永远一致。项目筛选只收窄列表与工作状态，
   * 不再试图用一个恒为 0 的口径去猜「我的遗留问题」（原因见视图 props 注释）。
   */
  const openLeftoverCount = useOpenLeftoverCount({ client });

  const isAdmin = user?.isAdmin === true;
  const filters = useMemo(
    () => readMyTaskFilters(searchParams, { isAdmin }),
    [searchParams, isAdmin],
  );
  const advancedOpen = useMemo(
    () => readMyTaskAdvancedOpen(searchParams),
    [searchParams],
  );

  const handleFiltersChange = useCallback(
    (next: MyTaskFilters) => {
      setSearchParams(writeMyTaskFilters(next, { advancedOpen }), {
        replace: true,
      });
    },
    [advancedOpen, setSearchParams],
  );

  const handleToggleAdvanced = useCallback(() => {
    setSearchParams(
      writeMyTaskFilters(filters, { advancedOpen: !advancedOpen }),
      { replace: true },
    );
  }, [advancedOpen, filters, setSearchParams]);

  /**
   * 遗留问题不再整页跳转：头部入口与风险条都经这里就地打开弹窗，
   * 关闭后仍停留在任务中心，筛选状态与地址栏不变。
   */
  const handleOpenIssues = useCallback(() => {
    setIssuesOpen(true);
  }, []);

  const handleCloseIssues = useCallback(() => {
    setIssuesOpen(false);
  }, []);

  /**
   * 任务卡片 / 列表行与聚合组入口点击后在当前页面就地打开任务详情弹窗：与模块任务页
   * 共用同一个完整详情（含状态推进、编辑、迭代记录等写操作），不改变地址栏、不跳转，
   * 关闭后仍停留在任务中心。
   */
  const handleOpenTask = useCallback((task: TaskLocation) => {
    setDetailTarget(task);
  }, []);

  const handleCloseTask = useCallback(() => {
    setDetailTarget(null);
  }, []);

  const taskAdapter = useMemo(
    () => adapter ?? createMyTasksServerAdapter(client),
    [adapter, client],
  );

  return (
    <>
      <TaskCenterPageView
        filters={filters}
        onFiltersChange={handleFiltersChange}
        viewerId={user?.id ?? null}
        projects={projectList.data?.items ?? []}
        advancedOpen={advancedOpen}
        onToggleAdvanced={handleToggleAdvanced}
        onOpenIssues={handleOpenIssues}
        onOpenTask={handleOpenTask}
        leftoverCount={openLeftoverCount}
        adapter={taskAdapter}
        client={client}
      />
      {/* 弹层整体包在 Suspense 里（2026-10-12）：内容 chunk 没到位时什么都不渲染，
          不再出现「只有标题、正文空白」的空壳弹层（详见 project-workspace-chunks）。 */}
      {issuesOpen ? (
        <Suspense fallback={null}>
          <Modal
            open
            size="xl"
            label="遗留问题"
            eyebrow="任务中心"
            title="遗留问题"
            closeLabel="关闭遗留问题"
            onCancel={handleCloseIssues}
            className="project-workspace-modal"
          >
            <div className="project-workspace-modal-body">
              <SearchParamsScope
                initial={
                  filters.projectId === null
                    ? ""
                    : "projectId=" + String(filters.projectId)
                }
              >
                <IssuesPageView
                  {...(client ? { client } : {})}
                  onOpenTask={handleOpenTask}
                  embedded
                />
              </SearchParamsScope>
            </div>
          </Modal>
        </Suspense>
      ) : null}
      <Suspense fallback={null}>
        {detailTarget === null ? null : (
          <TaskDetailOverlay
            target={detailTarget}
            client={client}
            onClose={handleCloseTask}
            onOpenTask={handleOpenTask}
          />
        )}
      </Suspense>
    </>
  );
};

export default TasksPage;
