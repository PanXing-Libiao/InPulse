import type { QueryClient } from "@tanstack/react-query";
import { createApiClient, type InpulseApiClient } from "@generated/api";
import { AI_ASSIST_SETTINGS_QUERY_KEY } from "@features/settings/ai-assist-query";
import { WECOM_ROBOT_QUERY_KEY } from "@features/settings/wecom-robot-query";

/**
 * 侧栏进入「成员与设置」前预取默认页签与标签页数据。
 * 管理员默认落在成员与角色；项目成员页签只依赖项目目录；AI 与企业微信
 * 页签各自只有一块配置读取，提前取好后点页签不再先闪骨架。
 */
export function prefetchSettingsRoute(
  cache: QueryClient,
  options: {
    readonly isAdmin: boolean;
    readonly client?: InpulseApiClient | undefined;
  },
): Promise<void> {
  const { isAdmin, client } = options;
  const api = client ?? createApiClient();
  const jobs: Promise<unknown>[] = [
    cache.prefetchQuery({
      queryKey: ["projects"],
      queryFn: ({ signal }) => api.listProjects({ signal }),
    }),
  ];
  if (!isAdmin) {
    jobs.push(
      cache.prefetchQuery({
        queryKey: ["my-organization-members"],
        queryFn: ({ signal }) => api.getMyOrganizationMembers({ signal }),
      }),
    );
    return Promise.all(jobs).then(() => undefined);
  }
  jobs.push(
    cache.prefetchQuery({
      queryKey: ["admin-users"],
      queryFn: ({ signal }) => api.listAdminUsers({ signal }),
    }),
    cache.prefetchQuery({
      queryKey: ["organizations"],
      queryFn: ({ signal }) => api.listOrganizations({ signal }),
    }),
    cache.prefetchQuery({
      queryKey: AI_ASSIST_SETTINGS_QUERY_KEY,
      queryFn: ({ signal }) => api.getAiAssistSettings({ signal }),
    }),
    cache.prefetchQuery({
      queryKey: WECOM_ROBOT_QUERY_KEY,
      queryFn: ({ signal }) => api.getWecomRobotConfig({ signal }),
    }),
  );
  return Promise.all(jobs).then(() => undefined);
}
