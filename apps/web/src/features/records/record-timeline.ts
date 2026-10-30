import type { RecordFeedQueryRequest } from "@generated/api";
import {
  beijingDayKey,
  formatBeijingClock,
  formatDayKeyCn,
  formatDayKeySlash,
} from "@features/common/beijing-time";

/**
 * B-3b：记录清单的展示分组与筛选选项。
 * 跨项目清单、来源与 `q` 全文检索都由服务端 `listRecordFeed` 完成（B-3a 在已加载页
 * 内做的本地过滤与服务端结果不一致，已随名称回填一起移除）；这里只保留设计师稿的
 * 筛选文案与按发布日分组。主任务 / 分支任务的拆分来自服务端任务组合并关系（R-5）。
 */
export type RecordSourceFilter = NonNullable<RecordFeedQueryRequest["source"]>;

export const RECORD_SOURCE_FILTERS: ReadonlyArray<{
  readonly value: RecordSourceFilter;
  readonly label: string;
}> = [
  { value: "ALL", label: "全部" },
  { value: "MAIN", label: "主任务" },
  { value: "SOURCE", label: "分支任务" },
  { value: "MODULE", label: "模块级记录" },
];

export const RECORD_SEARCH_PLACEHOLDER =
  "搜索编号、标题、原因、改动、验证、遗留问题或 GitHub 编号";

/** 分组键按北京日历日；服务端下发 UTC ISO 串，不能直接切字符串。 */
export function recordDateKey(publishedAt: string) {
  return beijingDayKey(publishedAt);
}

function recordDateLabel(key: string) {
  return formatDayKeyCn(key);
}

/** 时间线竖线左侧的短日期（如 9/16），完整日期仍由分组标题承载。 */
export function timelineDayLabel(key: string) {
  return formatDayKeySlash(key);
}

/** 时间线竖线左侧、每条记录对应的发布时刻（如 14:59）。 */
export function timelineTimeLabel(publishedAt: string) {
  return formatBeijingClock(publishedAt);
}

interface DatedFeedItem {
  readonly record: { readonly publishedAt: string };
}

/** 服务端已按 published_at DESC 分页；这里只把当前已加载页按发布日分组。 */
export function groupRecordsByDate<T extends DatedFeedItem>(
  items: readonly T[],
) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = recordDateKey(item.record.publishedAt);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, grouped]) => ({
      key,
      label: recordDateLabel(key),
      records: grouped,
    }));
}
