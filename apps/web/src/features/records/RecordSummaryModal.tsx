import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Button } from "antd";
import type { InpulseApiClient, ProjectItem, UserRef } from "@generated/api";
import { AppModal } from "@features/common/components/AppModal";
import { CalmSegmented } from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { projectSelectOption } from "@features/common/project-select-option";
import { PublishedRecordDetail } from "@features/published-records/PublishedRecordDetail";
import {
  buildSummaryDetailMarkdown,
  buildSummaryDocument,
  localEditKey,
  summaryDocumentToText,
  summaryDocumentToTextWithEdits,
  type SummaryBlock,
} from "./record-summary-document";
import {
  useRecordSummaryQuery,
  type RecordSummaryGroupBy,
} from "./record-summary-query";
import {
  groupSummaryAssistSegments,
  parseSummaryAssistMarkdown,
  summaryAssistDocumentToText,
  type SummaryAssistDocument,
  type SummaryAssistSegment,
} from "./record-summary-assist-document";
import {
  describeRecordSummaryAssistError,
  useAssistRecordSummary,
} from "./record-summary-assist-query";
import "./record-summary.css";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import {
  beijingDayKey,
  beijingTodayParts,
} from "@features/common/beijing-time";

/** 时间档位：自定义以外的三档都由本地日历推导起止自然日。 */
type RangePreset = "year" | "quarter" | "month" | "custom";

const RANGE_PRESETS: readonly {
  readonly value: RangePreset;
  readonly label: string;
}[] = [
  { value: "year", label: "本年" },
  { value: "quarter", label: "本季度" },
  { value: "month", label: "本月" },
  { value: "custom", label: "自定义" },
];

/** ADR-076 AI 助手浮层的快捷要求：一句话，点一下拼进输入框，不覆盖已写内容。 */
const AI_REQUIREMENT_SUGGESTIONS: readonly string[] = [
  "给领导看，先给结论",
  "突出遗留风险",
  "说得口语一点",
  "每条只留一句",
  "包含下一步建议",
];

/** 用户没写要求时的兜底要求：只整理结构、不动事实，满足契约的「至少 1 个字」。 */
const DEFAULT_AI_REQUIREMENT = "按现有结构重新整理一遍，保持全部事实不变";

/** 上次成功生成的要求存放键：浮层标签由它切片而来，只存本地浏览器，不入库、不进契约。 */
const LAST_REQUIREMENT_STORAGE_KEY = "inpulse.ai-assist.last-requirement";

function readLastRequirement(): string {
  try {
    return globalThis.localStorage.getItem(LAST_REQUIREMENT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastRequirement(text: string): void {
  try {
    globalThis.localStorage.setItem(LAST_REQUIREMENT_STORAGE_KEY, text);
  } catch {
    // 写入失败（隐私模式等）：标签回落默认快捷要求，不影响生成。
  }
}

/** 上次要求 → 标签片段：按 ，、；。 切，单条 ≤16 字、去重、最多 6 个。 */
export function requirementFragments(text: string): readonly string[] {
  const fragments: string[] = [];
  for (const part of text.split(/[，、；。]/)) {
    const fragment = part.trim();
    if (fragment === "" || fragment.length > 16) continue;
    if (fragments.includes(fragment)) continue;
    fragments.push(fragment);
  }
  if (fragments.length === 0 && text.trim() !== "") {
    fragments.push(text.trim().slice(0, 16));
  }
  return fragments.slice(0, 6);
}

/** 切换式标签的反操作：把已包含的片段连同相邻分隔逗号一起移除。 */
function removeRequirementFragment(current: string, fragment: string): string {
  const text = current.trim();
  if (text === fragment) return "";
  if (text.startsWith(`${fragment}，`)) return text.slice(fragment.length + 1);
  return text.replace(`，${fragment}`, "");
}

/** 快捷要求与已有文本拼接：已包含的不重复，超出契约 500 字上限的截断。 */
function appendRequirement(current: string, suggestion: string): string {
  const text = current.trim();
  if (text === "") return suggestion;
  if (text.includes(suggestion)) return text;
  return `${text}，${suggestion}`.slice(0, 500);
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** 某年某月（1-12）的最后一天，纯 UTC 计算，不受运行环境时区影响。 */
const monthEnd = (year: number, month: number): string =>
  `${String(year)}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

/** 档位 → [起始日, 结束日]（含首尾，北京日历日）。 */
export function presetRange(preset: RangePreset): {
  readonly from: string;
  readonly to: string;
} {
  const { year, month } = beijingTodayParts();
  if (preset === "quarter") {
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return {
      from: `${String(year)}-${pad(startMonth)}-01`,
      to: monthEnd(year, startMonth + 2),
    };
  }
  if (preset === "month") {
    return {
      from: `${String(year)}-${pad(month)}-01`,
      to: monthEnd(year, month),
    };
  }
  return { from: `${String(year)}-01-01`, to: `${String(year)}-12-31` };
}

export interface RecordSummaryModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly client?: InpulseApiClient | undefined;
  /** 页头项目筛选的当前值；0 表示全部项目。打开弹窗时沿用。 */
  readonly defaultProjectId: number;
  readonly projects: readonly ProjectItem[];
}

/**
 * F-33 迭代总结弹窗：范围 → 服务端取事实 → 本地渲染正文。
 *
 * 弹窗只做取数与呈现，不写任何业务数据：不产生正式记录、不改任务状态，
 * 因此没有幂等、CSRF 与乐观锁语义。正文措辞由 record-summary-document.ts
 * 按事实推导，复制正文与该推导共用同一份文档模型，避免两处口径漂移。
 */
export function RecordSummaryModal({
  open,
  onClose,
  client,
  defaultProjectId,
  projects,
}: RecordSummaryModalProps) {
  const [preset, setPreset] = useState<RangePreset>("year");
  const [customRange, setCustomRange] = useState(() => presetRange("year"));
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [groupBy, setGroupBy] = useState<RecordSummaryGroupBy>("PROJECT");
  const [memberId, setMemberId] = useState(0);
  const [memberOptions, setMemberOptions] = useState<readonly UserRef[]>([]);
  const [detail, setDetail] = useState(false);
  /** 明细里展开的那一条记录；null 表示全部收起（默认收起，点行或箭头展开）。 */
  const [expandedRecordId, setExpandedRecordId] = useState<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">(
    "idle",
  );
  /**
   * ADR-076：AI 改写的产物只活在客户端状态里（服务端纯校验、不落库）。
   * aiDocument 为 null 表示正文仍是本地确定性生成的那一份；有值时可逐段编辑。
   */
  const [aiOpen, setAiOpen] = useState(false);
  const [requirement, setRequirement] = useState("");
  /** 上次成功生成的要求：标签由它切片而来（本地记忆，不入库）。 */
  const [lastRequirement, setLastRequirement] = useState<string>(() =>
    readLastRequirement(),
  );
  const aiRequestRef = useRef<HTMLTextAreaElement | null>(null);
  const [aiDocument, setAiDocument] = useState<SummaryAssistDocument | null>(
    null,
  );
  /**
   * 生成改写稿时用的事实快照：重取到的事实与它不同，就说明这份稿子已经过时。
   * 与下面「打开时重取」配对，避免出现「事实是新的、正文是旧的」。
   */
  const [assistFacts, setAssistFacts] = useState<string | null>(null);
  /** 已改动的段：key → 当前文本；改回原文即删除该键（计数以「与原文不同」为准）。 */
  const [edited, setEdited] = useState<Readonly<Record<string, string>>>({});
  const aiSlotRef = useRef<HTMLDivElement | null>(null);
  const aiDocRef = useRef<HTMLElement | null>(null);
  const localDocRef = useRef<HTMLElement | null>(null);
  const assist = useAssistRecordSummary({ client });
  const requirementChips =
    lastRequirement === ""
      ? AI_REQUIREMENT_SUGGESTIONS
      : requirementFragments(lastRequirement);

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId);
      setMemberId(0);
      setExpandedRecordId(null);
    }
  }, [open, defaultProjectId]);

  const toggleRecord = (recordId: number) => {
    setExpandedRecordId((current) => (current === recordId ? null : recordId));
  };

  const range = preset === "custom" ? customRange : presetRange(preset);
  const summary = useRecordSummaryQuery({
    client,
    from: range.from,
    to: range.to,
    groupBy,
    projectId,
    memberId,
    enabled: open,
  });

  const document = useMemo(
    () =>
      summary.data === undefined ? null : buildSummaryDocument(summary.data),
    [summary.data],
  );

  /**
   * 交给 AI 的事实正文：与「复制正文」同一份确定性文本，服务端不再查库，
   * 只改写这段（ADR-076）。因此事实变了就必须丢弃已生成的正文。
   */
  const facts = useMemo(
    () => (document === null ? "" : summaryDocumentToText(document)),
    [document],
  );

  // 取数范围一变，已生成的正文就与当前事实不一致：直接丢弃，避免拿旧正文汇报。
  useEffect(() => {
    setAiDocument(null);
    setEdited({});
  }, [range.from, range.to, groupBy, projectId, memberId]);

  /**
   * 每次打开都重取事实：总结是「此刻事实」的快照（服务端只返回现时可见的已发布
   * 记录）。弹层关闭时查询被禁用，重新打开不会按挂载重取，沿用缓存会让期间新发布 /
   * 作废 / 恢复的记录进不了总结——除非用户自己改范围或点「重新生成」。
   */
  const refetchedOnOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      refetchedOnOpen.current = false;
      return;
    }
    if (refetchedOnOpen.current) return;
    refetchedOnOpen.current = true;
    // 首次打开由 enabled 触发取数；只有缓存里已有数据时才需要显式重取。
    if (summary.dataUpdatedAt > 0) void summary.refetch();
  }, [open, summary]);

  // 事实变了（重取到新事实、范围变化、他处发布 / 作废 / 恢复）就丢弃改写稿与手动
  // 改动：拿旧事实写出的正文汇报新范围，比没有正文更糟（ADR-076 §2.2 同口径）。
  useEffect(() => {
    if (assistFacts === null || assistFacts === facts) return;
    setAiDocument(null);
    setEdited({});
    setAssistFacts(null);
  }, [assistFacts, facts]);

  // 点浮层以外的地方收起浮层；Esc 由下一个 effect 在 window 捕获层先收浮层。
  useEffect(() => {
    if (!aiOpen) return;
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (aiSlotRef.current?.contains(event.target as Node) === true) return;
      setAiOpen(false);
    };
    globalThis.document.addEventListener("mousedown", onMouseDown);
    return () =>
      globalThis.document.removeEventListener("mousedown", onMouseDown);
  }, [aiOpen]);

  // 打开浮层直接可打字；Esc 在 window 捕获层先收浮层（早于 AppModal 的 document 捕获）。
  useEffect(() => {
    if (!aiOpen) return;
    aiRequestRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAiOpen(false);
    };
    globalThis.window.addEventListener("keydown", onKeyDown, true);
    return () =>
      globalThis.window.removeEventListener("keydown", onKeyDown, true);
  }, [aiOpen]);

  // 成员候选只来自同口径的按成员总结，避免为此新增成员目录接口。
  useEffect(() => {
    const data = summary.data;
    if (data === undefined || data.groupBy !== "MEMBER") return;
    const seen = new Set<number>();
    const next: UserRef[] = [];
    for (const section of data.sections) {
      if (section.member === null || seen.has(section.member.userId)) continue;
      seen.add(section.member.userId);
      next.push(section.member);
    }
    if (next.length > 0) setMemberOptions(next);
  }, [summary.data]);

  const copy = useCallback(async () => {
    const data = summary.data;
    if (document === null || data === undefined) return;
    // 明细模式复制的是与明细表同列的记录清单，而不是同一份总结正文。
    const text = detail
      ? buildSummaryDetailMarkdown(data)
      : aiDocument === null
        ? summaryDocumentToTextWithEdits(document, edited)
        : summaryAssistDocumentToText(aiDocument, edited);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("done");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  }, [aiDocument, detail, document, edited, summary.data]);

  /** 就地改动计数：本地正文与 AI 正文共用同一张 edited 表。 */
  const editedCount = useMemo(() => Object.keys(edited).length, [edited]);

  /**
   * 逐段编辑以 DOM 当前文本为准：contentEditable 的 children 恒为模型原文，
   * React 不会写回 DOM，因此打字不会被打断；改动只进 edited 表。
   */
  const handleSegmentInput = (event: React.FormEvent<HTMLElement>) => {
    const node = event.currentTarget;
    const key = node.dataset["key"];
    const orig = node.dataset["orig"];
    if (key === undefined || orig === undefined) return;
    const text = (node.textContent ?? "").trim();
    setEdited((current) => {
      const next = { ...current };
      if (text === orig) delete next[key];
      else next[key] = text;
      return next;
    });
  };

  const editNodeOf = (key: string): HTMLElement | null => {
    const selector = `[data-key="${key}"]`;
    return (
      aiDocRef.current?.querySelector<HTMLElement>(selector) ??
      localDocRef.current?.querySelector<HTMLElement>(selector) ??
      null
    );
  };

  /** 单段回退：只把这句恢复成模型原文，其余改动保留。 */
  const revertKey = (key: string, orig: string) => {
    const node = editNodeOf(key);
    if (node !== null) node.textContent = orig;
    setEdited((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  /** 全量回退：本地正文与 AI 正文都回到各自模型原文。 */
  const revertAll = () => {
    for (const key of Object.keys(edited)) {
      const node = editNodeOf(key);
      const orig = node?.dataset["orig"];
      if (node !== null && orig !== undefined) node.textContent = orig;
    }
    setEdited({});
  };

  /** 生成（或按新要求重生成）：成功即切换成可编辑正文并收起浮层。 */
  const runAssist = async (): Promise<void> => {
    if (document === null || facts === "") return;
    const text = requirement.trim();
    try {
      const result = await assist.mutateAsync({
        requirement: text === "" ? DEFAULT_AI_REQUIREMENT : text,
        facts,
      });
      setAiDocument(parseSummaryAssistMarkdown(result.markdown));
      setEdited({});
      setAssistFacts(facts);
      setDetail(false);
      setAiOpen(false);
      if (text !== "") {
        writeLastRequirement(text);
        setLastRequirement(text);
      }
    } catch {
      // 失败不改动正文：提示由浮层内的 assist.error 呈现，用户可以改要求重试。
    }
  };

  /** 可编辑句：DOM 当前文本为准，改动只进 edited 表（本地与 AI 正文共用）。 */
  const renderEditable = (key: string, orig: string) => (
    <span
      className="summary-ai-edit"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-key={key}
      data-orig={orig}
      onInput={handleSegmentInput}
    >
      {orig}
    </span>
  );

  const renderAssistSegment = (segment: SummaryAssistSegment) =>
    renderEditable(segment.key, segment.orig);

  const renderRevertButton = (key: string, orig: string) => (
    <button
      type="button"
      className="summary-ai-revert"
      aria-label={`回退「${orig.slice(0, 12)}」这句`}
      onClick={() => {
        revertKey(key, orig);
      }}
    >
      回退这句
    </button>
  );

  const assistBody =
    aiDocument === null ? null : (
      <article
        className="summary-doc summary-ai-doc"
        data-source="assist"
        ref={aiDocRef}
      >
        {groupSummaryAssistSegments(aiDocument).map((unit) =>
          unit.kind === "bullets" ? (
            <ul className="summary-ai-list" key={unit.key}>
              {unit.segments.map((segment) => (
                <li
                  key={segment.key}
                  className="summary-ai-sec"
                  data-edited={
                    edited[segment.key] === undefined ? "false" : "true"
                  }
                >
                  {renderRevertButton(segment.key, segment.orig)}
                  {renderAssistSegment(segment)}
                </li>
              ))}
            </ul>
          ) : (
            <div
              key={unit.segment.key}
              className="summary-ai-sec"
              data-edited={
                edited[unit.segment.key] === undefined ? "false" : "true"
              }
            >
              {renderRevertButton(unit.segment.key, unit.segment.orig)}
              {unit.kind === "heading" ? (
                <h4 className="summary-ai-heading">
                  {renderAssistSegment(unit.segment)}
                </h4>
              ) : (
                <p className="summary-ai-paragraph">
                  {renderAssistSegment(unit.segment)}
                </p>
              )}
            </div>
          ),
        )}
      </article>
    );

  const filters = (
    <div className="summary-filters">
      <div className="summary-filter-row">
        <span className="summary-filter-label">时间</span>
        <CalmSegmented
          label="时间范围"
          value={preset}
          options={RANGE_PRESETS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={(next) => setPreset(next as RangePreset)}
        />
        {preset === "custom" ? (
          <span className="summary-range-inputs">
            <input
              type="date"
              aria-label="起始日期"
              value={customRange.from}
              onChange={(event) =>
                setCustomRange((prev) => ({
                  ...prev,
                  from: event.target.value,
                }))
              }
            />
            <input
              type="date"
              aria-label="结束日期"
              value={customRange.to}
              onChange={(event) =>
                setCustomRange((prev) => ({ ...prev, to: event.target.value }))
              }
            />
          </span>
        ) : (
          <span className="summary-range-text">
            {range.from} - {range.to}
          </span>
        )}
      </div>
      <div className="summary-filter-row">
        <span className="summary-filter-label">项目</span>
        <CalmSelect
          ariaLabel="总结项目"
          value={projectId > 0 ? String(projectId) : ""}
          appearance="rich"
          onChange={(next) => setProjectId(Number(next) || 0)}
          options={[
            { value: "", label: "全部项目" },
            ...projects.map(projectSelectOption),
          ]}
          animated
        />
      </div>
      <div className="summary-filter-row">
        <span className="summary-filter-label">归纳</span>
        <CalmSegmented
          label="归纳方式"
          value={groupBy}
          options={[
            { value: "PROJECT", label: "按项目" },
            { value: "MEMBER", label: "按成员" },
          ]}
          onChange={(next) => {
            setGroupBy(next as RecordSummaryGroupBy);
            setMemberId(0);
          }}
        />
        {groupBy === "MEMBER" && memberOptions.length > 0 ? (
          <CalmSelect
            ariaLabel="总结成员"
            value={memberId > 0 ? String(memberId) : ""}
            appearance="menu"
            onChange={(next) => setMemberId(Number(next) || 0)}
            options={[
              { value: "", label: "全体成员" },
              ...memberOptions.map((member) => ({
                value: String(member.userId),
                label: member.name,
              })),
            ]}
            animated
          />
        ) : null}
      </div>
    </div>
  );

  const renderBlock = (block: SummaryBlock, index: number) => {
    if (block.kind === "overview") {
      const key = localEditKey(String(index), "text");
      return (
        <p
          className="summary-overview summary-ai-sec"
          key={index}
          data-edited={edited[key] === undefined ? "false" : "true"}
        >
          {renderRevertButton(key, block.text)}
          <b>整体概览</b>
          {"　"}
          {renderEditable(key, block.text)}
        </p>
      );
    }
    if (block.kind === "section") {
      return (
        <section className="summary-section" key={index}>
          <h4>{block.heading}</h4>
          {block.bullets.length === 0 ? (
            <p className="summary-empty">本范围内没有已发布的迭代记录。</p>
          ) : (
            <ul>
              {block.bullets.map((bullet, bulletIndex) => {
                const key = localEditKey(
                  String(index),
                  "b",
                  String(bulletIndex),
                );
                return (
                  <li
                    key={bulletIndex}
                    className="summary-ai-sec"
                    data-edited={edited[key] === undefined ? "false" : "true"}
                  >
                    {renderRevertButton(key, bullet.text)}
                    <b>{bullet.label}</b>
                    {"："}
                    {renderEditable(key, bullet.text)}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      );
    }
    const leadKey = localEditKey(String(index), "lead");
    return (
      <section className="summary-section" key={index}>
        <h4>{block.heading}</h4>
        <p
          className="summary-ai-sec"
          data-edited={edited[leadKey] === undefined ? "false" : "true"}
        >
          {renderRevertButton(leadKey, block.lead)}
          {renderEditable(leadKey, block.lead)}
        </p>
        {block.items.length === 0 ? (
          <p className="summary-empty">没有待跟进条目。</p>
        ) : (
          <ul>
            {block.items.map((item, itemIndex) => {
              const key = localEditKey(
                String(index),
                "item",
                String(itemIndex),
              );
              return (
                <li
                  key={itemIndex}
                  className="summary-ai-sec"
                  data-edited={edited[key] === undefined ? "false" : "true"}
                >
                  {renderRevertButton(key, item)}
                  {renderEditable(key, item)}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  };

  const data = summary.data;
  const body = summary.isPending ? (
    <CalmSkeleton variant="lines" rows={6} label="正在生成总结" />
  ) : summary.isError ? (
    <Alert
      type="error"
      title="生成总结失败，请重试。"
      action={<Button onClick={() => void summary.refetch()}>重试</Button>}
    />
  ) : detail && data !== undefined ? (
    <div className="summary-detail">
      <div className="summary-stat-grid">
        <div>
          <span>迭代记录</span>
          <strong>{data.totals.recordCount}</strong>
        </div>
        <div>
          <span>已完成任务</span>
          <strong>{data.totals.completedTaskCount}</strong>
        </div>
        <div>
          <span>涉及项目 / 模块</span>
          <strong>
            {data.totals.projectCount} / {data.totals.moduleCount}
          </strong>
        </div>
        <div>
          <span>遗留问题（未处理）</span>
          <strong>
            {data.totals.leftoverCount}（
            {data.totals.leftoverCount - data.totals.closedLeftoverCount}）
          </strong>
        </div>
        <div>
          <span>缺口任务</span>
          <strong>{data.totals.missingRecordTaskCount}</strong>
        </div>
      </div>
      <table className="summary-detail-table">
        <thead>
          <tr>
            <th className="summary-detail-toggle-head" aria-label="展开详情" />
            <th>编号</th>
            <th>项目 / 模块</th>
            <th>标题与效果</th>
            <th>作者</th>
            <th>发布日</th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point) => {
            const expanded = expandedRecordId === point.recordId;
            return (
              <React.Fragment key={point.recordId}>
                {/*
                  整行可点：总结明细用于核对取数，展开即读记录正文的三段完整文本
                  与遗留问题（正文比要点里的效果句长得多，要点被折叠并截断到 1000 字）。
                */}
                <tr
                  className={
                    expanded
                      ? "summary-detail-row is-expanded"
                      : "summary-detail-row"
                  }
                  onClick={() => {
                    toggleRecord(point.recordId);
                  }}
                >
                  <td className="summary-detail-toggle">
                    <button
                      type="button"
                      className="summary-detail-toggle-button"
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? `收起 ${point.recordCode} 的详细内容`
                          : `展开 ${point.recordCode} 的详细内容`
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleRecord(point.recordId);
                      }}
                    >
                      <InpulseIcon
                        name="chevron"
                        size={14}
                        {...(expanded ? { className: "expanded" } : {})}
                      />
                    </button>
                  </td>
                  <td>{point.recordCode}</td>
                  <td>
                    {point.projectName} / {point.moduleName}
                  </td>
                  <td>
                    <b>{point.title}</b>
                    <small>{point.detail}</small>
                  </td>
                  <td>{point.author.name}</td>
                  <td>{beijingDayKey(point.publishedAt)}</td>
                </tr>
                {expanded ? (
                  <tr className="summary-detail-expanded">
                    <td colSpan={6}>
                      {/*
                        只读复用正式记录详情（B-3a）：同一查询键
                        ["published-record", projectId, recordId]，详情已加载过时命中缓存，
                        只读形态不发版本、GitHub 与任何写入请求。
                      */}
                      <PublishedRecordDetail
                        projectId={point.projectId}
                        recordId={point.recordId}
                        client={client}
                        writable={false}
                        readOnly
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : aiDocument !== null ? (
    assistBody
  ) : document === null ? null : (
    <article
      className="summary-doc summary-ai-doc"
      data-source="local"
      ref={localDocRef}
    >
      <h3
        className="summary-ai-sec"
        data-edited={
          edited[localEditKey("title")] === undefined ? "false" : "true"
        }
      >
        {renderRevertButton(localEditKey("title"), document.title)}
        {renderEditable(localEditKey("title"), document.title)}
      </h3>
      <p className="summary-scope">{document.scopeLine}</p>
      {document.blocks.map(renderBlock)}
      <p
        className="summary-note summary-ai-sec"
        data-edited={
          edited[localEditKey("note")] === undefined ? "false" : "true"
        }
      >
        {renderRevertButton(localEditKey("note"), document.note)}
        {renderEditable(localEditKey("note"), document.note)}
      </p>
    </article>
  );

  return (
    <AppModal
      open={open}
      onCancel={onClose}
      size="xl"
      title="生成总结"
      closeLabel="关闭生成总结"
      className="record-summary-modal"
      headerActions={
        <div className="summary-ai-slot" ref={aiSlotRef}>
          <button
            type="button"
            className="summary-ai-trigger"
            aria-label="AI 助手"
            aria-expanded={aiOpen}
            aria-haspopup="dialog"
            onClick={() => {
              setAiOpen((current) => !current);
            }}
          >
            ✦ AI 助手
          </button>
          {aiOpen ? (
            <div className="summary-ai-pop" role="dialog" aria-label="AI 助手">
              <div className="summary-ai-reqbox">
                <textarea
                  ref={aiRequestRef}
                  className="summary-ai-request"
                  aria-label="对总结的要求"
                  spellCheck={false}
                  maxLength={500}
                  value={requirement}
                  onChange={(event) => {
                    setRequirement(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      void runAssist();
                    }
                  }}
                />
                {requirement === "" ? null : (
                  <button
                    type="button"
                    className="summary-ai-clear"
                    title="清空"
                    aria-label="清空要求"
                    onClick={() => {
                      setRequirement("");
                      aiRequestRef.current?.focus();
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="summary-ai-chips">
                {requirementChips.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className={
                      requirement.includes(suggestion)
                        ? "summary-ai-chip on"
                        : "summary-ai-chip"
                    }
                    aria-pressed={requirement.includes(suggestion)}
                    title={lastRequirement === "" ? undefined : "来自上次要求"}
                    onClick={() => {
                      setRequirement((current) =>
                        current.includes(suggestion)
                          ? removeRequirementFragment(current, suggestion)
                          : appendRequirement(current, suggestion),
                      );
                      aiRequestRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              {assist.isError ? (
                <p className="summary-ai-error" role="alert">
                  {describeRecordSummaryAssistError(assist.error)}
                </p>
              ) : null}
              <div className="summary-ai-bar">
                <span className="summary-ai-applied">
                  {requirement.trim() === ""
                    ? "还没提要求：将按现有结构生成"
                    : "将按这句要求改写当前范围"}
                </span>
                <span className="summary-ai-actions">
                  <span
                    className={
                      requirement.length > 450
                        ? "summary-ai-count warn"
                        : "summary-ai-count"
                    }
                  >
                    {String(requirement.length)}/500
                  </span>
                  <button
                    type="button"
                    className="summary-ai-generate"
                    disabled={assist.isPending || document === null}
                    onClick={() => {
                      void runAssist();
                    }}
                  >
                    <span aria-hidden="true">✦ </span>
                    {assist.isPending ? "生成中…" : "生成总结"}
                    <span aria-hidden="true">
                      {" "}
                      <kbd>Ctrl ⏎</kbd>
                    </span>
                  </button>
                </span>
              </div>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="summary-shell">
        {filters}
        <div className="summary-scroll">{body}</div>
      </div>
      <div className="calm-action-footer">
        <span className="footer-leading summary-footer-count">
          {data === undefined
            ? summary.isError
              ? "取数失败"
              : "正在取数"
            : `${detail ? "明细" : "已归纳"} ${String(
                data.totals.recordCount,
              )} 条迭代记录`}
          {editedCount === 0 ? null : (
            <Button
              type="link"
              size="small"
              className="summary-revert-link"
              onClick={revertAll}
            >
              撤销手动修改
            </Button>
          )}
        </span>
        <Button
          onClick={() => setDetail((prev) => !prev)}
          disabled={data === undefined}
        >
          {detail ? "返回总结" : "查看明细"}
        </Button>
        <Button
          onClick={() => {
            // 已有 AI 正文时「重新生成」重跑同一条要求；否则重取事实。
            if (aiDocument === null) void summary.refetch();
            else void runAssist();
          }}
          loading={summary.isFetching || assist.isPending}
        >
          重新生成
        </Button>
        {/* 「复制正文」永远是底栏最后一个按钮（用户 2026-10-15 要求）：新增动作一律排在它左侧。 */}
        <Button
          type="primary"
          disabled={document === null}
          onClick={() => void copy()}
        >
          {copyState === "done"
            ? "已复制"
            : copyState === "failed"
              ? "复制失败"
              : detail
                ? "复制明细 Markdown"
                : "复制正文"}
        </Button>
      </div>
    </AppModal>
  );
}
