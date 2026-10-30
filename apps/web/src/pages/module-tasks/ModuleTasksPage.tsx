import React, { lazy, Suspense, useState } from "react";
import { Alert, Button } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { useModules } from "@features/modules/module-query";
import {
  ModuleEditorModal,
  type ModuleEditorRequest,
} from "@features/modules/ModuleEditorModal";
import { useProjectDetail } from "@features/projects/project-query";
import {
  TasksPanel,
  taskStatusFilterOptions,
} from "@features/tasks/TasksPanel";
import type { TaskLocation } from "@features/tasks/task-links";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { CalmSegmented } from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

/**
 * 聚合组详情里的成员任务就地打开任务详情（与任务中心同一实现：状态推进、编辑、
 * 迭代记录、合并与外部链接等写入口全在同一处）。按需加载，模块任务页的初始包
 * 不引入任务详情的完整实现。
 */
const TaskDetailOverlay = lazy(
  () => import("@features/tasks/TaskDetailOverlay"),
);

export default function ModuleTasksPage() {
  const navigate = useNavigate();
  const params = useParams();
  const projectId = Number(params["projectId"]);
  const moduleId = Number(params["moduleId"]);
  const validScope = [projectId, moduleId].every(
    (id) => Number.isInteger(id) && id > 0 && id <= 2147483647,
  );
  const { query } = useModules(projectId);
  const projectQuery = useProjectDetail({ projectId, enabled: validScope });
  const [taskTarget, setTaskTarget] = useState<TaskLocation | null>(null);
  const [moduleRequest, setModuleRequest] =
    useState<ModuleEditorRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [taskCount, setTaskCount] = useState(0);
  if (!validScope) return <Alert type="error" title="模块地址无效" />;
  if (query.isPending)
    return <CalmSkeleton variant="list" rows={4} label="正在加载模块任务" />;
  if (query.isError)
    return (
      <Alert
        type="error"
        title="模块不存在或无法访问"
        action={<Button onClick={() => void query.refetch()}>重试</Button>}
      />
    );
  const module = query.data?.items.find((item) => item.id === moduleId);
  // 换项目时 useModules 会先保留上一份模块列表（见 module-query 的 keepPreviousData），
  // 这一刻新模块还查不到；仍在取数就先给等待态，不能当成「模块不存在」报错。
  if (!module)
    return query.isFetching ? (
      <CalmSkeleton variant="list" rows={4} label="正在加载模块任务" />
    ) : (
      <Alert type="error" title="模块不存在或无法访问" />
    );
  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title-row">
            <button
              type="button"
              className="title-back-button"
              aria-label="返回模块列表"
              title="返回模块列表"
              onClick={() => navigate("/projects/" + projectId + "/modules")}
            >
              <InpulseIcon name="chevronLeft" size={20} />
            </button>
            <h1>{module.name}</h1>
          </div>
          {module.description ? (
            <p className="module-description">{module.description}</p>
          ) : null}
        </div>
        <div className="catalog-actions">
          <Button
            className="secondary-button"
            onClick={() => setModuleRequest({ action: "update", item: module })}
          >
            编辑模块
          </Button>
          <Button
            className="primary-button"
            onClick={() => setCreateOpen(true)}
          >
            <InpulseIcon name="plus" size={15} />
            新建任务
          </Button>
        </div>
      </div>
      <div className="module-work-bar">
        <div className="module-task-summary">
          <strong>任务</strong>
          <span>{taskCount} 项</span>
        </div>
        <div className="module-view-controls">
          <CalmSelect
            className="task-status-filter"
            value={statusFilter}
            onChange={(next) => setStatusFilter(String(next))}
            options={taskStatusFilterOptions}
            appearance="menu"
            ariaLabel="任务状态筛选"
            animated
          />
          <CalmSegmented
            label="任务展示方式"
            value={view}
            options={[
              { value: "cards", label: "卡片" },
              { value: "list", label: "列表" },
            ]}
            onChange={setView}
          />
          <div className="task-search">
            <InpulseIcon name="search" size={15} />
            <input
              aria-label="搜索当前模块的任务"
              placeholder="搜索当前模块的任务"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
      </div>
      <TasksPanel
        projectId={projectId}
        moduleId={moduleId}
        writable
        onOpenTask={setTaskTarget}
        showHeader={false}
        view={view}
        onViewChange={setView}
        search={search}
        onSearchChange={setSearch}
        createOpen={createOpen}
        onCreateClose={() => setCreateOpen(false)}
        onCountChange={setTaskCount}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        suppressCreateAction
      />
      <ModuleEditorModal
        projectId={projectId}
        projectName={projectQuery.data?.project?.name ?? null}
        request={moduleRequest}
        onClose={() => setModuleRequest(null)}
        onDeleted={() => navigate("/projects/" + projectId + "/modules")}
      />
      <Suspense fallback={null}>
        {taskTarget === null ? null : (
          <TaskDetailOverlay
            target={taskTarget}
            onClose={() => setTaskTarget(null)}
            onOpenTask={setTaskTarget}
          />
        )}
      </Suspense>
    </>
  );
}
