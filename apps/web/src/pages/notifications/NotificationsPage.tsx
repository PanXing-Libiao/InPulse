import React, { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";
import type { NotificationFilter } from "@features/notifications/notification-query";
import { NotificationsPageView } from "@features/notifications/NotificationsPageView";
import { readNotificationTaskOpenState } from "@features/notifications/notification-task-state";
import { preloadRoutePath } from "@shared/routing/route-preload";
import { loadTaskDetailOverlay } from "@features/project-overview/project-workspace-chunks";
import {
  parseTaskDetailPath,
  type TaskLocation,
} from "@features/tasks/task-links";
import { useAuth } from "@features/auth/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchRecordPath } from "@features/records/records-route-prefetch";

/**
 * 任务类通知在当前通知页就地打开与功能档案一致的任务详情弹窗；
 * 关闭弹窗只清空本地状态，地址栏仍停留在 /notifications。
 */
const TaskDetailOverlay = lazy(loadTaskDetailOverlay);

export interface NotificationsPageProps {
  readonly client?: InpulseApiClient;
}

export const NotificationsPage: React.FC<NotificationsPageProps> = ({
  client,
}) => {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { user } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [detailTarget, setDetailTarget] = useState<TaskLocation | null>(null);
  const filter = searchParams.get("filter") === "unread" ? "unread" : "all";

  // 顶部铃铛点击任务通知时先导航到本页并把目标深链放进路由状态；
  // 消费一次后立即清掉状态，避免关闭弹窗或刷新后再次自动打开。
  useEffect(() => {
    const target = readNotificationTaskOpenState(location.state);
    if (target === null) {
      return;
    }
    setDetailTarget(target);
    navigate(location.pathname + location.search, {
      replace: true,
      state: null,
    });
  }, [location.pathname, location.search, location.state, navigate]);

  const handleFilterChange = useCallback(
    (nextFilter: NotificationFilter) => {
      setSearchParams(nextFilter === "unread" ? { filter: "unread" } : {});
    },
    [setSearchParams],
  );

  const prepareTarget = useCallback(
    (targetPath: string): Promise<void> => {
      const records = prefetchRecordPath(cache, targetPath, client);
      return Promise.all([
        preloadRoutePath(targetPath),
        records ?? Promise.resolve(),
      ]).then(() => undefined);
    },
    [cache, client],
  );

  const handlePrefetchTarget = useCallback(
    (targetPath: string) => {
      void prepareTarget(targetPath);
    },
    [prepareTarget],
  );

  const handleOpenTarget = useCallback(
    (targetPath: string) => {
      const task = parseTaskDetailPath(targetPath);
      if (task !== null) {
        setDetailTarget(task);
        return;
      }
      // 非任务通知等页面 chunk 与目标数据都就绪后再切页，避免列表先闪骨架。
      void prepareTarget(targetPath).finally(() => navigate(targetPath));
    },
    [navigate, prepareTarget],
  );

  return (
    <>
      <NotificationsPageView
        userId={user?.id ?? null}
        filter={filter}
        onFilterChange={handleFilterChange}
        onOpenTarget={handleOpenTarget}
        onPrefetchTarget={handlePrefetchTarget}
        {...(client ? { client } : {})}
      />
      <Suspense fallback={null}>
        {detailTarget === null ? null : (
          <TaskDetailOverlay
            target={detailTarget}
            onClose={() => setDetailTarget(null)}
            onOpenTask={setDetailTarget}
            {...(client ? { client } : {})}
          />
        )}
      </Suspense>
    </>
  );
};

export default NotificationsPage;
