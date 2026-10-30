import React from "react";
import type { InpulseApiClient } from "@generated/api";
import type { TaskLocation } from "./task-links";
import type { TaskScope } from "./task-query";
import { TasksPanel } from "./TasksPanel";

/**
 * 任务详情的就地宿主：任务中心等跨项目页点击任务后，在当前页面直接打开与模块任务页
 * 一致的任务详情弹窗（状态推进、编辑、迭代记录、合并与外部链接等写入口
 * 全部由 TasksPanel 承担），不改变地址栏、不跳转到项目 / 模块页。
 *
 * 可写性沿用模块任务页的口径：模块已下线归档后，
 * 归属链上已没有归档只读态，因此直接按可写渲染，不再回查父级状态；服务端仍按
 * 实时权限与任务自身状态独立校验。
 */
export interface TaskDetailOverlayProps {
  readonly target: TaskLocation;
  readonly client?: InpulseApiClient | undefined;
  readonly onClose: () => void;
  /**
   * 详情内的聚合组弹窗点击成员任务标题时，交回宿主换一个任务重新就地打开。
   * 缺省时成员标题按纯文本渲染。
   */
  readonly onOpenTask?: ((location: TaskLocation) => void) | undefined;
}

export const TaskDetailOverlay: React.FC<TaskDetailOverlayProps> = ({
  target,
  client,
  onClose,
  onOpenTask,
}) => {
  const scope: TaskScope = {
    projectId: target.projectId,
    moduleId: target.moduleId,
  };
  return (
    <TasksPanel
      key={target.taskId}
      {...scope}
      mode="detail"
      initialTaskId={target.taskId}
      writable
      client={client}
      onDetailClose={onClose}
      onOpenTask={onOpenTask}
    />
  );
};

export default TaskDetailOverlay;
