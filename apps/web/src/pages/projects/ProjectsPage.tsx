import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  CreateProjectResponse,
  InpulseApiClient,
  ProjectDocumentImportResult,
} from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import {
  describeProjectListError,
  useProjects,
} from "@features/projects/project-query";
import { ProjectsPageView } from "@features/projects/ProjectsPageView";

export interface ProjectsPageProps {
  readonly client?: InpulseApiClient;
}

export const ProjectsPage: React.FC<ProjectsPageProps> = ({ client }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [createdProject, setCreatedProject] =
    useState<CreateProjectResponse | null>(null);
  const projectList = useProjects({ client });

  const handleCreated = useCallback((response: CreateProjectResponse) => {
    setCreatedProject(response);
  }, []);

  /** 整项目导入成功后直接进入新项目模块页，导入的模块/功能/任务立即可见。 */
  const handleImportedProject = useCallback(
    (result: ProjectDocumentImportResult) => {
      navigate("/projects/" + result.projectId + "/modules");
    },
    [navigate],
  );

  /** 重新打开「新建项目」时先撤掉上一次的成功提示，避免旧项目名残留在页面上。 */
  const handleStartCreate = useCallback(() => {
    setCreatedProject(null);
  }, []);

  const handleDismissCreatedProject = useCallback(() => {
    setCreatedProject(null);
  }, []);

  const handleOpenActivity = useCallback(
    (projectId: number) => {
      navigate(`/projects/${projectId}/activity`);
    },
    [navigate],
  );

  /**
   * 「添加模块」：创建成功横幅的下一步。带一次性信号进入项目工作区，
   * 模块页落地后自动打开新增模块弹窗（搭建引导同时展示三步清单）。
   */
  const handleAddModule = useCallback(
    (projectId: number) => {
      navigate("/projects/" + projectId + "/modules", {
        state: { createModule: true },
      });
    },
    [navigate],
  );

  const handleSearch = useCallback(
    (query: string) => {
      navigate(`/search?q=${encodeURIComponent(query)}`);
    },
    [navigate],
  );

  return (
    <ProjectsPageView
      creatorName={user?.name.trim() || "创建者"}
      creatorUserId={user?.id}
      isAdmin={user?.isAdmin === true}
      createdProject={createdProject}
      onCreated={handleCreated}
      onImportedProject={handleImportedProject}
      onStartCreate={handleStartCreate}
      onDismissCreatedProject={handleDismissCreatedProject}
      onOpenActivity={handleOpenActivity}
      onAddModule={handleAddModule}
      onOpenModules={(projectId) => navigate(`/projects/${projectId}/modules`)}
      onOpenMembers={(projectId) => navigate(`/projects/${projectId}/members`)}
      onSearch={handleSearch}
      projects={projectList.data?.items ?? []}
      projectsLoading={projectList.isPending}
      projectsError={
        projectList.isError
          ? describeProjectListError(projectList.error)
          : undefined
      }
      onRetryProjects={() => void projectList.refetch()}
      {...(client ? { client } : {})}
    />
  );
};

export default ProjectsPage;
