/**
 * ADR-071 文档导入工作台：模板草稿在「结构化视图」与「文本」之间往返。
 *
 * 文本是唯一真相。左栏结构化视图只是派生结果：任何一次编辑都只改动一行，再由
 * serializeDocumentDraft 写回文本。识别不了的行（说明行、代码围栏行、层级错位行）
 * 原样保留，预览与导入继续走既有的纯文本契约，不新增接口。
 */

export type DocumentDraftLineKind =
  "BLANK" | "IGNORED" | "TITLE" | "FIELD" | "UNKNOWN";

export type DocumentDraftTitleKind = "PROJECT" | "MODULE" | "MODULE_TASK";

export interface DocumentDraftLine {
  readonly kind: DocumentDraftLineKind;
  /** 原始行文本；TITLE 与 FIELD 由结构字段重建，其余按 raw 原样写回。 */
  readonly raw: string;
  readonly titleKind?: DocumentDraftTitleKind;
  /** 标题行的「#」个数，以及原文里用的层级词（项目 / 模块 / 任务）。 */
  readonly headingDepth?: number;
  readonly headingWord?: string;
  readonly title?: string;
  readonly fieldName?: string;
  readonly fieldValue?: string;
}

export interface DocumentDraftFieldView {
  readonly lineIndex: number;
  readonly name: string;
  readonly value: string;
}

export interface DocumentDraftTaskView {
  readonly lineIndex: number;
  readonly title: string;
  readonly fields: readonly DocumentDraftFieldView[];
}

export interface DocumentDraftModuleView {
  readonly lineIndex: number;
  readonly name: string;
  readonly fields: readonly DocumentDraftFieldView[];
  readonly tasks: readonly DocumentDraftTaskView[];
}

export interface DocumentDraftProjectView {
  readonly lineIndex: number;
  readonly name: string;
  readonly fields: readonly DocumentDraftFieldView[];
}

export interface DocumentDraftCounts {
  readonly modules: number;
  readonly tasks: number;
}

export interface DocumentDraftView {
  readonly project: DocumentDraftProjectView | null;
  readonly modules: readonly DocumentDraftModuleView[];
  readonly counts: DocumentDraftCounts;
  /** 归不到任何节点上的内容行（层级错位、无法识别），只能在「预览文档」里处理。 */
  readonly looseLineIndexes: readonly number[];
}

const TITLE_KINDS: Readonly<Record<string, DocumentDraftTitleKind>> = {
  "1:项目": "PROJECT",
  "2:模块": "MODULE",
  "3:任务": "MODULE_TASK",
};

const FIELD_NAME_MAX_LENGTH = 50;
const FENCE_MARKERS = ["```", "~~~"] as const;

interface HeadingParts {
  readonly depth: number;
  readonly body: string;
}

function readHeading(line: string): HeadingParts | null {
  let depth = 0;
  while (depth < line.length && line.charAt(depth) === "#") depth += 1;
  if (depth === 0 || depth > 6) return null;
  const rest = line.slice(depth);
  if (rest.charAt(0) !== " " && rest.charAt(0) !== "\t") return null;
  return { depth, body: rest.trim() };
}

function readColonSplit(text: string): { name: string; value: string } | null {
  const fullWidth = text.indexOf("：");
  const halfWidth = text.indexOf(":");
  let index: number;
  if (fullWidth >= 0 && halfWidth >= 0) index = Math.min(fullWidth, halfWidth);
  else index = fullWidth >= 0 ? fullWidth : halfWidth;
  if (index <= 0) return null;
  const name = text.slice(0, index).trim();
  if (name.length === 0 || name.length > FIELD_NAME_MAX_LENGTH) return null;
  return { name, value: text.slice(index + 1).trim() };
}

function readFieldBody(line: string): string | null {
  if (line.charAt(0) !== "-" && line.charAt(0) !== "*") return null;
  const rest = line.slice(1);
  if (rest.charAt(0) !== " ") return null;
  return rest.trim();
}

function isIgnoredLine(line: string): boolean {
  if (line.charAt(0) === ">") return true;
  return FENCE_MARKERS.some((marker) => line.startsWith(marker));
}

/** 单行解析：与后端解析器同一套识别规则（标题层级 + 全角/半角冒号 + 字段前缀）。 */
export function parseDocumentDraftLine(rawLine: string): DocumentDraftLine {
  const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "BLANK", raw };
  if (isIgnoredLine(trimmed)) return { kind: "IGNORED", raw };
  const heading = readHeading(trimmed);
  if (heading !== null) {
    const split = readColonSplit(heading.body);
    if (split === null) return { kind: "UNKNOWN", raw };
    const titleKind = TITLE_KINDS[String(heading.depth) + ":" + split.name];
    if (titleKind === undefined) return { kind: "UNKNOWN", raw };
    return {
      kind: "TITLE",
      raw,
      titleKind,
      headingDepth: heading.depth,
      headingWord: split.name,
      title: split.value,
    };
  }
  const field = readFieldBody(trimmed);
  if (field !== null) {
    const split = readColonSplit(field);
    if (split === null) return { kind: "UNKNOWN", raw };
    return {
      kind: "FIELD",
      raw,
      fieldName: split.name,
      fieldValue: split.value,
    };
  }
  return { kind: "UNKNOWN", raw };
}

export function parseDocumentDraft(
  documentText: string,
): readonly DocumentDraftLine[] {
  return documentText.split("\n").map(parseDocumentDraftLine);
}

export function serializeDocumentDraftLine(line: DocumentDraftLine): string {
  if (line.kind === "TITLE") {
    const depth = line.headingDepth ?? 1;
    return (
      "#".repeat(depth) +
      " " +
      (line.headingWord ?? "") +
      "：" +
      (line.title ?? "")
    );
  }
  if (line.kind === "FIELD") {
    return "- " + (line.fieldName ?? "") + "：" + (line.fieldValue ?? "");
  }
  return line.raw;
}

export function serializeDocumentDraft(
  lines: readonly DocumentDraftLine[],
): string {
  return lines.map(serializeDocumentDraftLine).join("\n");
}

/** 「点哪改哪」的统一入口：标题行改标题，字段行改值，其它行不可编辑。 */
export function setDocumentDraftValue(
  lines: readonly DocumentDraftLine[],
  lineIndex: number,
  value: string,
): readonly DocumentDraftLine[] {
  return lines.map((line, index) => {
    if (index !== lineIndex) return line;
    if (line.kind === "TITLE") return { ...line, title: value };
    if (line.kind === "FIELD") return { ...line, fieldValue: value };
    return line;
  });
}

/**
 * 在指定行之后插入一个空字段行（ADR-071「缺什么补什么」）。
 * 标题行后面还没有任何字段时，afterIndex 就是标题行本身；
 * 已有字段时传最后一个字段行的行号。返回新数组，不修改入参。
 */
export function insertDocumentDraftField(
  lines: readonly DocumentDraftLine[],
  afterIndex: number,
  fieldName: string,
): readonly DocumentDraftLine[] {
  const next: DocumentDraftLine[] = lines.slice();
  next.splice(afterIndex + 1, 0, {
    kind: "FIELD",
    raw: "- " + fieldName + "：",
    fieldName,
    fieldValue: "",
  });
  return next;
}

/** 节点自身的最后一行：字段行比标题行靠后时用最后一个字段行。 */
export function lastNodeLineIndex(
  titleLineIndex: number,
  fields: readonly DocumentDraftFieldView[],
): number {
  return fields.reduce(
    (max, field) => (field.lineIndex > max ? field.lineIndex : max),
    titleLineIndex,
  );
}

/** 逗号 / 顿号分隔的字段值（负责人、项目成员）。 */
export function splitDocumentDraftList(value: string): readonly string[] {
  return value
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function findDocumentDraftField(
  fields: readonly DocumentDraftFieldView[],
  name: string,
): DocumentDraftFieldView | null {
  return fields.find((field) => field.name === name) ?? null;
}

interface MutableField {
  lineIndex: number;
  name: string;
  value: string;
}

interface MutableTask {
  lineIndex: number;
  title: string;
  fields: MutableField[];
}

interface MutableModule {
  lineIndex: number;
  name: string;
  fields: MutableField[];
  tasks: MutableTask[];
}

interface MutableProject {
  lineIndex: number;
  name: string;
  fields: MutableField[];
}

/** 文本行 → 结构化视图；无法归属的行进入 looseLineIndexes，不静默丢弃。 */
export function buildDocumentDraftView(
  lines: readonly DocumentDraftLine[],
): DocumentDraftView {
  const looseLineIndexes: number[] = [];
  let project: MutableProject | null = null;
  const modules: MutableModule[] = [];
  let currentModule: MutableModule | null = null;
  let currentTask: MutableTask | null = null;

  lines.forEach((line, lineIndex) => {
    if (line.kind === "TITLE") {
      const title = line.title ?? "";
      switch (line.titleKind) {
        case "PROJECT":
          if (project !== null) {
            looseLineIndexes.push(lineIndex);
            return;
          }
          project = { lineIndex, name: title, fields: [] };
          currentModule = null;
          currentTask = null;
          return;
        case "MODULE": {
          const next: MutableModule = {
            lineIndex,
            name: title,
            fields: [],
            tasks: [],
          };
          modules.push(next);
          currentModule = next;
          currentTask = null;
          return;
        }
        case "MODULE_TASK": {
          if (currentModule === null) {
            looseLineIndexes.push(lineIndex);
            return;
          }
          const next: MutableTask = {
            lineIndex,
            title,
            fields: [],
          };
          currentModule.tasks.push(next);
          currentTask = next;
          return;
        }
        default:
          looseLineIndexes.push(lineIndex);
          return;
      }
    }
    if (line.kind === "FIELD") {
      const field: MutableField = {
        lineIndex,
        name: line.fieldName ?? "",
        value: line.fieldValue ?? "",
      };
      if (currentTask !== null) currentTask.fields.push(field);
      else if (currentModule !== null) currentModule.fields.push(field);
      else if (project !== null) project.fields.push(field);
      else looseLineIndexes.push(lineIndex);
    }
  });

  const tasks = modules.reduce((total, item) => total + item.tasks.length, 0);

  return {
    project,
    modules,
    counts: { modules: modules.length, tasks },
    looseLineIndexes,
  };
}
