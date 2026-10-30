import React from "react";
import { Alert } from "antd";
import type {
  InpulseApiClient,
  ReadableRecord,
  TaskGroupRecordLink,
} from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import { AppModal } from "@features/common/components/AppModal";
import { formatBeijingMinute } from "@features/common/beijing-time";
import { useProjectDetail } from "@features/projects/project-query";
import type { TaskLocation } from "@features/tasks/task-links";
import { TaskGroupRecordLinks } from "@features/task-groups/TaskGroupRecordLinks";
import { PublishedRecordDetail } from "./PublishedRecordDetail";

/**
 * 记录详情弹窗：聚合组的迭代记录列表（F-25）与任务详情的「本任务迭代记录」
 * 共用同一实现。列表只给摘要，正文、不可变版本、遗留项与 GitHub 关联按
 * recordId 二次加载，直接复用记录工作区的详情实现（B-3a），各页面不再复制
 * 一套记录视图。
 * 作废记录的正文只对系统管理员可读（ReadableRecord 契约），成员点开时给摘要
 * 回退，而不是把 404 渲染成「记录不存在」。
 */

export interface RecordDetailTarget {
  readonly recordId: number;
  readonly code: string;
  readonly title: string;
  readonly recordStatus: "PUBLISHED" | "VOID";
  readonly publishedAt: string;
  /** 编号后的语境标签（聚合组的分支任务等）；缺省时眉标只显示编号。 */
  readonly contextLabel?: string | null;
  /** 作废回退里唯一可读的链接快照；调用方没有链接数据时给空数组。 */
  readonly externalLinks?: readonly TaskGroupRecordLink[];
}

/**
 * 可读记录摘要 → 弹窗目标：调用方通常只有摘要（记录列表 / 聚合组 / 遗留问题行），
 * 正文、版本与遗留项一律由弹窗按 recordId 二次加载，弹层打开前不需要额外请求。
 */
export function recordDetailTarget(record: ReadableRecord): RecordDetailTarget {
  return {
    recordId: record.id,
    code: record.code,
    title: record.title,
    recordStatus: record.status,
    publishedAt: record.publishedAt,
  };
}

/** 弹层小标题：编号 + 语境标签，作废记录补状态。 */
function eyebrowText(record: RecordDetailTarget): string {
  const parts = [record.code];
  if (record.contextLabel !== undefined && record.contextLabel !== null) {
    parts.push(record.contextLabel);
  }
  if (record.recordStatus === "VOID") parts.push("已作废");
  return parts.join(" · ");
}

export interface RecordDetailModalProps {
  readonly projectId: number;
  /** null 表示当前没有选中的记录，弹层关闭。 */
  readonly record: RecordDetailTarget | null;
  readonly api: InpulseApiClient;
  readonly onClose: () => void;
  /** 详情内的修订、作废、遗留项操作完成后回传，供列表刷新。 */
  readonly onChanged: () => void;
  /**
   * 在下层弹窗之上打开。下层同为 `lg`（聚合组详情）时两个盒子等宽等高、居中后
   * 完全重叠，看不出层级；开启后比下层窄一档、高度上限也压一档，四周露出下层
   * 弹窗的边框与阴影（两个盒子仍各自居中，不做位移）。
   */
  readonly nested?: boolean;
  /**
   * 就地打开来源任务：传入后记录详情里的「查看来源任务」渲染成按钮、交回宿主在
   * 当前页面打开任务弹窗（遗留问题页等），关掉后回到本记录弹窗；缺省仍是深链到
   * 模块任务页的 ?taskId=。
   */
  readonly onOpenTask?: ((location: TaskLocation) => void) | undefined;
}

export function RecordDetailModal({
  projectId,
  record,
  api,
  onClose,
  onChanged,
  nested = false,
  onOpenTask,
}: RecordDetailModalProps) {
  const { user } = useAuth();
  const open = record !== null;
  // 只在弹层打开时查项目状态：ADR-043 下项目三态都可写；真正的写权限由服务端再校验。
  const project = useProjectDetail({ client: api, projectId, enabled: open });
  const writable = open && project.data !== undefined;
  const voidedForMember =
    record !== null && record.recordStatus === "VOID" && user?.isAdmin !== true;
  const links = record?.externalLinks ?? [];

  return (
    <AppModal
      className={
        nested
          ? "record-detail-modal record-detail-modal--nested"
          : "record-detail-modal"
      }
      open={open}
      onCancel={onClose}
      size="lg"
      eyebrow={record === null ? undefined : eyebrowText(record)}
      title={record === null ? undefined : record.title}
      closeLabel="关闭迭代记录详情"
      body
    >
      {record === null ? null : voidedForMember ? (
        <section
          className="record-detail-void"
          data-testid="record-detail-void"
          aria-label="已作废记录摘要"
        >
          <Alert
            type="warning"
            title="已作废记录：正文仅系统管理员可查看"
            description="编号、来源、发布时间与关联链接快照仍然保留；需要正文请联系系统管理员。"
          />
          <dl className="record-facts">
            <dt>编号</dt>
            <dd>{record.code}</dd>
            <dt>归属</dt>
            <dd>{record.contextLabel ?? "本任务"}</dd>
            <dt>发布时间</dt>
            <dd>{formatBeijingMinute(record.publishedAt)}</dd>
          </dl>
          {links.length > 0 ? (
            <TaskGroupRecordLinks
              recordId={record.recordId}
              links={links}
              defaultExpanded
            />
          ) : null}
        </section>
      ) : (
        <PublishedRecordDetail
          projectId={projectId}
          recordId={record.recordId}
          client={api}
          writable={writable}
          onListChanged={onChanged}
          onOpenTask={onOpenTask}
        />
      )}
    </AppModal>
  );
}

export default RecordDetailModal;
