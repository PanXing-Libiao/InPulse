import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InpulseApiClient } from "@generated/api";

/**
 * 负责人「脱钩」口径：任务挂着的人被移出项目成员后，任务本身不会自动改派
 * （业务历史只归档、作废或新版本，不物理改写），界面上就必须说清「这个人已经
 * 不在项目成员里、这个任务要重新分配」。
 *
 * 2026-10-16 实测反馈两个反例：任务看板卡片只平铺姓名、看不出人已移出；任务详情
 * 与编辑下拉则回退成「用户 #2（历史负责人）」，把内部编号暴露给了用户。
 * 卡片、列表、详情、下拉共用这里的一份文案。
 */
/** 内联短标记：跟在姓名后面，卡片与列表一眼能看出人已移出。 */
export const DETACHED_ASSIGNEE_SUFFIX = "（已移出项目）";
/** 完整指引：进 hover title 与下拉副标题。 */
export const DETACHED_ASSIGNEE_HINT = "已不在项目成员中，请重新分配";

/** 姓名 + 内联标记。 */
export function withDetachedMark(name: string, detached: boolean): string {
  return detached ? name + DETACHED_ASSIGNEE_SUFFIX : name;
}

/** 姓名 + 内联标记 + 完整指引：hover 时能读到该怎么处理。 */
export function detachedAssigneeTitle(name: string, detached: boolean): string {
  return detached
    ? name + DETACHED_ASSIGNEE_SUFFIX + "：" + DETACHED_ASSIGNEE_HINT
    : name;
}

/**
 * 项目活跃成员 id 集合。名单还没回来时返回 null——此时一律不标「已移出」，
 * 免得加载那一瞬间把所有人都误标一遍。
 */
export function useActiveProjectMemberIds(
  api: InpulseApiClient,
  projectId: number,
): ReadonlySet<number> | null {
  const query = useQuery({
    queryKey: ["project-active-members", projectId],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(projectId, { signal }),
    retry: false,
  });
  return useMemo(
    () =>
      query.data === undefined
        ? null
        : new Set(query.data.items.map((item) => item.id)),
    [query.data],
  );
}

/** 活跃成员名单里没有这个人，就是已脱钩。名单未知（null）时一律返回 false。 */
export function isDetachedAssignee(
  activeMemberIds: ReadonlySet<number> | null,
  userId: number,
): boolean {
  return activeMemberIds !== null && !activeMemberIds.has(userId);
}

/** 看板卡片 / 列表行：把一队负责人按脱钩口径拼成一个字符串（hint=true 时带处置指引）。 */
export function assigneeNamesOf(
  assignees: readonly {
    readonly userId: number;
    readonly name: string;
  }[],
  activeMemberIds: ReadonlySet<number> | null,
  hint: boolean,
): string {
  return assignees
    .map((assignee) =>
      hint
        ? detachedAssigneeTitle(
            assignee.name,
            isDetachedAssignee(activeMemberIds, assignee.userId),
          )
        : withDetachedMark(
            assignee.name,
            isDetachedAssignee(activeMemberIds, assignee.userId),
          ),
    )
    .join("、");
}
