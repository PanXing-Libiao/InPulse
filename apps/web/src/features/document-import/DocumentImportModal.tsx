import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Popover } from "antd";
import { useNavigate } from "react-router-dom";
import {
  ApiError,
  type InpulseApiClient,
  type ProjectDocumentImportPreviewResponse,
  type ProjectDocumentImportResult,
  type UserDirectoryItem,
} from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { avatarColorOf } from "@features/common/components/CalmSelect";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { useUserDirectoryQuery } from "@features/users/user-directory-query";
import {
  buildDocumentDraftView,
  findDocumentDraftField,
  insertDocumentDraftField,
  lastNodeLineIndex,
  parseDocumentDraft,
  serializeDocumentDraft,
  setDocumentDraftValue,
  type DocumentDraftFieldView,
  type DocumentDraftTaskView,
  type DocumentDraftView,
} from "./document-draft";
import {
  buildDocumentAssigneeQuestion,
  buildDocumentAssigneeSupplement,
  checkDocumentMemberCoverage,
  collectDocumentAssigneeNames,
  isDocumentMemberFieldName,
  matchDocumentAssignees,
  memberTagsFromValue,
  normalizeName,
  PROJECT_MEMBER_FIELD_NAMES,
  serializeMemberTags,
  suggestDirectoryMembers,
  type DocumentAssigneeUnmatched,
  type DocumentMemberCoverageContext,
} from "./document-assignee-match";
import {
  describeDocumentImportAssistError,
  describeDocumentImportError,
  documentImportIssuesFromError,
  DOCUMENT_IMPORT_MAX_TEXT_LENGTH,
  useApplyDocumentImport,
  useAssistDocumentImport,
  usePreviewDocumentImport,
  type DocumentImportIssueView,
  type DocumentImportMode,
} from "./document-import-query";
import {
  DOCUMENT_EXTRACTION_ACCEPT,
  DocumentExtractionError,
  extractDocumentText,
  type ExtractedDocumentText,
} from "./document-text-extraction";

const ISSUE_DISPLAY_LIMIT = 20;

type Stage = "INPUT" | "PREVIEW";
/** 左栏视图：结构化草稿 / 文本原文；空态另有拖入区（由 hasContent 决定）。 */
type LeftView = "DRAFT" | "RAW";

interface AssistMessage {
  readonly role: "AI" | "USER";
  readonly text: string;
}

interface MissingItem {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly severity: "ERROR" | "WARNING";
  /** 缺在哪几条（模块 / 功能 / 任务的名字，最多 3 个）：只说「功能说明 ×1」用户还得自己翻。 */
  readonly where: readonly string[];
}
/** 「缺在哪几条」最多点几个名，多了缀「等」。 */
const MAX_MISSING_WHERE = 3;

const ASSIGNEE_FIELD = "负责人";
/** 各层级的标准字段（模板版本 1）：缺哪个就在草稿里补一个空行。 */
const PROJECT_FIELDS = ["项目编码", "项目说明", "项目成员"] as const;
const MODULE_FIELDS = ["说明"] as const;
const FEATURE_FIELDS = ["当前说明", "验收标准", "标签"] as const;
const TASK_FIELDS = ["负责人", "优先级", "截止", "描述"] as const;
const MODULE_TASK_EXTRA_FIELDS = ["影响功能"] as const;
/** 必填字段（不补服务端会拒绝）：与 computeMissingItems 里的 ERROR 项一一对应。 */
const PROJECT_REQUIRED_FIELDS = ["项目编码", "项目成员"] as const;
/** 字段名的历史别名：旧模板把成员字段写成「初始成员」，读草稿时要一并认。 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  项目成员: PROJECT_MEMBER_FIELD_NAMES,
};
const TASK_REQUIRED_FIELDS = ["负责人"] as const;

function fieldValue(
  fields: readonly DocumentDraftFieldView[],
  name: string,
): string {
  return (findDocumentDraftField(fields, name)?.value ?? "").trim();
}

function countEmpty(
  rows: readonly { readonly fields: readonly DocumentDraftFieldView[] }[],
  name: string,
): number {
  return rows.filter((row) => fieldValue(row.fields, name).length === 0).length;
}

/** 空字段所在条目的名字（最多 MAX_MISSING_WHERE 个），用于告诉用户「补哪几条」。 */
function emptyWhere<
  T extends { readonly fields: readonly DocumentDraftFieldView[] },
>(
  rows: readonly T[],
  name: string,
  nameOf: (row: T) => string,
): readonly string[] {
  return rows
    .filter((row) => fieldValue(row.fields, name).length === 0)
    .slice(0, MAX_MISSING_WHERE)
    .map(nameOf);
}

/**
 * 名单值里是不是已经写了创建者（姓名或登录名都认）。写了就不再挂锁定标签——同一个人显示
 * 两遍反而像重复添加；用户把 TA 从名单里删掉时锁定标签会自己回来，正好是「删了也在」的手感。
 */
function memberValueHasCreator(
  value: string,
  name: string,
  loginName: string,
): boolean {
  const tokens = memberTagsFromValue(value).map((item) => normalizeName(item));
  return [name, loginName].some((candidate) => {
    const token = normalizeName(candidate);
    return token.length > 0 && tokens.includes(token);
  });
}

function collectDraftTasks(
  view: DocumentDraftView,
): readonly DocumentDraftTaskView[] {
  const tasks: DocumentDraftTaskView[] = [];
  for (const module of view.modules) {
    tasks.push(...module.tasks);
    for (const feature of module.features) tasks.push(...feature.tasks);
  }
  return tasks;
}

/**
 * 确定性完整性检查：必补项是服务端一定会拒绝的（缺负责人 / 整项目缺项目编码），
 * 建议项只是提醒。模型不参与，「还差几处」任何时候都能算出来。
 */
/**
 * 成员名单两项校验：缺项目成员 / 项目成员缺任务负责人（ADR-072；ADR-073 起创建者
 * 默认就算成员，不再单列一条缺口）。与服务端 preparePlan 的 NEW_PROJECT 分支同一口径
 * （那边是最终裁决）。
 */
function memberMissingItems(
  view: DocumentDraftView,
  mode: DocumentImportMode,
  members: DocumentMemberCoverageContext,
): readonly MissingItem[] {
  const coverage = checkDocumentMemberCoverage(view, mode, members);
  if (coverage.memberRequired) {
    return [
      {
        key: "member",
        label: "缺项目成员",
        count: 1,
        severity: "ERROR",
        where: [],
      },
    ];
  }
  const items: MissingItem[] = [];
  if (coverage.missingAssignees.length > 0) {
    items.push({
      key: "memberAssignee",
      label: "项目成员缺任务负责人",
      count: coverage.missingAssignees.length,
      severity: "ERROR",
      where: coverage.missingAssignees.slice(0, MAX_MISSING_WHERE),
    });
  }
  return items;
}

function computeMissingItems(
  view: DocumentDraftView,
  mode: DocumentImportMode,
  members: DocumentMemberCoverageContext,
): readonly MissingItem[] {
  const items: MissingItem[] = [];
  const tasks = collectDraftTasks(view);
  const features = view.modules.flatMap((module) => module.features);
  const taskWhere = (fieldName: string): readonly string[] =>
    emptyWhere(tasks, fieldName, (task) => task.title);
  // 每条都带上「缺在哪几条」，用户不必拿着「功能说明 ×1」自己去翻。
  const assignee = countEmpty(tasks, ASSIGNEE_FIELD);
  if (assignee > 0) {
    items.push({
      key: "assignee",
      label: "缺负责人",
      count: assignee,
      severity: "ERROR",
      where: taskWhere(ASSIGNEE_FIELD),
    });
  }
  if (mode === "NEW_PROJECT") {
    if (view.project === null) {
      items.push({
        key: "project",
        label: "缺项目段",
        count: 1,
        severity: "ERROR",
        where: [],
      });
    } else if (fieldValue(view.project.fields, "项目编码").length === 0) {
      items.push({
        key: "code",
        label: "缺项目编码",
        count: 1,
        severity: "ERROR",
        where: [],
      });
    }
    // 成员名单校验只在「有项目段」时有意义：缺项目段已经单独报了一条。
    items.push(...memberMissingItems(view, mode, members));
  }
  const moduleDescription = countEmpty(view.modules, "说明");
  if (moduleDescription > 0) {
    items.push({
      key: "moduleDescription",
      label: "模块说明",
      count: moduleDescription,
      severity: "WARNING",
      where: emptyWhere(view.modules, "说明", (module) => module.name),
    });
  }
  const featureDescription = countEmpty(features, "当前说明");
  if (featureDescription > 0) {
    items.push({
      key: "featureDescription",
      label: "功能说明",
      count: featureDescription,
      severity: "WARNING",
      where: emptyWhere(features, "当前说明", (feature) => feature.name),
    });
  }
  const due = countEmpty(tasks, "截止");
  if (due > 0) {
    items.push({
      key: "due",
      label: "截止时间",
      count: due,
      severity: "WARNING",
      where: taskWhere("截止"),
    });
  }
  const description = countEmpty(tasks, "描述");
  if (description > 0) {
    items.push({
      key: "description",
      label: "任务描述",
      count: description,
      severity: "WARNING",
      where: taskWhere("描述"),
    });
  }
  return items;
}

function countLabel(counts: DocumentDraftView["counts"]): string {
  return (
    "已整理 " +
    String(counts.modules) +
    " 模块 · " +
    String(counts.features) +
    " 功能 · " +
    String(counts.tasks) +
    " 任务"
  );
}

/**
 * 助手挂在对话区顶部的那句话：头部已经显示「已整理 N 模块 · N 功能 · N 任务」，
 * 这里不再重复计数，改为主动说清还缺哪些信息、怎么补；都齐了就直接说齐了。
 * 必填项（不补会被服务端拒绝，ERROR）与建议项（只影响完整度，WARNING）都逐条点名：
 * 之前建议项只说「N 处，见下方标签」，而下方标签只是个不可点的计数，用户看完仍不知道
 * 到底要补什么（追问「要补充什么」）。由当前草稿实时算出，所以补完字段会立刻改口。
 */
function buildAssistGapReport(items: readonly MissingItem[]): string {
  const gaps = describeGaps(items);
  if (gaps === null) {
    return "文档已按模板整理好，必填信息都齐了，可以直接点「预览」。";
  }
  return (
    "文档已按模板整理好。" +
    gaps +
    "。直接在这里补充就行，例如「订单查询要在本周五前完成」。"
  );
}

/** 缺口指纹：只关心「哪一项、几个」，用来判断重算之后结论有没有变。 */
function gapSignature(items: readonly MissingItem[]): string {
  return items.map((item) => item.key + ":" + String(item.count)).join("|");
}

/**
 * 缺口明细，例如「缺负责人 ×1（修复重复回调）、功能说明 ×2（退款、查询）」。
 * 附上条目名，用户才知道要去哪一条补；超过 3 条缀「等」。
 */
function gapDetail(items: readonly MissingItem[]): string {
  return items
    .map((item) => {
      const more = item.count > item.where.length ? "等" : "";
      const where =
        item.where.length === 0
          ? ""
          : "（" + item.where.join("、") + more + "）";
      return item.label + " ×" + String(item.count) + where;
    })
    .join("、");
}

function gapTotal(items: readonly MissingItem[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

/**
 * 导入落地后助手主动汇报的一句：还差多少处需要补充、多少名字待确认，或要素已完好。
 * 只报「需要补充」与「待确认」两个量，不重复头部的模块 / 功能 / 任务规模计数：
 * 「缺口」由本地确定性检查算出，「待确认」是姓名对不上成员账号的那些名字。
 */
function buildImportSummary(
  items: readonly MissingItem[],
  unmatchedCount: number,
): string {
  const gaps = gapTotal(items);
  if (gaps === 0 && unmatchedCount === 0) {
    return "已进入内容梳理：要素完好，可以直接点「预览」导入。";
  }
  const parts: string[] = [
    gaps === 0 ? "要素已齐" : "需要补充 " + String(gaps) + " 处",
  ];
  if (unmatchedCount > 0) {
    parts.push("待确认 " + String(unmatchedCount) + " 个名字");
  }
  return "已进入内容梳理：" + parts.join("、") + "。";
}

/**
 * 缺口说明：必填（ERROR）与建议（WARNING）都逐条点名；都齐了返回 null。
 * 顶部常驻结论与「用户提问后的回复」共用这段口径，免得同一件事在两个地方各说各的。
 */
function describeGaps(items: readonly MissingItem[]): string | null {
  if (items.length === 0) return null;
  const must = items.filter((item) => item.severity === "ERROR");
  const suggest = items.filter((item) => item.severity === "WARNING");
  const parts: string[] = [];
  if (must.length > 0) {
    // 用「：明细」而不是「（明细）」：明细里已经带条目名括号，再套一层读不清。
    parts.push(
      "必填还差 " + String(gapTotal(must)) + " 处：" + gapDetail(must),
    );
  }
  if (suggest.length > 0) {
    // 逐条点名，不再写「见下方标签」：那个标签只是不可点的计数，说了等于没说。
    parts.push(
      "另有 " +
        String(gapTotal(suggest)) +
        " 处建议补齐：" +
        gapDetail(suggest),
    );
  }
  return parts.join("；");
}

/**
 * 用户每说一句，助手都要在对话里回一句。此前用户发的话只被当成「补充说明」拼进文档
 * 重跑一次，对话里不留任何回应，提「要补充什么」时看起来就是不理人。回复由当前草稿
 * 确定性算出（不额外调模型）。
 *
 * 只点名**必填**缺口：建议补齐（WARNING）那些项由顶部常驻结论与下方标签承载。
 * 2026-10-14 第三轮反馈「这个可选择性的补充重复次数太多了，不要每一次我和 ai 讲话就
 * 提醒我一下那些可以选择增加」——每轮复读同一份建议清单纯属噪音。
 */
function gapReplySentence(must: readonly MissingItem[]): string {
  return (
    "必填还差 " +
    String(gapTotal(must)) +
    " 处：" +
    gapDetail(must) +
    "。左栏对应位置点「＋」可以直接填，也可以用一句话告诉我。"
  );
}

function buildAssistReply(items: readonly MissingItem[]): string {
  if (items.length === 0) {
    return "我重新核对了一遍：必填和完整度都没问题了，可以直接点「预览」导入。";
  }
  const must = items.filter((item) => item.severity === "ERROR");
  if (must.length === 0) return "我重新核对了一遍：必填都齐了。";
  return "我重新核对了一遍：" + gapReplySentence(must);
}

/**
 * 必填缺口指纹：建议项变化不再触发「每轮一句」的复读，只有必填项增减 / 数量变化才再说一次。
 */
function requiredGapSignature(items: readonly MissingItem[]): string {
  return gapSignature(items.filter((item) => item.severity === "ERROR"));
}

/** 逐行比较用的规整化：去掉行首缩进与结尾空白，空行不参与比较。 */
function normalizeDraftLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 只展示行首的标记与 30 个字：字段行的 "- "、标题行的 "# " 都不是用户要读的内容。 */
function quoteDraftLine(line: string): string {
  const stripped = line.replace(/^[-#>\s]+/, "").replace(/\s+/g, " ");
  return (
    "「" +
    (stripped.length > 30 ? stripped.slice(0, 30) + "…" : stripped) +
    "」"
  );
}

function describeDraftLines(lines: readonly string[]): string {
  const head = lines.slice(0, 3).map(quoteDraftLine).join("、");
  return lines.length > 3 ? head + " 等" : head;
}

interface DraftLineRewrite {
  readonly before: string;
  readonly after: string;
}

const DRAFT_FIELD_LABELS: Readonly<Record<string, string>> = {
  当前说明: "功能说明",
  说明: "模块说明",
  描述: "任务描述",
  截止: "截止时间",
};

function strippedDraftLine(line: string): string {
  return line.replace(/^[-#>\s]+/, "").replace(/\s+/g, " ");
}

function draftLineFieldLabel(line: string): string | null {
  const match = strippedDraftLine(line).match(/^([^：:]{1,12})[：:]/u);
  return match?.[1]?.trim() ?? null;
}

function draftLineBigrams(line: string): Set<string> {
  const text = strippedDraftLine(line).replace(/\s+/g, "");
  if (text.length <= 2) {
    return new Set(text.length === 0 ? [] : [text]);
  }
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

function diceSimilarity(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const gram of left) {
    if (right.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (left.size + right.size);
}

/**
 * 同一字段内的删除行 / 新增行先按相似度配对，再判改写。
 * 模型返回的是整份草稿，重写一条说明会同时产生一条「删除」和一条「新增」；
 * 不配对就会出现「同一句话既新增又删除」的假象。
 */
function pairDraftRewrites(
  removed: readonly string[],
  added: readonly string[],
): {
  readonly rewrites: readonly DraftLineRewrite[];
  readonly addedRest: readonly string[];
  readonly removedRest: readonly string[];
} {
  const usedAdded = new Set<number>();
  const usedRemoved = new Set<number>();
  const removedGrams = removed.map(draftLineBigrams);
  const addedGrams = added.map(draftLineBigrams);
  const rewrites: DraftLineRewrite[] = [];

  removed.forEach((before, removedIndex) => {
    const beforeField = draftLineFieldLabel(before);
    let bestIndex = -1;
    let bestScore = 0;
    added.forEach((after, addedIndex) => {
      if (usedAdded.has(addedIndex)) return;
      const afterField = draftLineFieldLabel(after);
      if (
        beforeField !== null &&
        afterField !== null &&
        beforeField !== afterField
      ) {
        return;
      }
      const score = diceSimilarity(
        removedGrams[removedIndex]!,
        addedGrams[addedIndex]!,
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = addedIndex;
      }
    });
    if (bestIndex >= 0 && bestScore >= 0.45) {
      usedRemoved.add(removedIndex);
      usedAdded.add(bestIndex);
      rewrites.push({ before, after: added[bestIndex]! });
    }
  });

  return {
    rewrites,
    addedRest: added.filter((_line, index) => !usedAdded.has(index)),
    removedRest: removed.filter((_line, index) => !usedRemoved.has(index)),
  };
}

function describeRewriteFields(rewrites: readonly DraftLineRewrite[]): string {
  const counts = new Map<string, number>();
  for (const rewrite of rewrites) {
    const rawLabel = draftLineFieldLabel(rewrite.before) ?? "内容";
    const label = DRAFT_FIELD_LABELS[rawLabel] ?? rawLabel;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([label, count]) => "「" + label + "」" + String(count) + " 处")
    .join("、");
}

function quoteRewritePair(rewrite: DraftLineRewrite): string {
  const before = strippedDraftLine(rewrite.before);
  const after = strippedDraftLine(rewrite.after);
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  const start = Math.max(0, prefix - 10);
  const clip = (text: string): string => {
    const part = text.slice(start, start + 48);
    return (
      (start > 0 ? "…" : "") + part + (text.length > start + 48 ? "…" : "")
    );
  };
  return "「" + clip(before) + "」→「" + clip(after) + "」";
}

/**
 * 用户每发一句之后，左栏草稿到底变了什么：模型跑十几秒，用户盯的是左栏，
 * 而左栏可能只多出一行——不说清就等于「点了发送、什么都没发生」（2026-10-14
 * 用户反馈：「为什么我让ai补上但是左边并没有反应」，当时这轮其实已经写入成员）。
 * 先配对相似行判为「改写」，剩下才是真正的新增 / 去掉；最多各点三条原文，避免长报告。
 */
function describeDraftChange(base: string, next: string): string {
  if (base === next) {
    return "这一轮草稿没有变化：补充说明没被写进模板。可以换个说法再发一次，或直接在左栏对应位置点「＋」自己填。";
  }
  const baseLines = new Set(normalizeDraftLines(base));
  const nextLines = new Set(normalizeDraftLines(next));
  const added = [...nextLines].filter((line) => !baseLines.has(line));
  const removed = [...baseLines].filter((line) => !nextLines.has(line));
  const head = "已按补充说明更新草稿：";
  if (added.length === 0 && removed.length === 0) {
    return head + "内容有改动。";
  }
  const { rewrites, addedRest, removedRest } = pairDraftRewrites(
    removed,
    added,
  );
  const parts: string[] = [];
  if (rewrites.length > 0) {
    const fields = describeRewriteFields(rewrites);
    parts.push(
      "改写 " +
        String(rewrites.length) +
        " 处" +
        (fields.length > 0 ? "（" + fields + "）" : "") +
        "：" +
        quoteRewritePair(rewrites[0]!),
    );
  }
  if (addedRest.length > 0) {
    parts.push(
      "新增 " +
        String(addedRest.length) +
        " 行：" +
        describeDraftLines(addedRest),
    );
  }
  if (removedRest.length > 0) {
    parts.push(
      "去掉 " +
        String(removedRest.length) +
        " 行：" +
        describeDraftLines(removedRest),
    );
  }
  return head + parts.join("；") + "。";
}

/** 已经是模板（有项目段或有模块段）的文档本地直接解析，不必消耗模型。 */
function looksLikeTemplate(view: DocumentDraftView): boolean {
  return view.project !== null || view.modules.length > 0;
}

const PRIORITY_LABELS: Readonly<Record<string, string>> = {
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};

/** 按姓名字串过滤成员目录（目录一次最多 300 人，做个本地的「打一个字就筛」）。 */
function filterDirectoryByName(
  members: readonly UserDirectoryItem[],
  query: string,
): readonly UserDirectoryItem[] {
  const needle = query.trim();
  return needle.length === 0
    ? members
    : members.filter((member) => member.name.includes(needle));
}

/**
 * 「从成员里挑」候选面板：此前是一整片平铺按钮，人多时既难扫也难挑；
 * 2026-10-16 用户要求「打名字的其中一个字就把相关的筛出来」，这里补一个搜索框。
 * 只按姓名子串过滤，不新增接口（目录本来就是一次取回的本地数据）。
 */
const MemberPickerPanel: React.FC<{
  readonly members: readonly UserDirectoryItem[];
  readonly query: string;
  readonly disabled: boolean;
  readonly onQueryChange: (next: string) => void;
  readonly onPick: (name: string) => void;
}> = ({ members, query, disabled, onQueryChange, onPick }) => {
  const filtered = filterDirectoryByName(members, query);
  return (
    <div className="import-member-picker">
      <input
        aria-label="搜索成员"
        className="import-member-search"
        value={query}
        disabled={disabled}
        placeholder="输入姓名里的一个字，例如「陈」"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div className="import-member-cands">
        {filtered.map((member) => (
          <Button
            key={member.id}
            size="small"
            disabled={disabled}
            onClick={() => onPick(member.name)}
          >
            {member.name}
          </Button>
        ))}
        {filtered.length === 0 ? (
          <span className="import-member-empty">
            没有匹配的成员，换个字再试。
          </span>
        ) : null}
      </div>
    </div>
  );
};

export interface DocumentImportModalProps {
  readonly open: boolean;
  readonly mode: DocumentImportMode;
  readonly projectId?: number | undefined;
  readonly client?: InpulseApiClient | undefined;
  readonly onClose: () => void;
  readonly onImported: (result: ProjectDocumentImportResult) => void;
}

/**
 * ADR-064 固定模板导入（粘贴 / 本地文本文件 → 只读预览 → 单事务执行），
 * ADR-067 追加 AI 辅助转换，ADR-071 把输入态改造成左右分栏工作台：
 * 左栏是「点哪改哪」的结构化草稿（内容梳理 / 预览文档两个页签），右栏是 AI 助手
 * 的追问对话与待确认成员。补充说明不新增接口：原始文档与逐轮补充拼成一段，
 * 再调用同一条 assistDocumentImport 路由；AI 草稿永不直接写库。
 */
export const DocumentImportModal: React.FC<DocumentImportModalProps> = ({
  open,
  mode,
  projectId,
  client,
  onClose,
  onImported,
}) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canConfigureAiAssist = user?.isAdmin === true;
  /** ADR-073：创建者（= 本次导入人）默认就是成员，草稿里挂一枚锁定标签给用户看。 */
  const creatorMemberName = user?.name?.trim() ?? "";
  const creatorMemberLogin = user?.loginName?.trim() ?? "";
  const [stage, setStage] = useState<Stage>("INPUT");
  const [documentText, setDocumentText] = useState("");
  const [preview, setPreview] =
    useState<ProjectDocumentImportPreviewResponse | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [leftView, setLeftView] = useState<LeftView>("DRAFT");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [editingFieldName, setEditingFieldName] = useState<string | null>(null);
  // 成员字段按标签编辑：editingTags 是已写定的名字，editingValue 只装末尾输入框里
  // 「正在输入的那一段」；文本字段没有标签，整格就是 editingValue。
  const [editingTags, setEditingTags] = useState<readonly string[]>([]);
  const [editingValue, setEditingValue] = useState("");
  // 右栏 AI 助手：messages 是对话日志，supplements 是逐轮补充说明；
  // assistSourceText 是「预览文档」对照的原文（上传文件的抽取结果 / 首次分析前的粘贴文本），
  // 分析输入用的是当前左栏草稿，两者不共用一份状态。
  const [messages, setMessages] = useState<readonly AssistMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [supplements, setSupplements] = useState<readonly string[]>([]);
  const [assistSourceText, setAssistSourceText] = useState<string | null>(null);
  const [assistSourceName, setAssistSourceName] = useState<string | null>(null);
  const [assistWarning, setAssistWarning] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [assistIssues, setAssistIssues] = useState<
    readonly DocumentImportIssueView[]
  >([]);
  const [assistExtracting, setAssistExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [appliedDraftText, setAppliedDraftText] = useState<string | null>(null);
  const [memberPicker, setMemberPicker] = useState<string | null>(null);
  const previewMutation = usePreviewDocumentImport({ mode, projectId, client });
  const applyMutation = useApplyDocumentImport({ mode, projectId, client });
  const assistMutation = useAssistDocumentImport({ mode, client });
  const draftLines = useMemo(
    () => parseDocumentDraft(documentText),
    [documentText],
  );
  const draftView = useMemo(
    () => buildDocumentDraftView(draftLines),
    [draftLines],
  );
  const hasContent = documentText.trim().length > 0;
  /** 「从成员里挑」面板的搜索词：换一个待确认名字时清空，避免下次开面板还带着上次的字。 */
  const [memberPickerQuery, setMemberPickerQuery] = useState("");
  const directoryQuery = useUserDirectoryQuery({
    client,
    enabled: open && hasContent,
  });
  const directory: readonly UserDirectoryItem[] = directoryQuery.data ?? [];
  const assigneeNames = useMemo(
    () => collectDocumentAssigneeNames(draftView),
    [draftView],
  );
  const assigneeMatch = useMemo(
    () => matchDocumentAssignees(assigneeNames, directory),
    [assigneeNames, directory],
  );
  // 目录还没回来（或不可用）时不做判断，避免把所有人都报成「对不上」。
  const assigneeChecked =
    !directoryQuery.isPending &&
    !directoryQuery.isError &&
    directory.length > 0;
  const unmatched: readonly DocumentAssigneeUnmatched[] = assigneeChecked
    ? assigneeMatch.unmatched
    : [];
  // 成员名单校验的输入：创建者（= 本次导入人，默认算成员）与用户目录。
  const memberContext = useMemo<DocumentMemberCoverageContext>(
    () => ({
      creator:
        user === null || user === undefined
          ? null
          : { id: user.id, name: user.name, loginName: user.loginName },
      directory,
    }),
    [user, directory],
  );
  // 空态还没有文档：不显示「缺项目段」这类由文档本身决定的项目。
  const missingItems = useMemo(
    () =>
      hasContent ? computeMissingItems(draftView, mode, memberContext) : [],
    [draftView, mode, hasContent, memberContext],
  );

  // 助手主动开口的那句话：只要有内容就一直挂在这里，随草稿实时更新，
  // 不必等用户先跟它说话，也不会停留在「分析那一刻」的旧结论。
  const draftStructured =
    draftView.project !== null || draftView.modules.length > 0;
  const assistVerdict = !hasContent
    ? null
    : draftStructured
      ? buildAssistGapReport(missingItems)
      : "这份内容还没整理成模板结构（没有项目段或模块段）。点「交给 AI 整理」我会归纳出模块、功能与任务；也可以自己按层级补上项目段与模块段。";

  /**
   * 导入落地后助手主动汇报一次：还差多少处要补、多少名字待确认，或要素已完好。
   * 汇报键只跟着「一次落地」走：导入 / AI 整理落地看 appliedDraftText（用户发言那几轮
   * 由 appendAssistReply 先把键标成已汇报，免得同屏出现两条），直接粘贴的结构化草稿看
   * STRUCTURED 这个常量；用户之后手改草稿不会重复刷屏。
   * 成员目录未就绪时先等它回来再开口，免得先说「要素完好」、目录回来又改口。
   */
  const announcedImportRef = useRef<string | null>(null);
  /** 导入 / 整理「落地」的汇报键：一次落地一个键，键没变就不再开口。 */
  const appliedLandingKey = (text: string): string => "APPLIED:" + text;
  /** 已经念过的缺口状态（gapSignature）：缺口没变就不再念第二遍。 */
  const announcedGapReplyRef = useRef<string | null>(null);
  useEffect(() => {
    const landingKey =
      appliedDraftText !== null
        ? appliedLandingKey(appliedDraftText)
        : draftStructured
          ? "STRUCTURED"
          : null;
    if (landingKey === null) {
      announcedImportRef.current = null;
      return;
    }
    if (directoryQuery.isPending) return;
    if (announcedImportRef.current === landingKey) return;
    announcedImportRef.current = landingKey;
    setMessages((current) => [
      ...current,
      {
        role: "AI",
        text: buildImportSummary(missingItems, unmatched.length),
      },
    ]);
  }, [
    appliedDraftText,
    draftStructured,
    directoryQuery.isPending,
    missingItems,
    unmatched,
  ]);

  const askedQuestionRef = useRef<string | null>(null);
  useEffect(() => {
    if (unmatched.length === 0) {
      askedQuestionRef.current = null;
      return;
    }
    const signature = unmatched.map((item) => item.name).join("|");
    if (askedQuestionRef.current === signature) return;
    askedQuestionRef.current = signature;
    const question = buildDocumentAssigneeQuestion(unmatched);
    if (question === null) return;
    setMessages((current) => [...current, { role: "AI", text: question }]);
  }, [unmatched]);

  useEffect(() => {
    if (!open) return;
    askedQuestionRef.current = null;
    announcedImportRef.current = null;
    announcedGapReplyRef.current = null;
    setStage("INPUT");
    setDocumentText("");
    setPreview(null);
    setLocalError(null);
    setLeftView("DRAFT");
    setPasteOpen(false);
    setEditingLine(null);
    setEditingValue("");
    setMessages([]);
    setComposer("");
    setSupplements([]);
    setAssistSourceText(null);
    setAssistSourceName(null);
    setAssistWarning(null);
    setAssistError(null);
    setAssistIssues([]);
    setAssistExtracting(false);
    setDragging(false);
    setAppliedDraftText(null);
    setMemberPicker(null);
    previewMutation.reset();
    applyMutation.reset();
    assistMutation.reset();
  }, [open]);

  /**
   * 空态点「直接粘贴文本」后光标直接落在文本区，用户接着 Ctrl+V 就行，不用再点一下输入框。
   * 这一帧文本区还挂在 .import-draft-raw.is-hidden（display:none）下，所以要在提交之后、
   * className 已经换成可见时再聚焦。
   */
  useEffect(() => {
    if (!pasteOpen) return;
    pasteTextareaRef.current?.focus();
  }, [pasteOpen]);

  const issues: readonly DocumentImportIssueView[] = useMemo(() => {
    if (preview !== null) {
      return preview.issues;
    }
    return documentImportIssuesFromError(previewMutation.error);
  }, [preview, previewMutation.error]);
  const errorIssueCount = issues.filter(
    (issue) => issue.severity === "ERROR",
  ).length;
  const canApply =
    preview !== null && preview.canApply && errorIssueCount === 0;
  const busy = previewMutation.isPending || applyMutation.isPending;
  const assistBusy = assistExtracting || assistMutation.isPending;

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 左栏 section：只有落在这块里的拖放才认，虚线提示也只罩它的内容区。 */
  const paneRef = useRef<HTMLElement>(null);
  /** 「直接粘贴文本」展开的文本区：点开的当帧就把光标放进去，用户可以立刻粘贴。 */
  const pasteTextareaRef =
    useRef<React.ComponentRef<typeof Input.TextArea>>(null);

  // 左栏还是自由正文时给一个显式入口：打一个字就自动调模型太唐突，交给用户点。
  const canAssistCurrent =
    hasContent && !draftStructured && !assistBusy && !busy;

  /** 把一份草稿文本落到左栏；助手那句话由 assistVerdict 实时计算，不在这里追加。 */
  const applyDraftText = (text: string): void => {
    setDocumentText(text);
    setAppliedDraftText(text);
    setLeftView("DRAFT");
    setPasteOpen(false);
    setEditingLine(null);
    // 助手那句话是实时结论（见 assistVerdict），不在这里追加消息。
  };

  /**
   * 「预览文档」对照的原文只记一次：上传文件时记抽取文本，直接粘贴时记首次分析前的那份文本。
   * 分析输入走的是当前左栏草稿（见下），两者会随手动修改分叉，所以这里不覆盖已记下的原文。
   */
  const rememberAssistSource = (text: string): void => {
    setAssistSourceText((current) => current ?? text);
  };

  /**
   * 重新走一次分析：当前左栏草稿 + 逐轮补充拼成一段，仍然只调用同一条路由。
   * baseText 取当前草稿（含手动修改）而不是首次读到的原文，这样 AI 结果落回左栏时
   * 不会丢掉用户手改的内容，也就不需要在覆盖前再弹一次确认（2026-10-14 用户指示：
   * 「不要每次都问一下」）。返回值是这次落进左栏的草稿文本；请求失败时返回 null
   * （那时对话里不追加助手回复）。
   */
  const runAssist = async (
    baseText: string,
    nextSupplements: readonly string[],
    sourceName: string | null,
  ): Promise<string | null> => {
    setAssistError(null);
    setAssistIssues([]);
    const payload = [baseText]
      .concat(nextSupplements.map((item) => "补充说明：" + item))
      .join("\n\n");
    try {
      const result = await assistMutation.mutateAsync(payload);
      setAssistIssues(result.issues);
      setAssistSourceName(sourceName);
      applyDraftText(result.markdown);
      return result.markdown;
    } catch (error) {
      setAssistError(describeDocumentImportAssistError(error));
      return null;
    }
  };

  /** 追加一条助手气泡。 */
  const appendAssistMessage = (text: string): void => {
    setMessages((current) => [...current, { role: "AI", text }]);
  };

  /**
   * 把这一轮的结果落成一条助手气泡。这里用刚返回的草稿文本重新解析，
   * 而不是读 state——runAssist 里的 setDocumentText 还没在这一帧生效。
   *
   * 2026-10-16 实测发现同轮自相矛盾：发送瞬间先按「用户发言前」的草稿报一句
   * 「必填还差 2 处：缺负责人 ×2」，模型落地后又报「已按补充说明更新草稿：
   * …负责人：特哥」，两句话同屏读起来就是自打脸（顶部常驻结论其实已经没有缺口）。
   * 现在发送路径不再单独预告缺口：等待期间由 busy 提示顶上，这一轮只发这一条——
   * 先说左栏改了什么，再补剩余必填缺口；缺口状态与上次汇报相同就不再念。
   */
  const appendAssistReply = (
    markdown: string,
    options: {
      readonly skipIfSameAs?: readonly MissingItem[];
      /** 这一轮的输入（当前草稿）：模型原样返回时要说清「没有变化」，而不是继续报缺口。 */
      readonly base?: string;
    } = {},
  ): void => {
    const items = computeMissingItems(
      buildDocumentDraftView(parseDocumentDraft(markdown)),
      mode,
      memberContext,
    );
    // 这一轮已经说清落地结果，落地汇总不必再重复一条。
    announcedImportRef.current = appliedLandingKey(markdown);
    // 这一轮改了什么 / 有没有改：base 传进来就以这句为准，不再让用户自己去左栏里找。
    if (options.base !== undefined) {
      const change = describeDraftChange(options.base, markdown);
      const signature = requiredGapSignature(items);
      const repeated = announcedGapReplyRef.current === signature;
      announcedGapReplyRef.current = signature;
      // 必填结论并进同一条气泡：两句话都读「模型落地后」的这一份草稿，
      // 不会出现「还差 N 处」与「已更新草稿」同屏互斥。同一份缺口只念一次。
      appendAssistMessage(repeated ? change : change + buildAssistReply(items));
      return;
    }
    if (
      options.skipIfSameAs !== undefined &&
      gapSignature(options.skipIfSameAs) === gapSignature(items)
    ) {
      return;
    }
    appendAssistMessage(buildAssistReply(items));
  };

  /** 自由正文（还没解析出项目段 / 模块段）：把当前内容交给 AI 归纳成模板草稿。 */
  const handleAssistCurrent = async (): Promise<void> => {
    const text = documentText;
    if (text.trim().length === 0) return;
    rememberAssistSource(text);
    await runAssist(text, supplements, assistSourceName);
  };

  /** 本地读到的文档：已经是模板就直接用，否则交给 AI 整理。 */
  const feedDocument = async (
    extracted: ExtractedDocumentText,
    options: { readonly forceAssist: boolean },
  ): Promise<void> => {
    setAssistSourceName(extracted.fileName);
    // 换了一份文件就是换了一份原文：「预览文档」跟着换成这份抽取结果。
    setAssistSourceText(extracted.text);
    setAssistWarning(extracted.warning);
    const extractedView = buildDocumentDraftView(
      parseDocumentDraft(extracted.text),
    );
    if (!options.forceAssist && looksLikeTemplate(extractedView)) {
      applyDraftText(extracted.text);
      return;
    }
    await runAssist(extracted.text, supplements, extracted.fileName);
  };

  const handleDocumentFile = async (file: File): Promise<void> => {
    setAssistError(null);
    setAssistExtracting(true);
    let extracted: ExtractedDocumentText;
    try {
      extracted = await extractDocumentText(file);
    } catch (error) {
      setAssistExtracting(false);
      setAssistSourceName(null);
      setAssistWarning(null);
      setAssistError(
        error instanceof DocumentExtractionError
          ? error.message
          : "文件读取失败，请重试或直接把内容粘贴进来。",
      );
      return;
    }
    setAssistExtracting(false);
    await feedDocument(extracted, { forceAssist: false });
  };

  const handleFileSelected = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    const file = event.currentTarget.files?.[0];
    // 允许连续两次选择同一个文件。
    event.currentTarget.value = "";
    if (file === undefined) return;
    void handleDocumentFile(file);
  };

  /**
   * 拖放进来的文件：整个窗口都接（不再只有空态那个拖入区）。
   * 之前只有空态拖入区绑了 onDrop，草稿栏里已经有内容时把文件拖到弹窗上等于什么都没发生；
   * 拖到弹窗外面还会被浏览器直接打开文件、丢掉当前页面状态。
   */
  const dropFileRef = useRef<(file: File) => void>(() => undefined);
  // 每次渲染后刷新引用，窗口级监听拿到的永远是最新一份处理函数。
  useEffect(() => {
    dropFileRef.current = (file: File): void => {
      void handleDocumentFile(file);
    };
  });

  useEffect(() => {
    if (!open || stage !== "INPUT") {
      return undefined;
    }
    const carriesFiles = (event: DragEvent): boolean =>
      event.dataTransfer !== null &&
      Array.from(event.dataTransfer.types).includes("Files");
    /** 指针是否在左栏上：只有这块接文件，提示框也只在这一块出现。 */
    const overPane = (event: DragEvent): boolean => {
      const pane = paneRef.current;
      const target = event.target;
      return (
        pane !== null &&
        target !== null &&
        target instanceof Node &&
        pane.contains(target)
      );
    };
    const handleDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      // 窗口级仍然 preventDefault：否则浏览器会把文件当成导航目标直接打开。
      event.preventDefault();
      const inside = overPane(event);
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = inside ? "copy" : "none";
      }
      setDragging(inside);
    };
    const handleDragLeave = (event: DragEvent): void => {
      // 只在真正离开窗口时收掉提示；在弹窗内部挪动会先派发 leave。
      if (event.relatedTarget === null) setDragging(false);
    };
    const handleWindowDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      if (!overPane(event)) {
        // 松手位置不在左栏：不偷偷吞掉，也不当成导入。
        setLocalError("请把文件拖到左栏「内容梳理」区域里再松手。");
        return;
      }
      const file = event.dataTransfer?.files?.[0];
      if (file === undefined) {
        setAssistError(
          "拖进来的内容里没有文件；请拖入本机的 .pdf / .docx / .txt / .md 文件。",
        );
        return;
      }
      dropFileRef.current(file);
    };
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleWindowDrop);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [open, stage]);

  const handleComposerSend = async (): Promise<void> => {
    const text = composer.trim();
    if (text.length === 0) return;
    const base = documentText;
    if (base.trim().length === 0) {
      setAssistError("请先选择文档或粘贴内容，再补充说明。");
      return;
    }
    rememberAssistSource(base);
    const nextSupplements = [...supplements, text];
    setComposer("");
    setSupplements(nextSupplements);
    setMessages((current) => [...current, { role: "USER", text }]);
    // 不再在发送瞬间单独预告缺口：那一句读的是「用户发言前」的草稿，模型落地后又报
    // 「已更新草稿」，同屏两句就是自相矛盾（见 appendAssistReply 的说明）。等待期间由
    // busy 提示「正在让 AI 整理…」顶上，落地结果统一由下面这一条说清。
    const applied = await runAssist(base, nextSupplements, assistSourceName);
    if (applied !== null) {
      appendAssistReply(applied, { skipIfSameAs: missingItems, base });
    }
  };

  const handleCandidatePick = async (
    from: string,
    to: string,
  ): Promise<void> => {
    const supplement = buildDocumentAssigneeSupplement(from, to);
    const base = documentText;
    rememberAssistSource(base);
    const nextSupplements = [...supplements, supplement];
    setMemberPicker(null);
    setSupplements(nextSupplements);
    setMessages((current) => [...current, { role: "USER", text: supplement }]);
    const applied = await runAssist(base, nextSupplements, assistSourceName);
    if (applied !== null) {
      appendAssistReply(applied, { skipIfSameAs: missingItems, base });
    }
  };

  const editingMembers =
    editingFieldName !== null && isDocumentMemberFieldName(editingFieldName);

  const resetEdit = (): void => {
    setEditingLine(null);
    setEditingFieldName(null);
    setEditingTags([]);
    setEditingValue("");
  };

  /**
   * 进入「点哪改哪」的编辑态。成员字段另有标签语义（2026-10-14 用户「一个名字选中后形成一个
   * 单独小标签吧，分割开」）：已写定的名字各拆成一个标签，末尾输入框只装正在输入的那一段。
   * 这样第二个人的中文输入不再被前一段名字打断（原先整格一个输入框，末尾接字时会插顿号），
   * 候选列表也能一直挂着接着挑下一个。
   */
  const startEdit = (
    lineIndex: number,
    value: string,
    fieldName: string | null = null,
  ): void => {
    const members = fieldName !== null && isDocumentMemberFieldName(fieldName);
    setEditingLine(lineIndex);
    setEditingFieldName(fieldName);
    setEditingTags(members ? memberTagsFromValue(value) : []);
    setEditingValue(members ? "" : value);
  };

  const commitEdit = (): void => {
    if (editingLine === null) return;
    const next = setDocumentDraftValue(
      draftLines,
      editingLine,
      editingMembers
        ? serializeMemberTags(editingTags, editingValue)
        : editingValue.trim(),
    );
    setDocumentText(serializeDocumentDraft(next));
    resetEdit();
  };

  /** 点候选 → 加一个标签、输入框清空；候选列表不收起，接着点下一个人。 */
  const addEditingTag = (name: string): void => {
    setEditingTags((current) =>
      current.includes(name) ? current : [...current, name],
    );
    setEditingValue("");
  };

  const removeEditingTag = (index: number): void => {
    setEditingTags((current) => current.filter((_item, at) => at !== index));
  };

  /**
   * 编辑框的键盘约定：回车提交、Esc 放弃。中文输入法组合期间的回车 / Esc 是「确认候选 /
   * 取消组合」，不是这两个动作——原先只看 key，打中文时按回车选字会把整格提交掉。
   */
  const draftEditorKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitEdit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetEdit();
    }
  };

  /** 「缺什么补什么」：在节点末尾插入一个空字段行并立刻进入编辑。 */
  const addField = (afterIndex: number, name: string): void => {
    const next = insertDocumentDraftField(draftLines, afterIndex, name);
    setDocumentText(serializeDocumentDraft(next));
    startEdit(afterIndex + 1, "", name);
  };

  /**
   * 「缺什么补什么」的入口：缺的字段一律用黄色提示（与空值、右栏缺失标签同一套语义）；
   * required 里的字段必填（不补服务端会拒绝），额外标「（必填）」并用实线边框区分。
   */
  const missingFields = (
    prefix: string,
    fields: readonly DocumentDraftFieldView[],
    expected: readonly string[],
    required: readonly string[],
    titleLineIndex: number,
  ): React.ReactElement | null => {
    // 成员字段有别名（旧模板写「初始成员」）：任一别名已存在就不再提示补这一行。
    const missing = expected.filter((name) => {
      const aliases = FIELD_ALIASES[name] ?? [name];
      return !aliases.some(
        (alias) => findDocumentDraftField(fields, alias) !== null,
      );
    });
    if (missing.length === 0) return null;
    const afterIndex = lastNodeLineIndex(titleLineIndex, fields);
    return (
      <span className="import-draft-add">
        {missing.map((name) => {
          const mustFill = required.includes(name);
          return (
            <button
              key={name}
              type="button"
              className={
                mustFill
                  ? "import-draft-addbtn is-required"
                  : "import-draft-addbtn"
              }
              aria-label={
                prefix + "：添加" + name + (mustFill ? "（必填）" : "")
              }
              onClick={() => addField(afterIndex, name)}
            >
              ＋{name}
              {mustFill ? "（必填）" : ""}
            </button>
          );
        })}
      </span>
    );
  };

  const handlePreview = async () => {
    const trimmed = documentText.trim();
    if (trimmed.length === 0) {
      setLocalError("请粘贴内容或选择文件后再预览。");
      return;
    }
    setLocalError(null);
    try {
      const result = await previewMutation.mutateAsync(trimmed);
      setPreview(result);
      setStage("PREVIEW");
    } catch {
      // 422 的行级问题从错误明细里提取后展示；其它错误给通用提示。
      setPreview(null);
      setStage("PREVIEW");
    }
  };

  const handleApply = async () => {
    if (preview === null) return;
    try {
      const result = await applyMutation.mutateAsync({
        document: documentText.trim(),
        expectedDigest: preview.digest,
      });
      onImported(result);
    } catch (error) {
      // 错误由 applyMutation.error 渲染；摘要不一致时退回输入态重新预览。
      if (error instanceof ApiError && error.code === "DOCUMENT_IMPORT_STALE") {
        setPreview(null);
        setStage("INPUT");
      }
    }
  };

  const handleBack = () => {
    setStage("INPUT");
    setPreview(null);
    previewMutation.reset();
    applyMutation.reset();
  };

  const handleCancel = () => {
    if (!busy) {
      onClose();
    }
  };

  /**
   * 头部叉与 Esc 分两档：预览阶段只「关闭预览」退回工作台，草稿与弹窗都留着；
   * 工作台阶段才是真的关掉整个导入弹窗。原先预览阶段按叉会连草稿一起关掉，
   * 用户刚看完错误清单一按就丢东西。
   */
  const stageCloseLabel = stage === "PREVIEW" ? "关闭预览" : "关闭";
  const handleDismiss = (): void => {
    if (stage === "PREVIEW") {
      if (!busy) {
        handleBack();
      }
      return;
    }
    handleCancel();
  };

  const showTabs = hasContent || pasteOpen;
  const rawVisible = hasContent ? leftView === "RAW" : pasteOpen;
  const draftVisible = hasContent && leftView !== "RAW";

  /**
   * 成员字段（「项目成员」/「负责人」）的标签行 + 账号建议：点一条候选就多一个标签、输入框
   * 清空，候选列表继续挂着，方便接着加下一个人（2026-10-14 用户「这个下拉框要在选中的时候
   * 一直存在，方便添加下一个人」）。弹层样式与「指派给」同款（头像色块同一个 avatarColorOf）。
   * 目录里没有登录名，所以只按姓名筛；写登录名仍可手打。
   */
  const memberSuggestionField = (
    editor: React.ReactElement,
  ): React.ReactElement => {
    // 目录还没回来（或不可用）时没有可挑的东西，不挂一个空弹层。
    if (directory.length === 0) return editor;
    const suggestions = suggestDirectoryMembers(
      directory,
      editingValue,
      editingTags,
    );
    return (
      <Popover
        open
        // 打开状态完全由「正在编辑的成员字段」决定：点候选、点输入框都不会把它收起。
        onOpenChange={() => undefined}
        trigger="click"
        placement="bottomLeft"
        arrow={false}
        destroyOnHidden
        classNames={{ root: "import-member-popover" }}
        content={
          <div
            className="import-member-suggest"
            data-testid="document-import-member-suggest"
          >
            {/* 常态不写提示行（用户「这行字去掉」）；只有一条都筛不出来时才说清为什么是空的。 */}
            {suggestions.length === 0 ? (
              <p className="import-member-suggest-note">
                没有匹配的成员，可直接手写登录名
              </p>
            ) : null}
            {suggestions.map((member) => (
              <button
                key={member.id}
                type="button"
                className="import-member-suggest-item"
                // 按下就 preventDefault：否则输入框先 blur 提交、标签行与弹层一起消失，点不中。
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addEditingTag(member.name)}
              >
                {member.avatarUrl ? (
                  <img
                    className="import-member-suggest-avatar"
                    src={member.avatarUrl}
                    alt=""
                  />
                ) : (
                  <span
                    className="import-member-suggest-avatar"
                    aria-hidden="true"
                    style={{ background: avatarColorOf(member.name) }}
                  >
                    {member.name.slice(0, 1)}
                  </span>
                )}
                <span className="import-member-suggest-name">
                  {member.name}
                </span>
                {member.isAdmin ? (
                  <span className="import-member-suggest-admin">管理员</span>
                ) : null}
              </button>
            ))}
          </div>
        }
      >
        {editor}
      </Popover>
    );
  };

  const draftValue = (
    lineIndex: number,
    value: string,
    placeholder: string,
    label: string,
    fieldName: string | null = null,
  ): React.ReactElement => {
    if (editingLine === lineIndex) {
      if (editingMembers) {
        // 成员字段：已写定的名字各是一个标签（带 ×），末尾输入框只装正在输入的那一段。
        // 候选列表挂在这一行上、编辑期间一直开着，点掉一条还能接着挑下一条。
        return memberSuggestionField(
          <span
            className="import-draft-tags"
            data-testid="document-import-member-editor"
          >
            {editingTags.map((name, index) => (
              <span className="import-draft-tag" key={name + "#" + index}>
                {name}
                <button
                  type="button"
                  className="import-draft-tag-remove"
                  aria-label={"移除 " + name}
                  // 按下就 preventDefault：否则输入框先 blur 提交、标签行整个消失，点不中。
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => removeEditingTag(index)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="import-draft-editor import-draft-member-input"
              aria-label={label}
              value={editingValue}
              placeholder="输入姓名或登录名"
              autoFocus
              // 原样落回 state：不对正在输入的中文做任何改写，否则会打断输入法组合。
              onChange={(event) => setEditingValue(event.currentTarget.value)}
              onBlur={commitEdit}
              onKeyDown={draftEditorKeyDown}
            />
          </span>,
        );
      }
      return (
        <input
          className="import-draft-editor"
          aria-label={label}
          value={editingValue}
          autoFocus
          onChange={(event) => setEditingValue(event.currentTarget.value)}
          onBlur={commitEdit}
          onKeyDown={draftEditorKeyDown}
        />
      );
    }
    const filled = value.trim().length > 0;
    return (
      <button
        type="button"
        className={filled ? "import-draft-value" : "import-draft-value empty"}
        aria-label={label}
        onClick={() => startEdit(lineIndex, value, fieldName)}
      >
        {filled ? value : placeholder}
      </button>
    );
  };

  const fieldRow = (
    field: DocumentDraftFieldView,
    prefix: string,
  ): React.ReactElement => {
    const placeholder =
      field.name === ASSIGNEE_FIELD ? "（缺负责人）" : "（待补）";
    // ADR-073：创建者（= 本次导入人）默认就是成员。它挂在「项目成员」行上，用户看得见、
    // 也删不掉；不改文档原文（「预览文档」仍是一字不改的原版），落库时由服务端写入成员行。
    const creatorLock =
      mode === "NEW_PROJECT" &&
      creatorMemberName.length > 0 &&
      !memberValueHasCreator(
        field.value,
        creatorMemberName,
        creatorMemberLogin,
      ) &&
      (PROJECT_MEMBER_FIELD_NAMES as readonly string[]).includes(field.name) ? (
        <span
          className="import-draft-tag is-locked"
          title="创建者默认就是成员，不能移除"
          data-testid="document-import-creator-lock"
        >
          <InpulseIcon name="lock" size={11} />
          {creatorMemberName}
        </span>
      ) : null;
    return (
      <span className="import-draft-field" key={field.lineIndex}>
        <span className="import-draft-fieldname">{field.name}</span>
        {creatorLock}
        {draftValue(
          field.lineIndex,
          field.value,
          placeholder,
          prefix + "：" + field.name,
          field.name,
        )}
      </span>
    );
  };

  const taskRows = (
    tasks: readonly DocumentDraftTaskView[],
  ): readonly React.ReactElement[] =>
    tasks.map((task) => {
      const extra = task.fields.filter(
        (field) => field.name !== ASSIGNEE_FIELD && field.name !== "优先级",
      );
      const assigneeField = findDocumentDraftField(task.fields, ASSIGNEE_FIELD);
      const priorityField = findDocumentDraftField(task.fields, "优先级");
      return (
        <div className="import-draft-task" key={task.lineIndex}>
          <span className="import-draft-taskname">
            {draftValue(
              task.lineIndex,
              task.title,
              "（未命名任务）",
              "任务标题：" + task.title,
            )}
          </span>
          <span className="import-draft-taskmeta">
            {assigneeField === null
              ? null
              : draftValue(
                  assigneeField.lineIndex,
                  assigneeField.value,
                  "（待补）",
                  task.title + "：负责人",
                  ASSIGNEE_FIELD,
                )}
            {assigneeField === null || priorityField === null ? null : " · "}
            {priorityField === null
              ? null
              : draftValue(
                  priorityField.lineIndex,
                  priorityField.value,
                  "普通",
                  task.title + "：优先级",
                )}
          </span>
          <span className="import-draft-taskextra">
            {extra.map((field) => fieldRow(field, task.title))}
            {missingFields(
              task.title,
              task.fields,
              task.scope === "MODULE"
                ? [...TASK_FIELDS, ...MODULE_TASK_EXTRA_FIELDS]
                : TASK_FIELDS,
              TASK_REQUIRED_FIELDS,
              task.lineIndex,
            )}
          </span>
        </div>
      );
    });

  const draftPane = (
    <div
      className={draftVisible ? "import-draft" : "import-draft is-hidden"}
      data-testid="document-import-draft"
    >
      {draftView.project !== null ? (
        <div className="import-draft-head">
          <div className="import-draft-title">
            {draftValue(
              draftView.project.lineIndex,
              draftView.project.name,
              "（未命名项目）",
              "项目名称",
            )}
          </div>
          <div className="import-draft-meta">
            {draftView.project.fields.map((field) => fieldRow(field, "项目"))}
            {missingFields(
              "项目",
              draftView.project.fields,
              PROJECT_FIELDS,
              // 项目编码只在整项目导入时必填；项目内导入出现项目段是用户自己写的。
              mode === "NEW_PROJECT" ? PROJECT_REQUIRED_FIELDS : [],
              draftView.project.lineIndex,
            )}
          </div>
          <span className="import-draft-count">
            {countLabel(draftView.counts)}
          </span>
        </div>
      ) : null}
      {mode === "NEW_PROJECT" && draftView.project === null ? (
        <p className="import-draft-warn">
          这份文档里没有「# 项目：名称」段，整项目导入必须补上项目段。
        </p>
      ) : null}
      <div className="import-draft-scroll">
        {draftView.modules.map((module) => (
          <div className="import-draft-group" key={module.lineIndex}>
            <div className="import-draft-modname">
              {draftValue(
                module.lineIndex,
                module.name,
                "（未命名模块）",
                "模块名称：" + module.name,
              )}
            </div>
            <div className="import-draft-desc">
              {module.fields.map((field) => fieldRow(field, module.name))}
              {missingFields(
                module.name,
                module.fields,
                MODULE_FIELDS,
                [],
                module.lineIndex,
              )}
            </div>
            {module.features.map((feature) => (
              <div className="import-draft-feature" key={feature.lineIndex}>
                <div className="import-draft-funcname">
                  {draftValue(
                    feature.lineIndex,
                    feature.name,
                    "（未命名功能）",
                    "功能名称：" + feature.name,
                  )}
                </div>
                <div className="import-draft-desc">
                  {feature.fields.map((field) => fieldRow(field, feature.name))}
                  {missingFields(
                    feature.name,
                    feature.fields,
                    FEATURE_FIELDS,
                    [],
                    feature.lineIndex,
                  )}
                </div>
                {taskRows(feature.tasks)}
              </div>
            ))}
            {taskRows(module.tasks)}
          </div>
        ))}
      </div>
    </div>
  );

  // 「预览文档」只对照本地抽出的原文（上传文件或首次分析前的粘贴文本）：
  // AI 改写后的草稿只进左栏「内容梳理」与右栏对话，不再覆盖原文。
  const rawPane = (
    <Input.TextArea
      ref={pasteTextareaRef}
      className={rawVisible ? "import-draft-raw" : "import-draft-raw is-hidden"}
      aria-label="导入文档内容"
      value={assistSourceText ?? documentText}
      readOnly={assistSourceText !== null}
      rows={18}
      maxLength={DOCUMENT_IMPORT_MAX_TEXT_LENGTH}
      placeholder={"# 项目：商城系统\n- 项目编码：SHOP\n## 模块：支付"}
      disabled={busy || assistBusy}
      onChange={(event) => {
        setDocumentText(event.currentTarget.value);
        setLocalError(null);
      }}
    />
  );

  const dropZone = (
    <div className={dragging ? "import-drop is-dragging" : "import-drop"}>
      <InpulseIcon name="upload" size={40} />
      <p className="import-drop-title">
        把需求文档拖到这里，或
        <Button
          type="link"
          size="small"
          data-testid="document-import-assist-file"
          disabled={busy || assistBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          选择文件
        </Button>
      </p>
      <p className="import-drop-note">
        支持 .txt、.md、.docx、.pdf（单文件不超过 20 MB）
        <br />
        文件只在浏览器本地抽取文本，原文件不会上传
      </p>
      <p className="import-drop-or">
        也可以
        <Button
          type="link"
          size="small"
          onClick={() => {
            setPasteOpen(true);
            setLeftView("RAW");
          }}
        >
          直接粘贴文本
        </Button>
      </p>
    </div>
  );

  const headerPill = (() => {
    if (unmatched.length > 0) {
      return (
        <span className="import-pill is-danger">
          {unmatched.length} 个名字对不上
        </span>
      );
    }
    const must = missingItems.filter((item) => item.severity === "ERROR");
    if (must.length > 0) {
      const total = must.reduce((sum, item) => sum + item.count, 0);
      return <span className="import-pill is-warn">还差 {total} 处</span>;
    }
    const suggest = missingItems.filter((item) => item.severity === "WARNING");
    if (suggest.length > 0) {
      const total = suggest.reduce((sum, item) => sum + item.count, 0);
      return <span className="import-pill">{total} 条建议</span>;
    }
    return null;
  })();

  const assistantPane = (
    <aside className="import-assist" data-testid="document-import-assist">
      <div className="import-assist-head">
        <span className="import-assist-name">AI 助手</span>
        {hasContent ? (
          <span className="import-assist-count">
            {countLabel(draftView.counts)}
          </span>
        ) : null}
        <span className="import-assist-headright">
          {headerPill}
          {canConfigureAiAssist ? (
            <Button
              type="link"
              size="small"
              data-testid="document-import-assist-settings"
              onClick={() => navigate("/settings?tab=aiAssist")}
            >
              配置
            </Button>
          ) : null}
        </span>
      </div>
      <div
        className="import-assist-msgs"
        data-testid="document-import-assist-messages"
      >
        {assistBusy ? (
          <div
            className="import-msg is-busy"
            data-testid="document-import-assist-busy"
          >
            <span className="import-busy-dot" aria-hidden="true" />
            {assistExtracting
              ? "正在本地读取文档…"
              : "正在让 AI 整理成模板草稿…（长文档可能要几十秒）"}
          </div>
        ) : null}
        {assistVerdict === null ? null : (
          <div
            className="import-msg"
            data-testid="document-import-assist-verdict"
          >
            {assistVerdict}
          </div>
        )}
        {canAssistCurrent ? (
          <div className="import-assist-action">
            <Button
              size="small"
              data-testid="document-import-assist-run-raw"
              onClick={() => void handleAssistCurrent()}
            >
              交给 AI 整理
            </Button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          hasContent ? null : (
            <div className="import-assist-empty">
              <div>还没有对话</div>
              <div>把文档交给左侧开始分析后，我会在这里追问缺的信息</div>
            </div>
          )
        ) : (
          messages.map((message, index) => (
            <div
              className={message.role === "AI" ? "import-msg" : "import-msg me"}
              key={index}
            >
              {message.text}
            </div>
          ))
        )}
      </div>
      {missingItems.length > 0 ? (
        <div className="import-chips">
          {missingItems.map((item) => (
            <span
              className={
                item.severity === "ERROR" ? "import-chip is-err" : "import-chip"
              }
              key={item.key}
            >
              {item.label} ×{item.count}
            </span>
          ))}
        </div>
      ) : null}
      {unmatched.length > 0 ? (
        <div
          className="import-unmatched"
          data-testid="document-import-unmatched"
        >
          <p className="import-unmatched-title">
            有 {unmatched.length} 个名字没匹配到成员姓名，导入前请确认
          </p>
          <p className="import-unmatched-note">
            这里只按姓名精确匹配（写登录名时匹配不到）；名字对不上账号时预览会被拒绝，最终以服务端的解析为准。
          </p>
          {unmatched.map((item) => (
            <div className="import-unmatched-row" key={item.name}>
              <span className="import-unmatched-name">{item.name}</span>
              <span className="import-unmatched-pos">
                {item.firstUse === null
                  ? ""
                  : item.firstUse.label +
                    " · 第 " +
                    String(item.firstUse.lineIndex + 1) +
                    " 行"}
              </span>
              <span className="import-unmatched-kind">
                {item.kind === "SIMILAR" ? "有相近成员" : "没有相近成员"}
              </span>
              <span className="import-unmatched-cands">
                {item.candidates.map((candidate) => (
                  <Button
                    key={candidate.id}
                    size="small"
                    disabled={assistBusy}
                    onClick={() =>
                      void handleCandidatePick(item.name, candidate.name)
                    }
                  >
                    {candidate.name}
                  </Button>
                ))}
                <Button
                  size="small"
                  disabled={assistBusy}
                  onClick={() => {
                    setMemberPicker(
                      memberPicker === item.name ? null : item.name,
                    );
                    setMemberPickerQuery("");
                  }}
                >
                  从成员里挑
                </Button>
              </span>
              {memberPicker === item.name ? (
                <MemberPickerPanel
                  members={directory}
                  query={memberPickerQuery}
                  disabled={assistBusy}
                  onQueryChange={setMemberPickerQuery}
                  onPick={(name) => void handleCandidatePick(item.name, name)}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="import-composer">
        <input
          aria-label="补充说明"
          value={composer}
          disabled={!hasContent || assistBusy}
          placeholder={
            hasContent
              ? "用一句话补充，例如「订单查询要在本周五前完成」"
              : "分析完成后，可以在这里补充说明"
          }
          onChange={(event) => {
            setComposer(event.currentTarget.value);
            setAssistError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleComposerSend();
            }
          }}
        />
        <Button
          type="primary"
          data-testid="document-import-assist-run"
          loading={assistBusy}
          disabled={!hasContent || assistBusy}
          onClick={() => void handleComposerSend()}
        >
          发送
        </Button>
      </div>
    </aside>
  );

  const summaryPanel =
    preview === null ? null : (
      <>
        <p
          className="import-summary-line"
          data-testid="document-import-summary"
        >
          计划创建模块 {preview.summary.moduleCreateCount} 个、功能{" "}
          {preview.summary.featureCreateCount} 个、任务{" "}
          {preview.summary.taskCreateCount} 个；复用模块{" "}
          {preview.summary.moduleReuseCount} 个、功能{" "}
          {preview.summary.featureReuseCount} 个。
        </p>
        {preview.project !== null ? (
          <div className="import-preview-proj">
            <div className="import-preview-name">{preview.project.name}</div>
            <div className="import-preview-meta">
              {preview.project.code}
              {preview.project.codeAvailable
                ? " · 编码可用"
                : " · 编码已被占用"}
              {preview.project.members.length > 0
                ? " · 成员：" +
                  preview.project.members
                    .map((member) => member.name)
                    .join("、")
                : ""}
            </div>
          </div>
        ) : null}
        {preview.duplicate !== null ? (
          <Alert
            showIcon
            type="error"
            title={
              "这份文档已经导入过：项目 " +
              String(preview.duplicate.projectId) +
              "，操作人 " +
              preview.duplicate.actorName
            }
          />
        ) : null}
        <div className="import-plan-cards">
          {preview.modules.map((module) => {
            const features = preview.features.filter(
              (feature) => feature.moduleName === module.name,
            );
            const moduleTasks = preview.tasks.filter(
              (task) =>
                task.moduleName === module.name && task.scope === "MODULE",
            );
            return (
              <div className="import-plan-card" key={"module-" + module.line}>
                <div className="import-plan-cardhead">
                  {module.name}
                  <em
                    className={
                      module.action === "REUSE"
                        ? "import-tag is-reuse"
                        : "import-tag"
                    }
                  >
                    {module.action === "REUSE" ? "复用模块" : "新建模块"}
                  </em>
                </div>
                {features.map((feature) => {
                  const tasks = preview.tasks.filter(
                    (task) =>
                      task.scope === "FEATURE" &&
                      task.moduleName === feature.moduleName &&
                      task.featureName === feature.name,
                  );
                  return (
                    <div
                      className="import-plan-block"
                      key={"feature-" + feature.line}
                    >
                      <div className="import-plan-func">
                        {feature.name}
                        <em
                          className={
                            feature.action === "REUSE"
                              ? "import-tag is-reuse"
                              : "import-tag is-feature"
                          }
                        >
                          {feature.action === "REUSE" ? "复用功能" : "新建功能"}
                        </em>
                      </div>
                      {tasks.map((task) => (
                        <div
                          className="import-plan-task"
                          key={"task-" + task.line}
                        >
                          <span className="import-plan-taskname">
                            {task.title}
                          </span>
                          <span className="import-plan-taskmeta">
                            {task.assignees.map((item) => item.name).join("、")}
                            {" · "}
                            {PRIORITY_LABELS[task.priority] ?? task.priority}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {moduleTasks.map((task) => (
                  <div className="import-plan-task" key={"task-" + task.line}>
                    <span className="import-plan-taskname">
                      {task.title}
                      <em className="import-tag is-module-task">模块级任务</em>
                    </span>
                    <span className="import-plan-taskmeta">
                      {task.assignees.map((item) => item.name).join("、")}
                      {" · "}
                      {PRIORITY_LABELS[task.priority] ?? task.priority}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {!canApply && errorIssueCount === 0 ? (
          <Alert
            showIcon
            type="warning"
            title={
              preview.duplicate !== null
                ? "该文档已导入过，不能重复导入。"
                : "当前计划不可执行：项目编码已被占用，请修改文档后重新预览。"
            }
          />
        ) : null}
      </>
    );

  const issuesPanel =
    issues.length > 0 ? (
      <div data-testid="document-import-issues">
        {issues.slice(0, ISSUE_DISPLAY_LIMIT).map((issue, index) => (
          <Alert
            key={index}
            showIcon
            type={issue.severity === "ERROR" ? "error" : "warning"}
            title={"第 " + String(issue.line) + " 行：" + issue.message}
          />
        ))}
        {issues.length > ISSUE_DISPLAY_LIMIT ? (
          <p>还有 {issues.length - ISSUE_DISPLAY_LIMIT} 条问题未显示。</p>
        ) : null}
      </div>
    ) : null;

  const errorMessage =
    localError ??
    (applyMutation.isError
      ? describeDocumentImportError(applyMutation.error)
      : previewMutation.isError
        ? describeDocumentImportError(previewMutation.error)
        : null);
  const errorPanel =
    errorMessage === null ? null : (
      <div
        className="import-workbench-error"
        data-testid="document-import-error"
      >
        <Alert showIcon type="error" title={errorMessage} />
      </div>
    );

  const footNote =
    stage === "PREVIEW" ? (
      <span className="import-foot-note">
        预览只读 · 确认后会在单个事务内创建
      </span>
    ) : (
      <span
        className="import-foot-note"
        data-testid="document-import-assist-source"
      >
        {assistSourceName ?? (hasContent ? "内容待预览" : "解析结果：尚未分析")}
      </span>
    );

  return (
    <>
      <Modal
        className="catalog-modal import-workbench"
        size="lg"
        title={
          mode === "NEW_PROJECT" ? "从文档导入整项目" : "从文档导入模块与功能"
        }
        destroyOnHidden
        mask={{ closable: false }}
        open={open}
        closeLabel={stageCloseLabel}
        onCancel={handleDismiss}
        footer={
          <div className="import-foot">
            {footNote}
            <div className="import-foot-actions">
              {stage === "INPUT" ? (
                <>
                  <Button disabled={busy} onClick={handleCancel}>
                    取消
                  </Button>
                  <Button
                    type="primary"
                    data-testid="document-import-preview"
                    loading={previewMutation.isPending}
                    disabled={busy || assistBusy || !hasContent}
                    onClick={() => void handlePreview()}
                  >
                    预览
                  </Button>
                </>
              ) : (
                <>
                  <Button disabled={busy} onClick={handleBack}>
                    返回修改
                  </Button>
                  <Button
                    type="primary"
                    data-testid="document-import-apply"
                    disabled={!canApply}
                    loading={applyMutation.isPending}
                    onClick={() => void handleApply()}
                  >
                    确认导入
                  </Button>
                </>
              )}
            </div>
          </div>
        }
      >
        {stage === "INPUT" ? (
          <div className="import-workbench-body">
            {errorPanel}
            <div className="import-panes">
              <section
                className="import-pane"
                data-testid="document-import-pane"
                ref={paneRef}
              >
                <div className="import-pane-head">
                  {showTabs ? (
                    /* 两个视图切换按钮此前只有 className 表达选中态，读屏读不出「当前在哪个
                       视图」：补 aria-pressed（与任务看板工具栏的 segmented 同一语义）。 */
                    <span
                      className="import-tabs"
                      role="group"
                      aria-label="左栏视图"
                    >
                      <button
                        type="button"
                        className={leftView === "DRAFT" ? "is-on" : undefined}
                        aria-pressed={leftView === "DRAFT"}
                        onClick={() => {
                          setLeftView("DRAFT");
                          setPasteOpen(false);
                        }}
                      >
                        内容梳理
                      </button>
                      <button
                        type="button"
                        className={leftView === "RAW" ? "is-on" : undefined}
                        aria-pressed={leftView === "RAW"}
                        onClick={() => setLeftView("RAW")}
                      >
                        预览文档
                      </button>
                    </span>
                  ) : (
                    <span className="import-pane-title">内容梳理</span>
                  )}
                  <span className="import-pane-headright">
                    {preview !== null ? (
                      <span className="import-pill">
                        模板版本 {preview.templateVersion}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="import-pane-body">
                  {dragging ? (
                    <div
                      className="import-drop-overlay"
                      data-testid="document-import-drop-overlay"
                    >
                      <InpulseIcon name="upload" size={26} />
                      松开鼠标即可导入（.txt / .md / .docx / .pdf，单文件不超过
                      20 MB）
                    </div>
                  ) : null}
                  {!hasContent && !pasteOpen ? dropZone : null}
                  {draftPane}
                  {rawPane}
                  {assistWarning !== null ? (
                    <Alert showIcon type="warning" title={assistWarning} />
                  ) : null}
                  {assistError !== null ? (
                    <div data-testid="document-import-assist-error">
                      <Alert showIcon type="error" title={assistError} />
                    </div>
                  ) : null}
                  {assistIssues.length > 0 ? (
                    <div
                      className="import-assist-issues"
                      data-testid="document-import-assist-issues"
                    >
                      {assistIssues
                        .slice(0, ISSUE_DISPLAY_LIMIT)
                        .map((issue, index) => (
                          <p
                            className={
                              issue.severity === "ERROR"
                                ? "import-issue is-err"
                                : "import-issue"
                            }
                            key={index}
                          >
                            AI 草稿第 {issue.line} 行：{issue.message}
                          </p>
                        ))}
                      {assistIssues.length > ISSUE_DISPLAY_LIMIT ? (
                        <p className="import-issue">
                          还有 {assistIssues.length - ISSUE_DISPLAY_LIMIT}{" "}
                          条问题未显示。
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={DOCUMENT_EXTRACTION_ACCEPT}
                    aria-label="选择文档进行分析"
                    hidden
                    onChange={handleFileSelected}
                  />
                </div>
              </section>
              {assistantPane}
            </div>
            <details
              className="import-format-guide"
              data-testid="document-import-format-guide"
            >
              <summary>必填要素</summary>
              <p>
                项目名称、项目编码（大写字母开头）、参加人员（填写姓名，须包含创建者本人与全部任务负责人），以及模块名称、功能名称与各项任务的标题、负责人。功能隶属于模块，任务可隶属于模块或功能。
              </p>
              <p>
                参加人员、说明、截止时间与描述等建议一并提供，以便 AI
                整理与成员匹配。
              </p>
            </details>
          </div>
        ) : (
          <div className="import-preview-body">
            {errorPanel}
            {summaryPanel}
            {issuesPanel}
          </div>
        )}
      </Modal>
    </>
  );
};

export default DocumentImportModal;
