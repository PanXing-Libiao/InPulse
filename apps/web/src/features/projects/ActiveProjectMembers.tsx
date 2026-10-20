import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import {
  createApiClient,
  type InpulseApiClient,
  type ProjectItem,
} from "@generated/api";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSectionTitle,
} from "@features/common/components/Calm";
import {
  projectLifecycleLabel,
  projectLifecycleTone,
} from "@features/common/resource-lifecycle";
import { projectMemberErrorMessage } from "./project-member-query";
import { orderMembersLeaderFirst } from "./project-member-order";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { formatBeijingMinute } from "@features/common/beijing-time";

const formatMemberDate = (value: string) => formatBeijingMinute(value);

/** 与管理视图 `ProjectMembersPageView` 一致的角色标签。 */
const roleLabel: Record<"MEMBER" | "LEADER", string> = {
  MEMBER: "成员",
  LEADER: "组长",
};

/**
 * 普通成员视角的项目成员只读视图：复用管理员 `ProjectMembersPageView` 的
 * 视觉语言（page-header / settings-panel / project-facts / calm-member-card），
 * 但去掉全部写操作（添加、移除、任务重指派、归档、项目切换）。
 * 数据来自 `listActiveProjectMembers`（只返回活跃成员的
 * id/name/avatarUrl/role/joinedAt），因此成员卡片不含已移除历史，
 * 只标注「活跃成员」与项目内角色（ADR-033）。
 *
 * 项目详情由调用方传入：成员页与项目主页弹窗都已持有同一份
 * `GET /projects/:id` 查询结果，本组件不再重复挂载同 key 的 observer，
 * 否则项目不可访问（404）时 refetchOnMount 会与页面的错误分支反复切换，
 * 形成「挂载、重取、回退」的请求与渲染循环。
 */
export function ActiveProjectMembers({
  projectId,
  projectDetail,
  client,
}: {
  projectId: number;
  projectDetail: ProjectItem | null;
  client?: InpulseApiClient | undefined;
}) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const members = useQuery({
    queryKey: ["active-project-members", projectId],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(projectId, { signal }),
    retry: false,
  });
  const items = orderMembersLeaderFirst(members.data?.items ?? []);
  const creatorName =
    projectDetail === null
      ? undefined
      : items.find((member) => member.id === projectDetail.createdBy)?.name;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{projectDetail ? projectDetail.name : "项目成员"}</h1>
          <p>
            当前项目的活跃成员为只读视图；成员的添加与移除由本项目任意活跃成员
            在管理页处理。
          </p>
        </div>
        {projectDetail ? (
          <div className="catalog-actions">
            <CalmBadge
              tone={projectLifecycleTone(projectDetail.status, "blue")}
            >
              {projectLifecycleLabel(projectDetail.status)}
            </CalmBadge>
          </div>
        ) : null}
      </div>

      {members.isPending ? (
        <CalmSkeleton variant="list" rows={3} label="正在加载项目成员" />
      ) : members.isError ? (
        <CalmEmptyState
          icon="alert"
          title="项目成员加载失败"
          description={projectMemberErrorMessage(members.error)}
        >
          <Button
            className="secondary-button"
            onClick={() => void members.refetch()}
          >
            重试
          </Button>
        </CalmEmptyState>
      ) : items.length === 0 ? (
        <CalmEmptyState
          icon="users"
          title="暂无项目成员"
          description="项目还没有活跃成员；成员由本项目任意活跃成员在管理页添加。"
        />
      ) : (
        <section className="panel settings-panel project-members-panel">
          <div className="settings-panel-head">
            <CalmSectionTitle
              title="项目成员"
              hint={`共 ${items.length} 名活跃成员 · 只读视图`}
            />
          </div>
          {projectDetail ? (
            <dl className="calm-meta project-facts">
              <dt>项目编码</dt>
              <dd>
                <code>{projectDetail.code}</code>
              </dd>
              <dt>状态</dt>
              <dd>{projectLifecycleLabel(projectDetail.status)}</dd>
              <dt>创建人</dt>
              <dd>{creatorName ?? "—"}</dd>
              <dt>创建时间</dt>
              <dd>{formatMemberDate(projectDetail.createdAt)}</dd>
            </dl>
          ) : null}

          <div className="member-editor">
            <div className="member-selection-top">
              <strong>成员列表</strong>
              <div className="member-selection-actions">
                <Button
                  className="text-button"
                  onClick={() => void members.refetch()}
                >
                  刷新成员
                </Button>
              </div>
            </div>
            <div className="member-history-list">
              {items.map((member) => (
                <article key={member.id} className="calm-member-card">
                  <div className="calm-member-card-main">
                    <span className="person-avatar member-avatar">
                      {member.name.slice(0, 1)}
                    </span>
                    <div className="member-identity">
                      <strong>
                        {member.name}
                        {projectDetail && member.id === projectDetail.createdBy
                          ? "（创建者）"
                          : ""}
                      </strong>
                      <span>加入时间：{formatMemberDate(member.joinedAt)}</span>
                    </div>
                  </div>
                  <div className="member-status">
                    <CalmBadge tone="green">活跃成员</CalmBadge>
                    {member.role !== "MEMBER" ? (
                      <CalmBadge tone="blue">
                        {roleLabel[member.role]}
                      </CalmBadge>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
