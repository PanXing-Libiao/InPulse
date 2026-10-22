import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Space,
  Tag,
  Typography,
} from "antd";
import type { InpulseApiClient, SearchItem } from "@generated/api";
import {
  describeSearchError,
  SEARCH_MAX_LENGTH,
  useSearchInfiniteQuery,
} from "./search-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import {
  prefetchSearchDestination,
  searchResultPath,
} from "./search-destination";
import { useQueryClient } from "@tanstack/react-query";
import { routePreloadHandlers } from "@shared/routing/route-preload";
import "./search-results.css";

const { Text, Title } = Typography;

const entityTypeMeta: Readonly<
  Record<
    SearchItem["entityType"],
    { readonly label: string; readonly color: string }
  >
> = {
  PROJECT: { label: "项目", color: "blue" },
  MODULE: { label: "模块", color: "cyan" },
  FEATURE: { label: "功能", color: "geekblue" },
  TASK: { label: "任务", color: "purple" },
  CHANGE_RECORD: { label: "变更记录", color: "orange" },
  EXTERNAL_LINK: { label: "外部链接", color: "green" },
  TASK_GROUP: { label: "任务组", color: "magenta" },
  LEFTOVER: { label: "遗留问题", color: "volcano" },
};

export interface SearchPageViewProps {
  readonly initialQuery?: string;
  readonly onSubmit?: (query: string) => void;
  /** 打开单条结果自身的页面（路径由 searchResultPath 决定）；未接线时结果行只读。 */
  readonly onOpenResult?: (path: string) => void;
  readonly client?: InpulseApiClient;
}

export const SearchPageView: React.FC<SearchPageViewProps> = ({
  initialQuery = "",
  onSubmit,
  onOpenResult,
  client,
}) => {
  const cache = useQueryClient();
  const [draft, setDraft] = useState(initialQuery);

  useEffect(() => {
    setDraft(initialQuery);
  }, [initialQuery]);

  const normalizedQuery = initialQuery.trim();
  const queryIsTooLong = normalizedQuery.length > SEARCH_MAX_LENGTH;

  const {
    data,
    isPending,
    isError,
    error,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useSearchInfiniteQuery({
    query: normalizedQuery,
    ...(client ? { client } : {}),
  });

  const results = data?.pages.flatMap((page) => [...page.items]) ?? [];

  const handleSearch = (value: string) => {
    onSubmit?.(value.trim());
  };

  let content: React.ReactNode;
  if (queryIsTooLong) {
    content = (
      <Alert
        showIcon
        type="warning"
        message={`搜索词最多 ${SEARCH_MAX_LENGTH} 个字符`}
      />
    );
  } else if (normalizedQuery.length === 0) {
    content = (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="输入关键词开始全局搜索"
      />
    );
  } else if (isPending) {
    content = <CalmSkeleton variant="list" rows={4} label="正在搜索..." />;
  } else if (isError) {
    content = (
      <Alert showIcon type="error" message={describeSearchError(error)} />
    );
  } else if (results.length === 0) {
    content = (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="未找到匹配结果"
      />
    );
  } else {
    content = (
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {results.map((item, index) => {
            const path = searchResultPath(item);
            const preload = path === null ? null : routePreloadHandlers(path);
            const body = (
              <Space orientation="vertical" size={4} style={{ width: "100%" }}>
                <Space align="center" wrap>
                  <Tag color={entityTypeMeta[item.entityType].color}>
                    {entityTypeMeta[item.entityType].label}
                  </Tag>
                  <Text strong>{item.title}</Text>
                </Space>
                <Text type="secondary">{item.summary}</Text>
                {path === null ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    该类型没有独立页面，可在所属对象的页面上查看
                  </Text>
                ) : null}
              </Space>
            );
            return (
              <li
                key={`${item.entityType}:${item.entityId}`}
                data-testid="search-result-item"
                style={{
                  borderBottom:
                    index === results.length - 1
                      ? "none"
                      : "1px solid var(--border)",
                }}
              >
                {path !== null && onOpenResult ? (
                  <a
                    className="search-result-link"
                    href={path}
                    {...preload}
                    onPointerEnter={() => {
                      preload?.onPointerEnter();
                      prefetchSearchDestination(item, cache, client);
                    }}
                    onPointerDown={() => {
                      preload?.onPointerDown();
                      prefetchSearchDestination(item, cache, client);
                    }}
                    onFocus={() => {
                      preload?.onFocus();
                      prefetchSearchDestination(item, cache, client);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      void prefetchSearchDestination(
                        item,
                        cache,
                        client,
                      ).finally(() => onOpenResult(path));
                    }}
                  >
                    {body}
                  </a>
                ) : (
                  <div className="search-result-static">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
        {hasNextPage ? (
          <Button
            type="primary"
            ghost
            loading={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
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
        <Title level={3} style={{ margin: 0 }}>
          全局搜索
        </Title>
        <Input.Search
          aria-label="搜索关键词"
          allowClear
          enterButton="搜索"
          maxLength={SEARCH_MAX_LENGTH}
          placeholder="搜索项目、模块、功能、任务、记录..."
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onSearch={handleSearch}
          style={{ maxWidth: 620 }}
        />
        {normalizedQuery.length > 0 && !queryIsTooLong ? (
          <Text type="secondary">共找到 {results.length} 条结果</Text>
        ) : null}
        {content}
      </Space>
    </Card>
  );
};
