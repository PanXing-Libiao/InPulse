import React from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Space,
  Tag,
  Typography,
} from "antd";
import type { InpulseApiClient, NotificationItem } from "@generated/api";
import {
  describeNotificationError,
  type NotificationFilter,
  useNotificationActions,
  useNotificationsInfiniteQuery,
  useNotificationUnreadCount,
} from "./notification-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { routePreloadHandlers } from "@shared/routing/route-preload";
import { formatBeijingMinute } from "@features/common/beijing-time";

const { Title, Paragraph, Text } = Typography;

/**
 * 服务端存在两种命名风格：项目与记录生命周期用 UPPER_SNAKE，任务与记录用
 * dot.case；两种都收录。未收录的取值按原样显示，便于在界面上直接发现新的
 * 后端事件；UPPER_SNAKE 的历史项只用于展示存库的早期演示通知。
 */
const notificationTypeLabels: Readonly<Record<string, string>> = {
  PROJECT_CREATED: "项目创建",
  PROJECT_JOINED: "加入项目",
  "project.status.change": "变更项目状态",
  "task.assigned": "任务指派",
  TASK_ASSIGNED: "任务指派",
  "task.complete": "任务完成",
  TASK_COMPLETED: "任务完成",
  "task.reopen": "重新打开任务",
  "task.merge": "合并任务",
  "task.unmerge": "解除合并",
  "record.publish": "发布记录",
  "record.version.create": "修订记录",
  "record.leftover.add": "追加遗留问题",
  "leftover.convert": "遗留问题转任务",
  CHANGE_RECORD_VOIDED: "记录作废",
  CHANGE_RECORD_RESTORED: "记录恢复",
  // ADR-043：项目归档已下线，以下三条只用于展示历史通知。
  PROJECT_ARCHIVE_REQUESTED: "归档申请",
  PROJECT_ARCHIVE_APPROVED: "归档通过",
  PROJECT_ARCHIVE_REJECTED: "归档驳回",
};

/** 全站时间统一走 beijing-time 的横杠格式（2026-10-16 口径）。 */
function formatNotificationTime(value: string): string {
  return formatBeijingMinute(value);
}

function notificationTypeLabel(type: string): string {
  return notificationTypeLabels[type] ?? type;
}

function parseNotificationId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export interface NotificationsPageViewProps {
  readonly client?: InpulseApiClient;
  readonly userId?: number | null | undefined;
  readonly filter?: NotificationFilter;
  readonly onFilterChange?: (filter: NotificationFilter) => void;
  readonly onOpenTarget?: (targetPath: string) => void;
}

export const NotificationsPageView: React.FC<NotificationsPageViewProps> = ({
  client,
  userId = null,
  filter = "all",
  onFilterChange,
  onOpenTarget,
}) => {
  const unreadQuery = useNotificationUnreadCount({ client, userId });
  const listQuery = useNotificationsInfiniteQuery({ client, filter, userId });
  const actions = useNotificationActions({ client });
  const items = listQuery.data?.pages.flatMap((page) => [...page.items]) ?? [];
  const unreadCount = unreadQuery.data ?? 0;

  const handleOpen = (item: NotificationItem) => {
    const notificationId = parseNotificationId(item.id);
    if (item.readAt === null && notificationId !== null) {
      void actions.mutate({ kind: "read", notificationId });
    }
    if (item.targetPath !== null) {
      onOpenTarget?.(item.targetPath);
    }
  };

  const handleToggle = (item: NotificationItem) => {
    const notificationId = parseNotificationId(item.id);
    if (notificationId === null) {
      return;
    }
    if (item.readAt === null) {
      void actions.mutate({ kind: "read", notificationId });
      return;
    }
    void actions.mutate({ kind: "unread", notificationId });
  };

  let content: React.ReactNode;
  if (listQuery.isPending) {
    content = <CalmSkeleton variant="list" rows={4} label="正在加载通知..." />;
  } else if (listQuery.isError) {
    content = (
      <Alert
        showIcon
        type="error"
        message={describeNotificationError(listQuery.error)}
      />
    );
  } else if (items.length === 0) {
    content = (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={filter === "unread" ? "没有未读通知" : "还没有通知"}
      />
    );
  } else {
    content = (
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((item, index) => (
            <li
              key={item.id}
              data-testid={`notification-item-${item.id}`}
              style={{
                padding: "12px 0",
                borderBottom:
                  index === items.length - 1
                    ? "none"
                    : "1px solid var(--border)",
              }}
            >
              <div
                role="button"
                tabIndex={0}
                aria-label={`打开通知：${item.title}`}
                {...(item.targetPath === null
                  ? {}
                  : routePreloadHandlers(item.targetPath))}
                onClick={() => handleOpen(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpen(item);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  width: "100%",
                  cursor: "pointer",
                }}
              >
                <span
                  aria-hidden="true"
                  data-testid={`notification-dot-${item.id}`}
                  data-unread={item.readAt === null ? "true" : "false"}
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    marginTop: 7,
                    borderRadius: "50%",
                    flex: "0 0 6px",
                    backgroundColor:
                      item.readAt === null ? "#ef7777" : "transparent",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Space align="center" wrap size={8}>
                    <Text strong={item.readAt === null}>{item.title}</Text>
                    <Tag color="blue">
                      {notificationTypeLabel(item.notificationType)}
                    </Tag>
                    <Text type="secondary">
                      {formatNotificationTime(item.createdAt)}
                    </Text>
                  </Space>
                  {item.body.length > 0 ? (
                    <Paragraph
                      type="secondary"
                      style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}
                    >
                      {item.body}
                    </Paragraph>
                  ) : null}
                </div>
                <Space>
                  <Button
                    type="link"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleToggle(item);
                    }}
                  >
                    {item.readAt === null ? "标记已读" : "标记未读"}
                  </Button>
                </Space>
              </div>
            </li>
          ))}
        </ul>
        {listQuery.hasNextPage ? (
          <Button
            type="primary"
            ghost
            loading={listQuery.isFetchingNextPage}
            onClick={() => void listQuery.fetchNextPage()}
          >
            加载更多
          </Button>
        ) : null}
      </Space>
    );
  }

  return (
    <Card style={{ borderRadius: 10 }}>
      <Space orientation="vertical" size={20} style={{ width: "100%" }}>
        <Space align="center" wrap>
          <Title level={3} style={{ margin: 0 }}>
            站内通知
          </Title>
          <Badge count={unreadCount} overflowCount={99} showZero={false} />
        </Space>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          通知只展示当前登录用户的站内消息；已读与未读操作会携带 CSRF 与幂等
          Key，不会影响其他用户。
        </Paragraph>
        <Space wrap>
          <Button
            type={filter === "all" ? "primary" : "default"}
            onClick={() => onFilterChange?.("all")}
          >
            全部
          </Button>
          <Button
            type={filter === "unread" ? "primary" : "default"}
            onClick={() => onFilterChange?.("unread")}
          >
            未读
          </Button>
          <Button
            disabled={unreadCount === 0 || actions.isPending}
            loading={actions.isPending}
            onClick={() => void actions.mutate({ kind: "readAll" })}
          >
            全部已读
          </Button>
        </Space>
        {content}
      </Space>
    </Card>
  );
};
