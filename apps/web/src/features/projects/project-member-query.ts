import { useMemo, useRef } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type ProjectMemberReassignmentItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export function projectMemberErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) {
      // ADR-053：角色任命只剩「系统管理员或本项目组长转移组长身份」。
      if (error.code === "PROJECT_MEMBER_ROLE_FORBIDDEN")
        return "只有系统管理员或本项目组长可以设定组长，且组长只能把身份转交给其他成员。";
      return "安全校验未通过，请刷新页面后重试。";
    }
    if (error.status === 404) return "项目或成员不存在，或你已无权访问。";
    if (error.status === 409) {
      if (error.code === "PROJECT_MEMBER_ALREADY_ACTIVE")
        return "该用户已经是项目活跃成员。";
      if (error.code === "PROJECT_MEMBER_TASK_NOT_REASSIGNABLE")
        return "待改派任务已发生变化，请重新加载后重试。";
      if (error.code === "PROJECT_MEMBER_LEADER_PROTECTED")
        return "项目组长不能被直接移除，请先把其他成员设为组长（转移）。";
      if (error.code === "PROJECT_MEMBER_LEADER_REQUIRED")
        return "项目必须保留一名组长，请先把其他成员设为组长（转移）。";
      if (error.code === "PROJECT_MEMBER_LEADER_CONFLICT")
        return "该项目已存在组长，请刷新成员列表后重试。";
      return "项目成员状态已变化，请刷新列表后重试。";
    }
    if (error.status === 422) return "请检查成员信息或任务改派参数。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "项目成员服务暂时不可用，请重试。";
}

function mutationHeaders(
  csrfToken: string,
  idempotencyKey: string,
): Readonly<Record<string, string>> {
  return {
    "x-csrf-token": csrfToken,
    "Idempotency-Key": idempotencyKey,
  };
}

export interface ProjectMemberAddFailure {
  readonly userId: number;
  readonly error: unknown;
}

export interface ProjectMemberAddResult {
  readonly added: readonly number[];
  readonly failures: readonly ProjectMemberAddFailure[];
}

/** 成员与设置页首屏数据预取：项目目录 + 当前项目成员。 */
export function prefetchProjectMembersRoute(
  cache: QueryClient,
  projectId: number,
  client?: InpulseApiClient,
): void {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return;
  }
  const api = client ?? createApiClient();
  void cache.prefetchQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => api.listProjects({ signal }),
  });
  void cache.prefetchQuery({
    queryKey: ["project-members", projectId],
    queryFn: ({ signal }) => api.listProjectMembers(projectId, { signal }),
  });
}

export function useProjectMembers(
  projectId: number,
  client?: InpulseApiClient,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  /** 每个待添加用户各自留一个幂等键，失败重试时沿用同一键。 */
  const addRetryKeys = useRef(new Map<string, string>());
  const removeRetryKey = useRef<{ signature: string; key: string } | null>(
    null,
  );
  const roleRetryKey = useRef<{ signature: string; key: string } | null>(null);

  const query = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: ({ signal }) => api.listProjectMembers(projectId, { signal }),
    retry: false,
    enabled: Number.isInteger(projectId) && projectId > 0,
    // 与其它项目级页面同一口径（2026-10-10）：换项目保留上一份成员列表。
    placeholderData: keepPreviousData,
    // 全局关闭了窗口聚焦重取；成员列表由他人改动时靠回到页面自动同步，
    // 不再依赖手动「刷新成员」按钮。
    refetchOnWindowFocus: true,
  });

  const addMutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      readonly userIds: readonly number[];
    }): Promise<ProjectMemberAddResult> => {
      const csrf = await api.issueCsrfToken();
      const added: number[] = [];
      const failures: ProjectMemberAddFailure[] = [];
      // 后端一次只接受一个 userId，逐个提交：每人独立幂等键与签名，
      // 失败不中断其余用户，返回结果由调用方决定提示与保留勾选。
      for (const userId of input.userIds) {
        const signature = JSON.stringify([projectId, userId]);
        const cached = addRetryKeys.current.get(signature);
        const idempotencyKey =
          cached ?? createIdempotencyKey("project-member-add");
        if (cached === undefined) {
          addRetryKeys.current.set(signature, idempotencyKey);
        }
        try {
          await api.addProjectMember(
            projectId,
            { userId },
            { headers: mutationHeaders(csrf.csrfToken, idempotencyKey) },
          );
          addRetryKeys.current.delete(signature);
          added.push(userId);
        } catch (error) {
          failures.push({ userId, error });
        }
      }
      return { added, failures };
    },
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["project-members", projectId] }),
        cache.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });

  const removeMutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      readonly userId: number;
      readonly reassignments: readonly ProjectMemberReassignmentItem[];
    }) => {
      const signature = JSON.stringify([
        projectId,
        input.userId,
        input.reassignments,
      ]);
      if (removeRetryKey.current?.signature !== signature) {
        removeRetryKey.current = {
          signature,
          key: createIdempotencyKey("project-member-remove"),
        };
      }
      const csrf = await api.issueCsrfToken();
      return api.removeProjectMember(
        projectId,
        input.userId,
        { reassignments: [...input.reassignments] },
        {
          headers: mutationHeaders(csrf.csrfToken, removeRetryKey.current.key),
        },
      );
    },
    onSuccess: async () => {
      removeRetryKey.current = null;
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["project-members", projectId] }),
        cache.invalidateQueries({ queryKey: ["projects"] }),
        cache.invalidateQueries({
          queryKey: ["project-member-unfinished-tasks", projectId],
        }),
      ]);
    },
  });

  // ADR-039：任命/撤销组长（仅系统管理员可调用）。
  const roleMutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      readonly userId: number;
      readonly role: "MEMBER" | "LEADER";
    }) => {
      const signature = JSON.stringify([projectId, input.userId, input.role]);
      if (roleRetryKey.current?.signature !== signature) {
        roleRetryKey.current = {
          signature,
          key: createIdempotencyKey("project-member-role"),
        };
      }
      const csrf = await api.issueCsrfToken();
      return api.setProjectMemberRole(
        projectId,
        input.userId,
        { role: input.role },
        {
          headers: mutationHeaders(csrf.csrfToken, roleRetryKey.current.key),
        },
      );
    },
    onSuccess: async () => {
      roleRetryKey.current = null;
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["project-members", projectId] }),
        cache.invalidateQueries({ queryKey: ["projects"] }),
        cache.invalidateQueries({
          queryKey: ["projects", "detail", projectId],
        }),
      ]);
    },
  });

  return { query, addMutation, removeMutation, roleMutation };
}

export function useProjectMemberUnfinishedTasks(
  projectId: number,
  userId: number | undefined,
  client?: InpulseApiClient,
  enabled = true,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["project-member-unfinished-tasks", projectId, userId],
    queryFn: ({ signal }) =>
      api.listProjectMemberUnfinishedTasks(projectId, userId!, { signal }),
    retry: false,
    enabled:
      enabled &&
      Number.isInteger(projectId) &&
      projectId > 0 &&
      Number.isInteger(userId) &&
      userId! > 0,
  });
}
