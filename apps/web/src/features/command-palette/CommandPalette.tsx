import React, { useEffect, useMemo, useState } from "react";
import type { InpulseApiClient, SearchItem } from "@generated/api";
import {
  InpulseIcon,
  type InpulseIconName,
} from "@features/common/components/InpulseIcon";
import {
  describeSearchError,
  isValidSearchQuery,
  SEARCH_MAX_LENGTH,
  useSearchInfiniteQuery,
} from "@features/search/search-query";
import {
  prefetchSearchDestination,
  searchResultPath,
} from "@features/search/search-destination";
import { preloadRoutePath } from "@shared/routing/route-preload";
import { useQueryClient } from "@tanstack/react-query";

interface QuickAction {
  readonly key: string;
  readonly group: string;
  readonly icon: InpulseIconName;
  readonly title: string;
  readonly hint: string;
  /** 该命令的落地地址：光标移到这一行时预热对应页面 chunk。 */
  readonly path: string;
  readonly run: () => void;
}

interface SearchResult {
  readonly key: string;
  readonly group: string;
  readonly icon: InpulseIconName;
  readonly title: string;
  readonly hint: string;
  readonly path: string;
  readonly run: () => void;
  /** 搜索结果对应的原始实体；用于在选中时预热目标页面数据。 */
  readonly item?: SearchItem;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly client?: InpulseApiClient;
  /** 系统管理员专属快捷命令（成员与设置）据此过滤。 */
  readonly isAdmin?: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
  readonly onOpenSearch: (query: string) => void;
}

const PALETTE_GROUP_ORDER = [
  "项目",
  "模块",
  "任务",
  "迭代记录",
  "遗留问题",
  "任务组",
  "外部链接",
  "操作",
  "搜索",
] as const;

const paletteGroupOrder: readonly string[] = PALETTE_GROUP_ORDER;

/** 分组排序权重：显示顺序与 ↑↓ 的扁平顺序必须同源，否则高亮会跳到看不见的行。 */
const paletteGroupRank = (group: string): number => {
  const index = paletteGroupOrder.indexOf(group);
  return index === -1 ? PALETTE_GROUP_ORDER.length : index;
};

const entityMeta: Readonly<
  Record<SearchItem["entityType"], { label: string; icon: InpulseIconName }>
> = {
  PROJECT: { label: "项目", icon: "folder" },
  MODULE: { label: "模块", icon: "boxes" },
  TASK: { label: "任务", icon: "clipboard" },
  CHANGE_RECORD: { label: "迭代记录", icon: "gitBranch" },
  EXTERNAL_LINK: { label: "外部链接", icon: "code" },
  TASK_GROUP: { label: "任务组", icon: "boxes" },
  LEFTOVER: { label: "遗留问题", icon: "alert" },
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  client,
  isAdmin = false,
  onClose,
  onNavigate,
  onOpenSearch,
}) => {
  const cache = useQueryClient();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // 用户是否显式选过某一行（↑↓ 或悬停）。没选过时面板不默认选中任何一行，
  // Enter 走全局搜索结果页而不是盲开第一行（用户明确要求）。
  const [cursorTouched, setCursorTouched] = useState(false);
  const normalizedQuery = query.trim();
  const canSearch = isValidSearchQuery(normalizedQuery);
  const search = useSearchInfiniteQuery({
    query: normalizedQuery,
    ...(client ? { client } : {}),
    limit: 20,
  });

  const quickActions: QuickAction[] = useMemo(
    () =>
      (
        [
          {
            key: "quick-projects",
            group: "操作",
            icon: "folder",
            title: "打开项目与模块",
            hint: "新建项目或查看刚创建的项目动态",
            path: "/projects",
            run: () => onNavigate("/projects"),
          },
          {
            key: "quick-tasks",
            group: "操作",
            icon: "clipboard",
            title: "打开任务中心",
            hint: "跨项目任务列表入口",
            path: "/tasks",
            run: () => onNavigate("/tasks"),
          },
          {
            key: "quick-records",
            group: "操作",
            icon: "gitBranch",
            title: "打开迭代记录",
            hint: "已发生变化的业务历史入口",
            path: "/records",
            run: () => onNavigate("/records"),
          },
          {
            key: "quick-notifications",
            group: "操作",
            icon: "bell",
            title: "打开通知中心",
            hint: "查看全部站内通知",
            path: "/notifications",
            run: () => onNavigate("/notifications"),
          },
          {
            key: "quick-settings",
            group: "操作",
            icon: "settings",
            title: "打开成员与设置",
            hint: "成员、角色与权限入口",
            path: "/settings",
            run: () => onNavigate("/settings"),
          },
        ] satisfies readonly QuickAction[]
      ).filter((action) => isAdmin || action.key !== "quick-settings"),
    [isAdmin, onNavigate],
  );

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!canSearch) {
      return [];
    }
    const items = search.data?.pages.flatMap((page) => [...page.items]) ?? [];
    // 面板是启动器：没有独立页面的结果（外部链接、任务组）不列进来，
    // 否则选中它们只能回到搜索页（就是这次要修的旧行为）；完整列表仍在搜索页。
    return items.flatMap((item) => {
      const path = searchResultPath(item);
      if (path === null) {
        return [];
      }
      const meta = entityMeta[item.entityType];
      return [
        {
          key: `${item.entityType}:${item.entityId}`,
          group: meta.label,
          icon: meta.icon,
          title: item.title,
          hint: `${meta.label} · ${item.summary || "可访问对象"}`,
          path,
          item,
          run: () => {
            const ready = Promise.all([
              preloadRoutePath(path),
              prefetchSearchDestination(item, cache, client),
            ]);
            if (
              item.entityType === "CHANGE_RECORD" ||
              item.entityType === "LEFTOVER"
            ) {
              void ready.finally(() => onNavigate(path));
              return;
            }
            void ready;
            onNavigate(path);
          },
        },
      ];
    });
  }, [cache, canSearch, client, onNavigate, search.data]);

  const searchQuickAction: SearchResult[] = canSearch
    ? [
        {
          key: "search-query",
          group: "搜索",
          icon: "search",
          title: `搜索“${normalizedQuery}”`,
          hint: "在全局搜索页查看完整权限过滤结果",
          path: "/search",
          run: () => onOpenSearch(normalizedQuery),
        },
      ]
    : [];

  const flatResults = useMemo<SearchResult[]>(
    () =>
      [...quickActions, ...searchQuickAction, ...searchResults].sort(
        (a, b) => paletteGroupRank(a.group) - paletteGroupRank(b.group),
      ),
    [quickActions, searchQuickAction, searchResults],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setCursorTouched(false);
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [normalizedQuery, searchResults.length]);

  useEffect(() => {
    setCursorTouched(false);
  }, [normalizedQuery]);

  // 光标（含鼠标悬停、方向键移动、查询变化后的默认选中）落到哪一行，就预热哪一行的落地页
  // chunk——与侧栏导航、项目树同一套「导航意图即预取」口径（2026-10-14）。
  const selectedResultForPreload =
    flatResults[canSearch && !cursorTouched ? -1 : cursor];
  useEffect(() => {
    if (selectedResultForPreload !== undefined) {
      void preloadRoutePath(selectedResultForPreload.path);
      if (selectedResultForPreload.item !== undefined) {
        void prefetchSearchDestination(
          selectedResultForPreload.item,
          cache,
          client,
        );
      }
    }
  }, [cache, client, selectedResultForPreload]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const grouped = new Map<string, SearchResult[]>();
  for (const result of flatResults) {
    grouped.set(result.group, [...(grouped.get(result.group) ?? []), result]);
  }
  const flatIndex = new Map(
    flatResults.map((result, index) => [result.key, index]),
  );

  // 没选中任何一行时用 -1 表示「无选中」：高亮与 Enter 都以它为准。
  const selectedIndex = canSearch && !cursorTouched ? -1 : cursor;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flatResults.length === 0) {
        return;
      }
      setCursor(cursorTouched ? (cursor + 1) % flatResults.length : 0);
      setCursorTouched(true);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flatResults.length === 0) {
        return;
      }
      setCursor(
        cursorTouched
          ? (cursor - 1 + flatResults.length) % flatResults.length
          : flatResults.length - 1,
      );
      setCursorTouched(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const current = flatResults[selectedIndex];
      if (current) {
        current.run();
        onClose();
      } else if (canSearch) {
        onOpenSearch(normalizedQuery);
        onClose();
      }
    }
  };

  const orderedGroups = [...grouped.entries()].sort(
    ([a], [b]) => paletteGroupRank(a) - paletteGroupRank(b),
  );

  // 空查询不展示提示：占位符已说明可搜索对象，下方直接是快捷操作列表。
  // 下限为 1 后非空即合法，只有超长才需要提示。
  const searchHint: string | null = !canSearch
    ? normalizedQuery.length > SEARCH_MAX_LENGTH
      ? `搜索词最多 ${SEARCH_MAX_LENGTH} 个字符。`
      : null
    : search.isError
      ? describeSearchError(search.error)
      : search.isPending
        ? "正在通过服务端搜索当前可访问对象..."
        : `支持中文短词、完整英文缩写、完整代码标识符与完整编号；不保证英文或任意子串搜索。已找到 ${searchResults.length} 条可访问结果。`;
  const enterHint =
    canSearch && !cursorTouched
      ? "按 Enter 进入全局搜索结果页，或用 ↑↓ 选择具体结果。"
      : null;

  return (
    <div
      className="overlay palette-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="palette"
        role="dialog"
        aria-label="全局搜索"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <InpulseIcon name="search" size={17} />
          <input
            autoFocus
            value={query}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder="搜索项目、模块、任务、迭代记录…"
            aria-label="全局搜索关键词"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className="palette-esc"
            aria-label="关闭搜索"
            onClick={onClose}
          >
            <kbd>Esc</kbd>
          </button>
        </div>
        {searchHint || enterHint ? (
          <p className="palette-hint">
            {searchHint}
            {enterHint ? (
              <span className="palette-enter-hint">{enterHint}</span>
            ) : null}
          </p>
        ) : null}
        <div className="palette-results">
          {flatResults.length > 0 ? (
            orderedGroups.map(([group, items]) => (
              <section key={group}>
                <h4>{group}</h4>
                <ul>
                  {items.map((result) => {
                    const index = flatIndex.get(result.key) ?? 0;
                    return (
                      <li key={result.key}>
                        <button
                          type="button"
                          className={index === selectedIndex ? "cursor" : ""}
                          onMouseEnter={() => {
                            setCursor(index);
                            setCursorTouched(true);
                          }}
                          onClick={() => {
                            result.run();
                            onClose();
                          }}
                        >
                          <InpulseIcon name={result.icon} size={15} />
                          <span>
                            <strong>{result.title}</strong>
                            <small>{result.hint}</small>
                          </span>
                          {index === selectedIndex ? (
                            <InpulseIcon name="cornerDown" size={14} />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          ) : (
            <div className="calm-empty palette-empty">
              <InpulseIcon name="search" size={24} />
              <strong>没有匹配结果</strong>
              <p>没有可通过当前账号访问的匹配对象。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
