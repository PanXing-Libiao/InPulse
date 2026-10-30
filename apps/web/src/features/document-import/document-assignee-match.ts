/**
 * ADR-071 文档导入工作台：把草稿里的负责人 / 项目成员名字与站内账号做确定性匹配。
 *
 * 唯一数据源是登录用户目录（GET /api/v1/users，只有 id / 姓名 / 头像 / 管理员标记）：
 * 姓名精确命中才算匹配；同名多人、只能找到相近姓名、完全找不到时都算「未匹配」，
 * 由右栏对话追问。模型不参与决策，也不会自动建用户或替用户挑人：候选只作提示，
 * 用户点了候选才会以「补充说明」的形式重新走一次分析，最终仍由服务端解析器定案。
 */
import type { UserDirectoryItem } from "@generated/api";
import {
  findDocumentDraftField,
  splitDocumentDraftList,
  type DocumentDraftFieldView,
  type DocumentDraftTaskView,
  type DocumentDraftView,
} from "./document-draft";

/** 草稿里出现的名字，以及它出现在哪一行、属于哪个节点。 */
export interface DocumentAssigneeNameUse {
  readonly name: string;
  /** 承载这个名字的标题行行号（任务标题行 / 项目标题行），追问时给用户定位。 */
  readonly lineIndex: number;
  /** 出现位置的人话标签：任务标题，或「项目成员」。 */
  readonly label: string;
  readonly source: "TASK_ASSIGNEE" | "PROJECT_MEMBER";
}

export interface DocumentAssigneeUnmatched {
  readonly name: string;
  /**
   * SIMILAR：目录里有同名多人或相近姓名，需要人工确认到底是哪一个；
   * UNKNOWN：目录里连相近的都没有。
   */
  readonly kind: "SIMILAR" | "UNKNOWN";
  readonly candidates: readonly UserDirectoryItem[];
  /** 名字第一次出现的位置，用于追问文案。 */
  readonly firstUse: DocumentAssigneeNameUse | null;
}

export interface DocumentAssigneeMatchResult {
  /** 名字（原样）→ 成员账号，只含姓名精确且唯一的那些。 */
  readonly matched: ReadonlyMap<string, UserDirectoryItem>;
  readonly unmatched: readonly DocumentAssigneeUnmatched[];
}

const CANDIDATE_LIMIT = 5;
const ASSIGNEE_FIELD_NAME = "负责人";
/**
 * 项目段里记成员的字段名：模板写「项目成员」，兼容上一版模板的「初始成员」与手写的
 * 「成员」。2026-10-16 用户把「初始成员」这个说法整体改成「项目成员」，旧写法继续认。
 */
export const PROJECT_MEMBER_FIELD_NAMES = [
  "项目成员",
  "初始成员",
  "成员",
] as const;

/** 名字比较用的规整化：去掉所有空白并转小写。 */
export function normalizeName(name: string): string {
  return name.replace(/\s+/gu, "").toLowerCase();
}

function readFieldValue(
  fields: readonly {
    readonly lineIndex: number;
    readonly name: string;
    readonly value: string;
  }[],
  names: readonly string[],
): { readonly value: string; readonly lineIndex: number } | null {
  for (const name of names) {
    const field = findDocumentDraftField(fields, name);
    if (field !== null) {
      return { value: field.value, lineIndex: field.lineIndex };
    }
  }
  return null;
}

/** 收集草稿里所有需要对应到账号的名字（任务负责人 + 项目成员），按出现顺序去重。 */
export function collectDocumentAssigneeNames(
  view: DocumentDraftView,
): readonly DocumentAssigneeNameUse[] {
  const uses: DocumentAssigneeNameUse[] = [];
  const pushNames = (
    value: string,
    lineIndex: number,
    label: string,
    source: DocumentAssigneeNameUse["source"],
  ): void => {
    for (const name of splitDocumentDraftList(value)) {
      if (name.length === 0) continue;
      if (uses.some((use) => use.name === name)) continue;
      uses.push({ name, lineIndex, label, source });
    }
  };
  if (view.project !== null) {
    const member = readFieldValue(
      view.project.fields,
      PROJECT_MEMBER_FIELD_NAMES,
    );
    if (member !== null) {
      pushNames(
        member.value,
        view.project.lineIndex,
        "项目成员",
        "PROJECT_MEMBER",
      );
    }
  }
  for (const module of view.modules) {
    for (const task of module.tasks) {
      const assignee = readFieldValue(task.fields, [ASSIGNEE_FIELD_NAME]);
      if (assignee === null) continue;
      pushNames(assignee.value, task.lineIndex, task.title, "TASK_ASSIGNEE");
    }
  }
  return uses;
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row];
    for (let column = 1; column < columns; column += 1) {
      const cost = left.charAt(row - 1) === right.charAt(column - 1) ? 0 : 1;
      current.push(
        Math.min(
          (previous[column] ?? 0) + 1,
          (current[column - 1] ?? 0) + 1,
          (previous[column - 1] ?? 0) + cost,
        ),
      );
    }
    previous = current;
  }
  return previous[columns - 1] ?? 0;
}

function isSimilar(input: string, candidate: string): boolean {
  if (input.length === 0 || candidate.length === 0) return false;
  if (candidate.includes(input) || input.includes(candidate)) return true;
  // 中文姓名很短，编辑距离 1 已经足够覆盖错字、漏字这类真实情况。
  return editDistance(input, candidate) <= 1;
}

function similarCandidates(
  name: string,
  directory: readonly UserDirectoryItem[],
): readonly UserDirectoryItem[] {
  const target = normalizeName(name);
  const hits = directory.filter((item) =>
    isSimilar(target, normalizeName(item.name)),
  );
  return hits
    .slice()
    .sort((left, right) => left.id - right.id)
    .slice(0, CANDIDATE_LIMIT);
}

/**
 * 确定性匹配：姓名精确且唯一 → 命中；同名多人 / 相近姓名 / 无候选 → 未匹配。
 * 不做模糊自动接管（ADR-071：成员归属不能由模型或相似度决定）。
 */
export function matchDocumentAssignees(
  uses: readonly DocumentAssigneeNameUse[],
  directory: readonly UserDirectoryItem[],
): DocumentAssigneeMatchResult {
  const byName = new Map<string, UserDirectoryItem[]>();
  for (const item of directory) {
    const key = normalizeName(item.name);
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [item]);
    else bucket.push(item);
  }
  const matched = new Map<string, UserDirectoryItem>();
  const unmatched: DocumentAssigneeUnmatched[] = [];
  for (const use of uses) {
    const bucket = byName.get(normalizeName(use.name));
    if (bucket !== undefined && bucket.length === 1) {
      const only = bucket[0];
      if (only !== undefined) matched.set(use.name, only);
      continue;
    }
    const candidates =
      bucket !== undefined && bucket.length > 1
        ? bucket.slice().sort((left, right) => left.id - right.id)
        : similarCandidates(use.name, directory);
    unmatched.push({
      name: use.name,
      kind: candidates.length > 0 ? "SIMILAR" : "UNKNOWN",
      candidates,
      firstUse: use,
    });
  }
  return { matched, unmatched };
}

/** 追问文案：把「对不上」说成人话；模型不参与时也由这里确定性生成。 */
export function buildDocumentAssigneeQuestion(
  unmatched: readonly DocumentAssigneeUnmatched[],
): string | null {
  if (unmatched.length === 0) return null;
  const parts = unmatched.map((item) => {
    const where =
      item.firstUse === null ? "" : "（" + item.firstUse.label + "）";
    if (item.kind === "UNKNOWN") {
      return "「" + item.name + "」" + where + "在成员里找不到相近的人";
    }
    const names = item.candidates.map((candidate) => candidate.name).join("、");
    return "「" + item.name + "」" + where + "最接近的是「" + names + "」";
  });
  return (
    "还有 " +
    String(unmatched.length) +
    " 个名字对不上成员账号：" +
    parts.join("；") +
    "。点下面的候选，或直接在这里告诉我怎么改（我不会替你猜人）。"
  );
}

/** 点候选 / 挑人后追加到补充说明的那句话。 */
export function buildDocumentAssigneeSupplement(
  from: string,
  to: string,
): string {
  return "「" + from + "」改成「" + to + "」";
}

export function describeDocumentAssigneeMatched(
  result: DocumentAssigneeMatchResult,
): string | null {
  if (result.unmatched.length > 0) return null;
  const names = [...result.matched.values()].map((item) => item.name);
  if (names.length === 0) return null;
  return "负责人已对应到站内账号：" + names.join("、") + "。";
}

/** 成员名单校验的判定入参（ADR-072，创建者口径见 ADR-073）。 */
export interface DocumentMemberCoverageContext {
  /** 本次导入人（创建者）：姓名与登录名都能在文档里代表 TA，且默认就算项目成员；未登录信息时传 null。 */
  readonly creator: {
    readonly id: number;
    readonly name: string;
    readonly loginName: string;
  } | null;
  /** 用户目录：把姓名对到账号。目录未就绪时传空数组，判定自动降级为「本地判不了」。 */
  readonly directory: readonly UserDirectoryItem[];
}

export interface DocumentMemberCoverage {
  /** 整项目导入还没有写「- 项目成员：」。 */
  readonly memberRequired: boolean;
  /** 名单里没有、却被任务指派为负责人的名字（按首次出现顺序去重）。 */
  readonly missingAssignees: readonly string[];
}

const NO_MEMBER_COVERAGE: DocumentMemberCoverage = {
  memberRequired: false,
  missingAssignees: [],
};

function collectViewTasks(
  view: DocumentDraftView,
): readonly DocumentDraftTaskView[] {
  const tasks: DocumentDraftTaskView[] = [];
  for (const module of view.modules) {
    tasks.push(...module.tasks);
  }
  return tasks;
}

function fieldText(
  fields: readonly DocumentDraftFieldView[],
  name: string,
): string {
  return findDocumentDraftField(fields, name)?.value ?? "";
}

/**
 * ADR-072 成员名单校验（整项目导入）：项目成员必填，且必须包含全部任务负责人；
 * ADR-073：创建者默认就算成员，名单里写不写都行（写了也不重复），而任务负责人是指派给
 * 创建者本人的时候自然也不再报缺。服务端在预览时按「解析后的账号」判同一件事并把 ERROR
 * 落到行级问题；这里做同一口径的本地预检，让用户在点「预览」之前就看到缺口。本地只认三类
 * 确定事实（姓名 / 登录名 / 目录里唯一的同名账号），判不了的人（多半是登录名）一律不报，
 * 避免把写了的人报成漏写。
 */
export function checkDocumentMemberCoverage(
  view: DocumentDraftView,
  mode: "PROJECT" | "NEW_PROJECT",
  context: DocumentMemberCoverageContext,
): DocumentMemberCoverage {
  if (mode !== "NEW_PROJECT" || view.project === null) {
    return NO_MEMBER_COVERAGE;
  }
  const memberField = readFieldValue(
    view.project.fields,
    PROJECT_MEMBER_FIELD_NAMES,
  );
  const memberTokens =
    memberField === null ? [] : splitDocumentDraftList(memberField.value);
  if (memberTokens.length === 0) {
    return {
      memberRequired: true,
      missingAssignees: [],
    };
  }

  const byName = new Map<string, readonly UserDirectoryItem[]>();
  for (const item of context.directory) {
    const key = normalizeName(item.name);
    byName.set(key, [...(byName.get(key) ?? []), item]);
  }
  const creatorKeys =
    context.creator === null
      ? []
      : [
          normalizeName(context.creator.name),
          normalizeName(context.creator.loginName),
        ];
  const resolveToken = (token: string): number | null => {
    const key = normalizeName(token);
    if (context.creator !== null && creatorKeys.includes(key)) {
      return context.creator.id;
    }
    const bucket = byName.get(key);
    if (bucket === undefined || bucket.length !== 1) return null;
    return bucket[0]?.id ?? null;
  };

  const memberIds = memberTokens.map(resolveToken);
  const creatorId = context.creator?.id ?? null;

  const missingAssignees: string[] = [];
  // 名单里有本地判不了的令牌（多半是登录名）时整体不做判断：宁可等预览时服务端定案，
  // 也不把「其实写了、只是本地读不懂」的人报成漏写。
  if (memberIds.every((id) => id !== null)) {
    for (const task of collectViewTasks(view)) {
      for (const token of splitDocumentDraftList(
        fieldText(task.fields, ASSIGNEE_FIELD_NAME),
      )) {
        const id = resolveToken(token);
        if (id === null) continue;
        if (
          memberTokens.some(
            (member) => normalizeName(member) === normalizeName(token),
          )
        ) {
          continue;
        }
        if (memberIds.includes(id)) continue;
        // ADR-073：创建者默认就是成员，负责人写不写都不算缺口。
        if (creatorId !== null && id === creatorId) continue;
        if (missingAssignees.includes(token)) continue;
        missingAssignees.push(token);
      }
    }
  }

  return { memberRequired: false, missingAssignees };
}

/** 建议条数上限：够看一屏，又不至于把弹层撑得比字段本身还显眼。 */
const MEMBER_SUGGESTION_LIMIT = 8;

/** 成员字段（写人名 / 登录名的那些）才有账号建议：项目成员、成员、负责人。 */
export function isDocumentMemberFieldName(name: string): boolean {
  return (
    name === ASSIGNEE_FIELD_NAME ||
    (PROJECT_MEMBER_FIELD_NAMES as readonly string[]).includes(name)
  );
}

/**
 * 成员字段的名单值 → 标签：按 `splitDocumentDraftList` 切分（半角逗号 / 全角逗号 / 顿号），
 * 去空白段。2026-10-14 用户「一个名字选中后形成一个单独小标签吧，分割开」：编辑成员字段时
 * 每个名字各拆成一个标签，末尾输入框只装正在输入的那一段。
 */
export function memberTagsFromValue(value: string): readonly string[] {
  return splitDocumentDraftList(value);
}

/**
 * 标签 + 正在输入的那一段 → 名单值：用顿号拼起来写回草稿（与 `splitDocumentDraftList` 同口径）。
 * 同名（去掉首尾空白后完全一样）只留第一个，免得同一个账号在名单里写两遍。
 */
export function serializeMemberTags(
  tags: readonly string[],
  input: string,
): string {
  const names: string[] = [];
  for (const tag of [...tags, input]) {
    const name = tag.trim();
    if (name.length === 0 || names.includes(name)) continue;
    names.push(name);
  }
  return names.join("、");
}

/**
 * 成员字段（`- 项目成员：` / `- 负责人：`）输入框里的账号建议（2026-10-14 用户
 * 「和成员相关的可不可以做到简单的搜索，比如我打名字的其中一个字然后会筛选出来」）。
 *
 * 只看末尾输入框里**正在输入的那一段**（`typedToken`，标签不参与筛选）：用户目录只有
 * id / 姓名 / 头像 / 管理员标记，没有登录名，所以按**姓名子串**筛，登录名只能手写（服务端按
 * 登录名或姓名解析，等价）。前缀命中排前面（打「小」先给「小潘」再看「王小二」），同长度
 * 保持目录顺序，结果可预期；已经做成标签的名字（`settledNames`）不再建议，免得同一个人
 * 被写两遍。当前段落为空时给整份目录：编辑期间候选列表一直挂着，点掉一条还能接着挑下一条。
 */
export function suggestDirectoryMembers(
  directory: readonly UserDirectoryItem[],
  typedToken: string,
  settledNames: readonly string[],
): readonly UserDirectoryItem[] {
  const typed = normalizeName(typedToken);
  const settled = new Set(settledNames.map((item) => normalizeName(item)));
  const pool = directory.filter(
    (item) => !settled.has(normalizeName(item.name)),
  );
  if (typed.length === 0) {
    // 一个字都没打就是「打开看看有谁」：按成员目录本身的顺序给，不做前缀 / 长度排序。
    return pool.slice(0, MEMBER_SUGGESTION_LIMIT);
  }
  return pool
    .filter((item) => normalizeName(item.name).includes(typed))
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const byRank =
        Number(!normalizeName(left.item.name).startsWith(typed)) -
        Number(!normalizeName(right.item.name).startsWith(typed));
      if (byRank !== 0) return byRank;
      const byLength = left.item.name.length - right.item.name.length;
      if (byLength !== 0) return byLength;
      return left.index - right.index;
    })
    .slice(0, MEMBER_SUGGESTION_LIMIT)
    .map((entry) => entry.item);
}
