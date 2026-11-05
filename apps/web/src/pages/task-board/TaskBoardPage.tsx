import React, { useMemo } from "react";
import { Alert } from "antd";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";

import {
  readTaskBoardFilters,
  writeTaskBoardFilters,
} from "@features/task-board/task-board-filters";
import { TaskBoardPageView } from "@features/task-board/TaskBoardPageView";
import { createTaskBoardServerAdapter } from "@features/task-board/task-board-server";
import type {
  TaskBoardAdapter,
  TaskBoardFilters,
} from "@features/task-board/task-board-types";
import { navigatePrepared } from "@shared/routing/navigate-prepared";

/**
 * R-8 项目任务看板页面。筛选状态由 URL 承载（与任务中心同一约定），
 * 页面不保留内部副本；数据访问走注入的 server 适配器（生成客户端）。
 */
export interface TaskBoardPageProps {
  readonly client?: InpulseApiClient;
  readonly adapter?: TaskBoardAdapter;
}

interface TaskBoardContainerProps extends TaskBoardPageProps {
  readonly projectId: number;
}

const TaskBoardContainer: React.FC<TaskBoardContainerProps> = ({
  projectId,
  client,
  adapter,
}) => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readTaskBoardFilters(searchParams);
  const activeAdapter = useMemo(
    () => adapter ?? createTaskBoardServerAdapter(client),
    [adapter, client],
  );
  const handleFiltersChange = (next: TaskBoardFilters) => {
    setSearchParams(writeTaskBoardFilters(next), { replace: true });
  };
  return (
    <TaskBoardPageView
      projectId={projectId}
      filters={filters}
      onFiltersChange={handleFiltersChange}
      adapter={activeAdapter}
      client={client}
      onOpenModules={() =>
        void navigatePrepared(navigate, "/projects/" + projectId + "/modules")
      }
    />
  );
};

export default function TaskBoardPage({ client, adapter }: TaskBoardPageProps) {
  const { projectId } = useParams();
  const id = Number(projectId);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
    return <Alert type="error" title="项目地址无效" />;
  }
  return (
    <TaskBoardContainer
      projectId={id}
      {...(client === undefined ? {} : { client })}
      {...(adapter === undefined ? {} : { adapter })}
    />
  );
}
