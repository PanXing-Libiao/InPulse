import React, { useMemo } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useParams,
  type RouteObject,
} from "react-router-dom";
import type { AppRouteModule } from "@shared/routing/route-descriptor";
import { buildRouteObjects } from "@shared/routing/route-registry";
import { AppLayout } from "../layout/AppLayout";
import { RequireAuth, RequireAdmin } from "../auth/auth-guard";
import { RouteErrorPage } from "../errors/RouteErrorPage";
import { ProjectTierProvider } from "@features/common/project-tier-context";

/** 项目概览已与「模块与功能」合并：旧地址不再单独渲染页面，整体重定向到项目主页。 */
const ProjectOverviewRedirect: React.FC = () => {
  const { projectId } = useParams();
  return <Navigate to={`/projects/${projectId ?? ""}/modules`} replace />;
};

/**
 * 项目子页的别名重定向。手输 / 收藏里的旧地址此前直接落到 404（2026-10-16 实测
 * /projects/13/settings 与 /projects/13/tasks 都 404，实际分段是 members 与
 * task-board），这里按分段给一层显式别名，和上面的 overview 同一套做法。
 */
const ProjectSegmentRedirect: React.FC<{ readonly segment: string }> = ({
  segment,
}) => {
  const { projectId } = useParams();
  return <Navigate to={`/projects/${projectId ?? ""}/${segment}`} replace />;
};

export function loadPageRoutes(): AppRouteModule[] {
  // 静态自动聚合 pages 目录下所有领域 route.ts 导出
  const modules = import.meta.glob<{
    default?: AppRouteModule;
    route?: AppRouteModule;
  }>("../../pages/**/route.ts", { eager: true });

  const routeList: AppRouteModule[] = [];
  for (const path in modules) {
    const exported = modules[path];
    if (!exported) {
      continue;
    }
    const mod = exported.default ?? exported.route;
    if (mod) {
      routeList.push(mod);
    }
  }

  return routeList;
}

export function createInPulseRouter(
  pageRoutes: readonly AppRouteModule[] = loadPageRoutes(),
): ReturnType<typeof createBrowserRouter> {
  const childRoutes = buildRouteObjects(pageRoutes, {
    authWrapper: (element, requiresAdmin) => {
      if (requiresAdmin) {
        return <RequireAdmin>{element}</RequireAdmin>;
      }
      return <RequireAuth>{element}</RequireAuth>;
    },
  });

  const rootRoute: RouteObject = {
    path: "/",
    // 项目列表的「未完成 / 维护中」分档由 Provider 持有：侧栏项目树与列表页共用一份状态。
    element: (
      <ProjectTierProvider>
        <AppLayout />
      </ProjectTierProvider>
    ),
    // 兜底错误页：路由级异常与默认 404 都不再落到 React Router 的开发者页面。
    errorElement: <RouteErrorPage />,
    children: [
      // 「/」不再有独立首页：首页与任务中心内容重复，根路径直接落到任务中心。
      { index: true, element: <Navigate to="/tasks" replace /> },
      {
        path: "projects/:projectId/overview",
        element: <ProjectOverviewRedirect />,
      },
      {
        path: "projects/:projectId/tasks",
        element: <ProjectSegmentRedirect segment="task-board" />,
      },
      {
        path: "projects/:projectId/settings",
        element: <ProjectSegmentRedirect segment="members" />,
      },
      ...childRoutes,
    ],
  };

  return createBrowserRouter([rootRoute]);
}

export const AppRouter: React.FC = () => {
  const router = useMemo(() => createInPulseRouter(), []);
  return <RouterProvider router={router} />;
};
