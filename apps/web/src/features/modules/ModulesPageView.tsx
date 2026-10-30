import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { useLocation, useNavigate } from "react-router-dom";
import {
  createApiClient,
  type InpulseApiClient,
  type ModuleItem,
  type ProjectDetailResponse,
  type ProjectDocumentImportResult,
  type ProjectItem,
} from "@generated/api";
import { useQueryClient } from "@tanstack/react-query";
import { DocumentImportModal } from "@features/document-import/DocumentImportModal";
import {
  RecordDetailModal,
  type RecordDetailTarget,
} from "@features/published-records/RecordDetailModal";
import type { ProjectOverviewIteration } from "@features/project-overview/project-overview-types";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { isCardClick } from "@features/common/card-click";
import {
  moduleLifecycleLabel,
  moduleLifecycleTone,
  projectLifecycleLabel,
} from "@features/common/resource-lifecycle";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSectionTitle,
} from "@features/common/components/Calm";
import { ProjectOverviewPageView } from "@features/project-overview/ProjectOverviewPageView";
import { createProjectOverviewServerAdapter } from "@features/project-overview/project-overview-server";
import {
  isProjectSetupComplete,
  type ProjectSetupGuideInput,
} from "@features/project-overview/ProjectSetupGuide";
import {
  ProjectWorkspaceModals,
  type ProjectWorkspaceModalKind,
} from "@features/project-overview/ProjectWorkspaceModals";
import { useAuth } from "@features/auth/auth-context";
import { EditProjectModal } from "@features/projects/ProjectManagementModals";
import { SuccessToast } from "@features/common/components/SuccessToast";
import {
  canDeleteProject,
  canManageProjectResources,
  useProjectDetail,
} from "@features/projects/project-query";
import { moduleErrorMessage, useModules } from "./module-query";
import { preloadRoutePath } from "@shared/routing/route-preload";
import {
  ModuleEditorModal,
  type ModuleEditorRequest,
} from "./ModuleEditorModal";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

export function ModulesPageView({
  projectId,
  client,
}: {
  projectId: number;
  client?: InpulseApiClient | undefined;
}) {
  const { query } = useModules(projectId, client);
  const navigate = useNavigate();
  const location = useLocation();
  const [request, setRequest] = useState<ModuleEditorRequest | null>(null);
  const [success, setSuccess] = useState(false);
  /** 成员与设置 / 迭代记录 / 遗留问题：就地弹窗，不再整页跳转。 */
  const [workspaceModal, setWorkspaceModal] =
    useState<ProjectWorkspaceModalKind | null>(null);
  /** 「最近迭代」单行：就地打开该条记录的详情弹窗。 */
  const [recordTarget, setRecordTarget] =
    useState<ProjectOverviewIteration | null>(null);
  /** 项目名旁的「编辑项目」弹窗，以及保存后的页头提示。 */
  const [projectEditOpen, setProjectEditOpen] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  /** 从文档导入模块/任务（ADR-064）：预览确认后单事务写入。 */
  const [importOpen, setImportOpen] = useState(false);
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const queryClient = useQueryClient();
  const open = (action: ModuleEditorRequest["action"], item?: ModuleItem) => {
    setSuccess(false);
    setRequest({ action, ...(item ? { item } : {}) });
  };
  /**
   * 「添加模块」入口带来的定位信号（history state）：只消费一次，落地即打开
   * 新增模块弹窗，随后把信号从历史状态里清掉，刷新或后退不会重复弹出。
   */
  const arrivalState = location.state as { createModule?: boolean } | null;
  const openCreateOnArrive = useRef(arrivalState?.createModule === true);
  useEffect(() => {
    if (!openCreateOnArrive.current) return;
    openCreateOnArrive.current = false;
    open("create");
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate]);
  const onOpenModule = (moduleId: number) =>
    navigate("/projects/" + projectId + "/modules/" + moduleId + "/tasks");
  const prefetchModule = (moduleId: number) => {
    void preloadRoutePath(
      "/projects/" + projectId + "/modules/" + moduleId + "/tasks",
    );
  };
  const projectQuery = useProjectDetail({
    client,
    projectId,
  });
  const projectName = projectQuery.data?.project?.name ?? null;
  const { user } = useAuth();
  // ADR-039：项目内管理入口对全体活跃成员与系统管理员开放。
  const canManageProject = canManageProjectResources(
    user?.isAdmin === true,
    projectQuery.data?.currentUserRole ?? null,
  );
  // ADR-062：删除项目只对系统管理员与本项目组长开放。
  const canDeleteCurrentProject = canDeleteProject(
    user?.isAdmin === true,
    projectQuery.data?.currentUserRole ?? null,
  );
  /**
   * 编辑项目或切换状态成功后就地回写详情缓存：弹窗继续操作时拿到的是服务端
   * 返回的新 rowVersion，不会拿旧版本撞 409；mutation 自身的失效随后从服务端校准。
   */
  const applyProjectUpdate = (updated: ProjectItem) => {
    const detail = queryClient.getQueryData<ProjectDetailResponse>([
      "projects",
      "detail",
      projectId,
    ]);
    if (detail === undefined) return;
    queryClient.setQueryData(["projects", "detail", projectId], {
      ...detail,
      project: updated,
    });
  };
  const overviewAdapter = useMemo(
    () => createProjectOverviewServerAdapter(client),
    [client],
  );
  const modules = query.data?.items ?? [];
  const taskCount = modules.reduce(
    (total, item) =>
      total + item.stats.openTaskCount + item.stats.completedTaskCount,
    0,
  );
  // 搭建引导只在列表读取成功后出现：加载中不闪烁，读取失败让位给错误态。
  const showSetupGuide =
    query.isSuccess && !isProjectSetupComplete(modules.length, taskCount);
  const setupGuide: ProjectSetupGuideInput | undefined = showSetupGuide
    ? {
        moduleCount: modules.length,
        taskCount,
        onCreateModule: () => open("create"),
        onImportDocument: () => setImportOpen(true),
      }
    : undefined;
  return (
    <>
      <div className="module-workspace-page">
        <ProjectOverviewPageView
          projectId={projectId}
          client={client}
          project={projectQuery.data?.project ?? null}
          projectLoading={projectQuery.isPending}
          onRetryProject={() => void projectQuery.refetch()}
          onBack={() => navigate("/projects")}
          onOpenMembers={() => setWorkspaceModal("members")}
          onOpenWecom={() => setWorkspaceModal("wecom")}
          onOpenRecords={() => setWorkspaceModal("records")}
          onOpenRecord={setRecordTarget}
          onOpenIssues={() => setWorkspaceModal("issues")}
          adapter={overviewAdapter}
          setupGuide={setupGuide}
          onEditProject={
            canManageProject ? () => setProjectEditOpen(true) : undefined
          }
        >
          {projectNotice && (
            <SuccessToast
              testId="project-update-success"
              title={projectNotice}
              onDismiss={() => setProjectNotice(null)}
            />
          )}
          {success && (
            <SuccessToast
              testId="module-operation-success"
              title="模块操作成功"
              onDismiss={() => setSuccess(false)}
            />
          )}
          {query.isPending ? (
            <CalmSkeleton variant="list" rows={4} label="正在加载模块" />
          ) : query.isError ? (
            <Alert
              type="error"
              title={moduleErrorMessage(query.error)}
              action={
                <Button
                  className="secondary-button"
                  onClick={() => void query.refetch()}
                >
                  重试
                </Button>
              }
            />
          ) : !query.data?.items.length ? (
            // 空项目的搭建引导已经在指标条下方给出「新增模块」直达入口，
            // 引导在场时不再叠加同义的模块空态。
            showSetupGuide ? null : (
              <CalmEmptyState
                icon="boxes"
                title="暂无模块"
                description="创建一个业务模块，也可以在新建任务时同时创建模块。"
              >
                <Button
                  className="soft-blue-button"
                  onClick={() => open("create")}
                >
                  <InpulseIcon name="plus" size={15} />
                  新增模块
                </Button>
              </CalmEmptyState>
            )
          ) : (
            <>
              <CalmSectionTitle
                title="模块"
                hint={`${(query.data?.items ?? []).length} 个模块`}
              >
                {/* 模块区块标题行是页面唯一的常驻新增入口：设计稿在页头动作区
                    还有一个同名按钮，按产品要求删掉重复入口。 */}
                <div className="calm-section-actions">
                  <Button
                    className="secondary-button"
                    data-testid="import-project-document-button"
                    onClick={() => setImportOpen(true)}
                  >
                    <InpulseIcon name="fileText" size={15} />
                    从文档导入
                  </Button>
                  <Button
                    className="soft-blue-button"
                    onClick={() => open("create")}
                  >
                    <InpulseIcon name="plus" size={15} />
                    新增模块
                  </Button>
                </div>
              </CalmSectionTitle>
              <div className="calm-feature-grid">
                {query.data.items.map((item) => (
                  <article className="catalog-module-wrap" key={item.id}>
                    <div
                      className="calm-feature-card module-card"
                      onPointerEnter={() => prefetchModule(item.id)}
                      onPointerDown={() => prefetchModule(item.id)}
                      onFocus={() => prefetchModule(item.id)}
                      onClick={(event) => {
                        if (!isCardClick(event)) return;
                        onOpenModule(item.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        if (event.target !== event.currentTarget) return;
                        event.preventDefault();
                        onOpenModule(item.id);
                      }}
                      tabIndex={0}
                    >
                      <div className="calm-card-top">
                        <span className="feature-symbol">
                          <InpulseIcon name="boxes" size={21} />
                        </span>
                        <span className="task-id">{item.code}</span>
                      </div>
                      <h2>{item.name}</h2>
                      <div className="task-card-badges">
                        {item.kind === "UNCLASSIFIED" && (
                          <CalmBadge tone="violet">未分类</CalmBadge>
                        )}
                        <CalmBadge
                          tone={moduleLifecycleTone(
                            item.stats.completedTaskCount,
                            "blue",
                          )}
                        >
                          {moduleLifecycleLabel(item.stats.completedTaskCount)}
                        </CalmBadge>
                      </div>
                      <p>{item.description}</p>
                      <div className="card-footer">
                        <span>
                          {item.stats.openTaskCount} 项待办 ·{" "}
                          {item.stats.completedTaskCount} 项已完成
                        </span>
                        {/* 整卡点击已经进入模块任务页，卡内只留「编辑模块」一个动作。
                            ADR-044：模块已无归档/恢复动作。 */}
                        <Button
                          className="text-button"
                          onClick={() => open("update", item)}
                        >
                          编辑模块
                        </Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </ProjectOverviewPageView>
      </div>
      <RecordDetailModal
        projectId={projectId}
        api={api}
        record={
          recordTarget === null
            ? null
            : ({
                recordId: recordTarget.recordId,
                code: recordTarget.code,
                title: recordTarget.title,
                recordStatus: "PUBLISHED",
                publishedAt: recordTarget.publishedAt,
                contextLabel: null,
                externalLinks: [],
              } satisfies RecordDetailTarget)
        }
        onClose={() => setRecordTarget(null)}
        onChanged={() => {
          // 修订/作废后同步概览统计与最近迭代列表。
          void queryClient.invalidateQueries({
            queryKey: ["project-overview", projectId],
          });
        }}
      />
      <ProjectWorkspaceModals
        projectId={projectId}
        client={client}
        open={workspaceModal}
        onClose={() => setWorkspaceModal(null)}
      />
      <ModuleEditorModal
        projectId={projectId}
        client={client}
        projectName={projectName}
        request={request}
        onClose={() => setRequest(null)}
        onSaved={() => {
          setProjectNotice(null);
          setSuccess(true);
        }}
      />
      <DocumentImportModal
        open={importOpen}
        mode="PROJECT"
        projectId={projectId}
        projectName={projectName ?? undefined}
        client={client}
        onClose={() => setImportOpen(false)}
        onImported={(result: ProjectDocumentImportResult) => {
          setImportOpen(false);
          setSuccess(false);
          setProjectNotice(
            "文档导入完成：新建 " +
              result.counts.modules +
              " 个模块、" +
              result.counts.tasks +
              " 个任务，复用 " +
              result.counts.reusedModules +
              " 个模块。",
          );
          void query.refetch();
        }}
      />
      {projectEditOpen && projectQuery.data?.project ? (
        <EditProjectModal
          open
          project={projectQuery.data.project}
          client={client}
          canChangeStatus={canManageProject}
          canDeleteProject={canDeleteCurrentProject}
          onClose={() => setProjectEditOpen(false)}
          onUpdated={(updated) => {
            const previousStatus = projectQuery.data?.project.status;
            const statusNote =
              previousStatus !== undefined && previousStatus !== updated.status
                ? `，状态已改为${projectLifecycleLabel(updated.status)}`
                : "";
            applyProjectUpdate(updated);
            setProjectEditOpen(false);
            setSuccess(false);
            setProjectNotice(
              `项目「${updated.name}」已更新${statusNote}，当前版本 v${updated.rowVersion}。`,
            );
          }}
          onDeleted={() => {
            // 项目已从读取路径消失，详情查询会变 404，先回到项目列表。
            setProjectEditOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            navigate("/projects");
          }}
        />
      ) : null}
    </>
  );
}
