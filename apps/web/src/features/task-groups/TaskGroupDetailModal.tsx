import React, { useEffect, useRef, useState } from "react";
import type { InpulseApiClient } from "@generated/api";
import { AppModal } from "@features/common/components/AppModal";
import { CalmBadge } from "@features/common/components/Calm";
import type { TaskLocation } from "@features/tasks/task-links";
import { TaskGroupDetailPanels } from "./TaskGroupDetailPanels";
import { useTaskGroupQuery } from "./task-groups-query";
import type { TaskGroupAdapter } from "./task-groups-types";

/**
 * F-25 聚合组详情弹窗：任务中心与模块任务页内的任务弹窗中，聚合组入口就地打开该弹层，
 * 不再跳转整页详情（`/task-groups/{id}` 页面已随方案 A 删除）。正文由
 * TaskGroupDetailPanels 承载；记录筛选只在本次打开期间有效（弹层的局部状态），
 * 换组或重新打开都从「全部记录」开始。成员任务标题由宿主下发的 `onOpenTask`
 * 就地打开任务详情，本层不自己实现详情。
 */

export interface TaskGroupDetailModalProps {
  /** null 表示当前没有选中的聚合组，弹层关闭。 */
  readonly groupId: number | null;
  readonly adapter: TaskGroupAdapter;
  /** 记录详情与解除合并写路径使用的生成客户端。 */
  readonly api: InpulseApiClient;
  readonly onClose: () => void;
  /** 解除合并等写操作完成后回调宿主（任务中心据此刷新聚合组列表）。 */
  readonly onChanged?: (() => void) | undefined;
  /** 点击成员任务标题时就地打开任务详情；缺省时标题按纯文本渲染。 */
  readonly onOpenTask?: ((location: TaskLocation) => void) | undefined;
}

export function TaskGroupDetailModal({
  groupId,
  adapter,
  api,
  onClose,
  onChanged,
  onOpenTask,
}: TaskGroupDetailModalProps) {
  const open = groupId !== null;
  // 关闭时不下发请求；打开后与正文面板共用同一查询键的缓存，不产生重复请求。
  const groupQuery = useTaskGroupQuery({
    groupId: groupId ?? 0,
    adapter,
    enabled: open,
  });
  const group = groupQuery.data?.group ?? null;
  const [memberTaskId, setMemberTaskId] = useState<number | null>(null);
  const lastGroupId = useRef<number | null>(null);
  useEffect(() => {
    if (lastGroupId.current === groupId) return;
    lastGroupId.current = groupId;
    setMemberTaskId(null);
  }, [groupId]);

  return (
    <AppModal
      className="task-group-detail-modal"
      open={open}
      onCancel={onClose}
      size="lg"
      eyebrow={
        group === null ? "聚合组 / TASK GROUP" : group.code + " / TASK GROUP"
      }
      title={
        group === null
          ? groupQuery.isPending && open
            ? "正在加载聚合组…"
            : "任务聚合组"
          : group.name
      }
      closeLabel="关闭任务聚合组详情"
      body
    >
      <div className="task-group-modal-meta">
        {group === null ? null : (
          <CalmBadge tone={group.status === "ACTIVE" ? "blue" : "gray"}>
            {group.status === "ACTIVE" ? "进行中" : "已关闭"}
          </CalmBadge>
        )}
        <span className="task-group-created">
          主任务是统一入口；分支任务保留原任务编号、负责人与全部迭代记录，合并关系不删除历史。
        </span>
      </div>
      {groupId === null ? null : (
        <TaskGroupDetailPanels
          key={groupId}
          groupId={groupId}
          adapter={adapter}
          api={api}
          memberTaskId={memberTaskId}
          onMemberTaskIdChange={setMemberTaskId}
          {...(onChanged === undefined ? {} : { onChanged })}
          {...(onOpenTask === undefined ? {} : { onOpenTask })}
        />
      )}
    </AppModal>
  );
}

export default TaskGroupDetailModal;
