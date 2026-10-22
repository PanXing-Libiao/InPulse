import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { useNavigate } from "react-router-dom";
import {
  createApiClient,
  type InpulseApiClient,
  type ProjectListItem,
  type ProjectStatus,
  type TaskBoardResponse,
} from "@generated/api";
import { formatBeijingDate } from "@features/common/beijing-time";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSegmented,
} from "@features/common/components/Calm";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { ProjectLogo } from "@features/common/components/ProjectLogo";
import {
  projectLifecycleLabel,
  projectLifecycleTone,
} from "@features/common/resource-lifecycle";
import { createTaskBoardServerAdapter } from "@features/task-board/task-board-server";
import type { TaskBoardAdapter } from "@features/task-board/task-board-types";
import { useTaskBoardQuery } from "@features/task-board/task-board-query";
import { useProjectWecomGroup } from "./project-wecom-group-query";
import { orderMembersLeaderFirst } from "./project-member-order";
import { projectMemberErrorMessage } from "./project-member-query";
import { describeProjectListError, useProjects } from "./project-query";

type ProjectStatusFilter = "all" | ProjectStatus;

export interface ProjectMemberOverviewPanelProps {
  readonly client?: InpulseApiClient | undefined;
}

function openTaskCountFor(
  taskBoard: TaskBoardResponse | undefined,
  memberId: number,
): number {
  if (taskBoard === undefined) return 0;
  return taskBoard.modules.reduce(
    (total, module) =>
      total +
      module.tasks.filter(
        (task) =>
          task.workStatus === "TODO" &&
          task.assignees.some((assignee) => assignee.userId === memberId),
      ).length,
    0,
  );
}

function ProjectMemberSummary({
  project,
  expanded,
  onToggle,
  adapter,
  client,
}: {
  readonly project: ProjectListItem;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly adapter: TaskBoardAdapter;
  readonly client?: InpulseApiClient | undefined;
}) {
  const navigate = useNavigate();
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const members = useQuery({
    queryKey: ["active-project-members", project.id],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(project.id, { signal }),
    enabled: expanded,
    retry: false,
  });
  const taskBoard = useTaskBoardQuery({
    projectId: project.id,
    adapter,
    enabled: expanded,
  });
  const wecom = useProjectWecomGroup(project.id, client, {
    enabled: expanded,
  });

  const orderedMembers = orderMembersLeaderFirst(members.data?.items ?? []);
  const leader = orderedMembers.find((member) => member.role === "LEADER");
  const panelId = "project-member-panel-" + project.id;

  const leaderLabel = members.isPending
    ? "读取中"
    : members.isError
      ? "暂不可用"
      : (leader?.name ?? "未设置");

  const groupLabel = wecom.query.isPending
    ? "读取中"
    : wecom.query.isError
      ? "暂不可用"
      : wecom.query.data?.state === "BOUND"
        ? "已绑定"
        : wecom.query.data?.state === "PENDING"
          ? "待绑定"
          : "未绑定";

  const toggle = (): void => {
    onToggle();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };

  const openMemberSettings = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    event.stopPropagation();
    navigate("/projects/" + project.id + "/members");
  };

  return (
    <article
      className={"project-member-accordion" + (expanded ? " is-expanded" : "")}
    >
      <div
        className="project-member-summary"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={(expanded ? "收起 " : "展开 ") + project.name + " 成员"}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <ProjectLogo code={project.code} className="project-member-logo" />
        <span className="project-member-summary-copy">
          <strong className="project-member-summary-name">
            {project.name}
          </strong>
          <span className="project-member-summary-meta">
            <span>{project.code}</span>
            <span aria-hidden="true">·</span>
            <span>{project.memberCount} 名成员</span>
          </span>
        </span>
        <span className="project-member-summary-actions">
          <CalmBadge tone={projectLifecycleTone(project.status, "blue")}>
            {projectLifecycleLabel(project.status)}
          </CalmBadge>
          <button
            type="button"
            className="project-member-manage"
            aria-label={"管理成员：" + project.name}
            onClick={openMemberSettings}
            onKeyDown={(event) => event.stopPropagation()}
          >
            管理成员
          </button>
          <InpulseIcon
            name="chevron"
            size={15}
            className={
              "project-member-chevron" + (expanded ? " is-expanded" : "")
            }
          />
        </span>
      </div>

      {expanded ? (
        <div
          className="project-member-expanded"
          id={panelId}
          role="region"
          aria-label={project.name + " 项目成员"}
        >
          <div className="project-member-insights">
            <div className="project-member-insight">
              <span>项目组长</span>
              <strong>{leaderLabel}</strong>
            </div>
            <div className="project-member-insight">
              <span>成员数</span>
              <strong>{project.memberCount} 人</strong>
            </div>
            <div className="project-member-insight">
              <span>未完成任务</span>
              <strong>{project.stats.openTaskCount} 项</strong>
            </div>
            <div className="project-member-insight">
              <span>群通知</span>
              <strong>{groupLabel}</strong>
            </div>
          </div>

          {members.isPending ? (
            <CalmSkeleton
              variant="list"
              rows={Math.max(2, Math.min(project.memberCount, 4))}
              compact
              label="正在加载项目成员"
            />
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
          ) : orderedMembers.length === 0 ? (
            <CalmEmptyState icon="users" title="暂无项目成员" />
          ) : (
            <div className="project-member-member-list">
              {orderedMembers.map((member) => {
                const taskLabel = taskBoard.isPending
                  ? "读取中"
                  : taskBoard.isError || taskBoard.data === undefined
                    ? "暂不可用"
                    : openTaskCountFor(taskBoard.data, member.id) + " 项未完成";
                return (
                  <div
                    key={member.id}
                    className={
                      "project-member-member" +
                      (member.role === "LEADER" ? " is-leader" : "")
                    }
                  >
                    <div className="project-member-person">
                      <span className="person-avatar project-member-avatar">
                        {member.name.slice(0, 1)}
                      </span>
                      <span className="project-member-person-copy">
                        <strong>{member.name}</strong>
                        <small>
                          加入于 {formatBeijingDate(member.joinedAt)}
                        </small>
                      </span>
                    </div>
                    <span className="project-member-role">
                      <CalmBadge
                        tone={member.role === "LEADER" ? "amber" : "gray"}
                      >
                        {member.role === "LEADER" ? "组长" : "成员"}
                      </CalmBadge>
                    </span>
                    <span className="project-member-task">{taskLabel}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

/**
 * 设置页「项目成员」总览（2026-10-21）：单列手风琴，点击项目行原地展开成员，
 * 不离开设置页；展开区只读，添加、移除与组长调整统一进入项目成员设置。
 */
export function ProjectMemberOverviewPanel({
  client,
}: ProjectMemberOverviewPanelProps) {
  const projects = useProjects({ client });
  const [projectQuery, setProjectQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("all");
  const [openProjectId, setOpenProjectId] = useState<number | null>(null);
  const adapter = useMemo(() => createTaskBoardServerAdapter(client), [client]);

  const projectItems = projects.data?.items ?? [];

  const filteredProjects = useMemo(() => {
    const keyword = projectQuery.trim().toLocaleLowerCase();
    return projectItems.filter((project) => {
      const matchesKeyword =
        keyword === "" ||
        project.name.toLocaleLowerCase().includes(keyword) ||
        project.code.toLocaleLowerCase().includes(keyword);
      const matchesStatus =
        statusFilter === "all" || project.status === statusFilter;
      return matchesKeyword && matchesStatus;
    });
  }, [projectItems, projectQuery, statusFilter]);

  const totalMembers = useMemo(
    () =>
      projectItems.reduce((total, project) => total + project.memberCount, 0),
    [projectItems],
  );
  return (
    <section
      className="panel settings-panel project-member-overview"
      aria-label="项目成员"
    >
      <div className="project-member-overview-head">
        <h2>项目成员</h2>
        <span className="project-member-overview-count">
          {projectItems.length} 个项目 · {totalMembers} 位成员
        </span>
      </div>

      {projects.isPending ? (
        <div className="project-member-state">
          <CalmSkeleton variant="list" rows={4} label="正在加载项目成员总览" />
        </div>
      ) : projects.isError ? (
        <div className="project-member-state">
          <CalmEmptyState
            icon="alert"
            title="项目列表加载失败"
            description={describeProjectListError(projects.error)}
          >
            <Button
              className="secondary-button"
              onClick={() => void projects.refetch()}
            >
              重试
            </Button>
          </CalmEmptyState>
        </div>
      ) : projectItems.length === 0 ? (
        <div className="project-member-state">
          <CalmEmptyState
            icon="folder"
            title="暂无可访问的项目"
            description="加入项目后，这里会显示项目成员总览。"
          />
        </div>
      ) : (
        <>
          <div className="project-member-toolbar">
            <label className="project-member-search">
              <InpulseIcon name="search" size={15} />
              <input
                type="search"
                aria-label="搜索项目"
                placeholder="搜索项目名称或代码"
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
              />
            </label>
            <CalmSegmented
              label="项目状态筛选"
              value={statusFilter}
              options={[
                { value: "all", label: "全部" },
                { value: "ACTIVE", label: "进行中" },
                { value: "NOT_STARTED", label: "未开始" },
                { value: "MAINTENANCE", label: "维护中" },
              ]}
              onChange={setStatusFilter}
            />
            <span className="project-member-result-count">
              {filteredProjects.length} 个项目
            </span>
          </div>

          {filteredProjects.length === 0 ? (
            <div className="project-member-state">
              <CalmEmptyState
                icon="search"
                title="没有找到符合条件的项目"
                description="试试清空搜索条件或切换项目状态。"
              />
            </div>
          ) : (
            <div className="project-member-accordion-list">
              {filteredProjects.map((project) => (
                <ProjectMemberSummary
                  key={project.id}
                  project={project}
                  expanded={openProjectId === project.id}
                  onToggle={() =>
                    setOpenProjectId((current) =>
                      current === project.id ? null : project.id,
                    )
                  }
                  adapter={adapter}
                  client={client}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
