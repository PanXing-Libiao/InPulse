import React, { lazy, Suspense, useState } from "react";
import { Alert, Button } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { useModules } from "@features/modules/module-query";
import {
  ModuleEditorModal,
  type ModuleEditorRequest,
} from "@features/modules/ModuleEditorModal";
import { useProjectDetail } from "@features/projects/project-query";
import { TasksPanel } from "@features/tasks/TasksPanel";
import type { TaskLocation } from "@features/tasks/task-links";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { CalmBadge } from "@features/common/components/Calm";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { formatBeijingMinute } from "@features/common/beijing-time";
import {
  moduleLifecycleLabel,
  moduleLifecycleTone,
} from "@features/common/resource-lifecycle";

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
  const [search, setSearch] = useState("");
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
  const projectName = projectQuery.isPending
    ? "加载中"
    : (projectQuery.data?.project?.name ?? "名称暂不可用");
  return (
    <>
      <div className="module-document">
        <header className="module-document-header">
          <div className="module-document-heading">
            <div className="module-title-row">
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
            <p className="module-document-description">
              {module.description || "尚未补充模块说明。"}
            </p>
            <div className="task-modal-badges">
              {module.kind === "UNCLASSIFIED" ? (
                <CalmBadge tone="violet">未分类</CalmBadge>
              ) : null}
              <CalmBadge
                tone={moduleLifecycleTone(
                  module.stats.completedTaskCount,
                  "blue",
                )}
              >
                {moduleLifecycleLabel(module.stats.completedTaskCount)}
              </CalmBadge>
              <CalmBadge tone="gray">
                更新 {formatBeijingMinute(module.updatedAt)}
              </CalmBadge>
            </div>
          </div>
          <div className="catalog-actions">
            <Button
              className="secondary-button"
              onClick={() =>
                setModuleRequest({ action: "update", item: module })
              }
            >
              编辑模块
            </Button>
          </div>
        </header>
        <div className="module-document-content">
          <div className="module-document-grid">
            <div className="module-document-main">
              <section className="module-task-section" aria-label="模块任务">
                <TasksPanel
                  projectId={projectId}
                  moduleId={moduleId}
                  writable
                  onOpenTask={setTaskTarget}
                  search={search}
                  onSearchChange={setSearch}
                />
              </section>
            </div>
            <aside className="module-facts" aria-label="模块档案">
              <h2>模块档案</h2>
              <dl>
                <dt>编号</dt>
                <dd>{module.code}</dd>
                <dt>所属项目</dt>
                <dd>{projectName}</dd>
                <dt>任务</dt>
                <dd>
                  {module.stats.openTaskCount} 项待办 ·{" "}
                  {module.stats.completedTaskCount} 项已完成
                </dd>
                <dt>数据版本</dt>
                <dd>v{module.rowVersion}</dd>
              </dl>
            </aside>
          </div>
        </div>
      </div>
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
