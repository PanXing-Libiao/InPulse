import React, { Suspense, lazy, useState } from "react";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { SearchParamsScope } from "@features/common/search-params-scope";
import { useAuth } from "@features/auth/auth-context";
import {
  canManageProjectResources,
  useProjectDetail,
} from "@features/projects/project-query";
import type { InpulseApiClient } from "@generated/api";
import type { TaskLocation } from "@features/tasks/task-links";
import {
  loadActiveProjectMembers,
  loadIssuesPageView,
  loadProjectMembersPageView,
  loadProjectWecomGroupCard,
  loadRecordsWorkspace,
  loadTaskDetailOverlay,
  type ProjectWorkspaceModalKind,
} from "./project-workspace-chunks";

/**
 * 项目主页的四个就地弹窗：成员与设置、企业微信项目群、迭代记录、遗留问题。
 * 项目主页不再整页跳转到 `/members`、`/records`、`/issues`，
 * 四个工作区视图按需加载后装进 AppModal，页面上下文（模块列表、筛选状态）不丢。
 *
 * 成员与记录等视图自带 `useSearchParams` 状态（项目筛选、草稿详情、记录展开等），
 * 弹窗内用 `MemoryRouter` 给它们一份独立的初始地址，交互不污染浏览器地址栏；
 * 关闭弹窗即丢弃这份局部地址，重新打开回到该项目的默认视图。
 */
// 成员/记录视图只有命名导出：lazy 需要 default，装载函数见 project-workspace-chunks。
const ProjectMembersPageView = lazy(loadProjectMembersPageView);
const ActiveProjectMembers = lazy(loadActiveProjectMembers);
const ProjectWecomGroupCard = lazy(loadProjectWecomGroupCard);
const RecordsWorkspace = lazy(loadRecordsWorkspace);
const IssuesPageView = lazy(loadIssuesPageView);
const TaskDetailOverlay = lazy(loadTaskDetailOverlay);

export type { ProjectWorkspaceModalKind };

export interface ProjectWorkspaceModalsProps {
  readonly projectId: number;
  readonly client?: InpulseApiClient | undefined;
  /** 当前打开的弹窗；null 表示全部关闭。 */
  readonly open: ProjectWorkspaceModalKind | null;
  readonly onClose: () => void;
}

const MODAL_META: Record<
  ProjectWorkspaceModalKind,
  {
    readonly label: string;
    /** 弹窗内视图的初始搜索参数（作用域本地状态，不进地址栏）。 */
    readonly initialSearch: (projectId: number) => string;
  }
> = {
  members: {
    label: "成员与设置",
    initialSearch: () => "",
  },
  wecom: {
    label: "企业微信项目群",
    initialSearch: () => "",
  },
  records: {
    label: "迭代记录",
    initialSearch: (projectId) => "view=published&projectId=" + projectId,
  },
  issues: {
    label: "遗留问题",
    initialSearch: (projectId) => "projectId=" + projectId,
  },
};

export const ProjectWorkspaceModals: React.FC<ProjectWorkspaceModalsProps> = ({
  projectId,
  client,
  open,
  onClose,
}) => {
  const { user } = useAuth();
  const detail = useProjectDetail({ projectId, client });
  const isSystemAdmin = user?.isAdmin === true;
  const canManage =
    isSystemAdmin ||
    canManageProjectResources(false, detail.data?.currentUserRole ?? null);
  const canManageWecom =
    isSystemAdmin || detail.data?.currentUserRole === "LEADER";
  /** 遗留问题弹窗里点来源/跟进任务：再叠一层任务详情弹窗。 */
  const [taskTarget, setTaskTarget] = useState<TaskLocation | null>(null);

  if (open === null) return null;
  const meta = MODAL_META[open];
  const projectName = detail.data?.project?.name ?? null;
  return (
    <>
      {/* Suspense 提到弹层外面（2026-10-12）：内容 chunk 没到位时整个弹层都不渲染。
          以前边界在弹层内部、fallback 为 null，弹层会先以「只有标题、正文空白」的空壳
          出现（本机实测 129px、约 330ms）再跳成内容——用户看到的是「闪出一个没有记录的
          迭代记录弹窗」。代价是首次打开会晚一点点出现，因此入口按钮做了 chunk 预热
          （见 project-workspace-chunks 的 projectWorkspacePreloadHandlers）。 */}
      <Suspense fallback={null}>
        <Modal
          open
          size="xl"
          label={meta.label}
          eyebrow={projectName === null ? "项目" : projectName}
          title={meta.label}
          closeLabel={"关闭" + meta.label}
          onCancel={onClose}
          className="project-workspace-modal"
        >
          <div className="project-workspace-modal-body">
            <SearchParamsScope initial={meta.initialSearch(projectId)}>
              {open === "members" ? (
                canManage ? (
                  <ProjectMembersPageView
                    projectId={projectId}
                    {...(client ? { client } : {})}
                    isSystemAdmin={isSystemAdmin}
                    viewerRole={detail.data?.currentUserRole ?? null}
                    embedded
                  />
                ) : (
                  <ActiveProjectMembers
                    projectId={projectId}
                    projectDetail={detail.data?.project ?? null}
                    {...(client ? { client } : {})}
                  />
                )
              ) : open === "wecom" ? (
                <ProjectWecomGroupCard
                  projectId={projectId}
                  projectName={projectName}
                  heading="群 Webhook 与通知设置"
                  canManage={canManageWecom}
                  client={client}
                />
              ) : open === "records" ? (
                <RecordsWorkspace {...(client ? { client } : {})} embedded />
              ) : (
                <IssuesPageView
                  {...(client ? { client } : {})}
                  onOpenTask={setTaskTarget}
                  embedded
                />
              )}
            </SearchParamsScope>
          </div>
        </Modal>
      </Suspense>
      <Suspense fallback={null}>
        {taskTarget === null ? null : (
          <TaskDetailOverlay
            target={taskTarget}
            {...(client ? { client } : {})}
            onClose={() => setTaskTarget(null)}
            onOpenTask={setTaskTarget}
          />
        )}
      </Suspense>
    </>
  );
};
