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

  const handleOpenTarget = useCallback(
    (targetPath: string) => {
      const task = parseTaskDetailPath(targetPath);
      if (task !== null) {
        setDetailTarget(task);
        return;
      }
      // 非任务通知同样先等页面 chunk 就绪，避免通知列表先闪一帧再进骨架。
      void preloadRoutePath(targetPath).finally(() => navigate(targetPath));
    },
    [navigate],
  );

  return (
    <>
      <NotificationsPageView
        userId={user?.id ?? null}
        filter={filter}
        onFilterChange={handleFilterChange}
        onOpenTarget={handleOpenTarget}
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
