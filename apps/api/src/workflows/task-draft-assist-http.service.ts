import { Inject, Injectable } from "@nestjs/common";
import {
  taskDraftAssistResponseSchema,
  type TaskDraftAssistModuleCandidate,
  type TaskDraftAssistProjectCandidate,
  type TaskDraftAssistRequest,
  type TaskDraftAssistResponse,
  type TaskDraftAssistSuggestions,
} from "@inpulse/api-contract";

import { getHeader, type HttpHeaderBag } from "../auth/csrf.http.js";
import { SessionAuthService } from "../auth/session-auth.service.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { ApiHttpError } from "../http/contract-errors.js";
import { AiAssistRuntimeService } from "../modules/document-import/ai-assist-runtime.service.js";
import {
  AiAssistUpstreamError,
  DocumentImportAiAssistClient,
} from "../modules/document-import/ai-assist.client.js";
import { ProjectMembersQueryPort } from "../modules/projects/project-members-query.port.js";
import {
  TaskDraftAssistCatalogPort,
  type TaskDraftAssistCatalog,
  type TaskDraftAssistModuleItem,
} from "./task-draft-assist.catalog.port.js";
import {
  TaskDraftAssistProjectCatalogPort,
  type TaskDraftAssistProjectItem,
} from "./task-draft-assist-project-catalog.port.js";

const TASK_DRAFT_ASSIST_SESSION_REQUIRED = "TASK_DRAFT_ASSIST_SESSION_REQUIRED";
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 20_000;
const MAX_NOTES = 8;
const MAX_PROJECT_CANDIDATES = 5;
const MAX_MODULE_CANDIDATES = 5;

/**
 * 模型输出只用名称，不产出 ID：这里只接受已知字段，跨项目、凭空人名与
 * 不存在的项目/模块由服务端按真实清单匹配时丢弃。
 */
interface ModelOutput {
  readonly reply: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly priority: "NORMAL" | "HIGH" | "URGENT" | null;
  readonly dueDate: string | null;
  readonly assigneeNames: readonly string[];
  readonly projectName: string | null;
  readonly moduleName: string | null;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly notes: readonly string[];
}

interface ProjectSnapshot {
  readonly actorUserId: number;
  readonly members: readonly { readonly id: number; readonly name: string }[];
  readonly catalog: TaskDraftAssistCatalog;
  /** 未选项目时的授权项目候选；项目内识别固定为空。 */
  readonly projects: readonly TaskDraftAssistProjectItem[];
}

const EMPTY_SNAPSHOT: ProjectSnapshot = {
  actorUserId: 0,
  members: [],
  catalog: { modules: [] },
  projects: [],
};

/**
 * 新建任务 AI 识别 HTTP 编排。
 *
 * 读权限与候选清单位于只读短事务：先按实时成员关系确认当前用户能读
 * 这个项目，再取活跃成员与模块名称。事务结束后才解析 AI 配置并调用
 * 上游（网络请求绝不在数据库事务内）。本接口不创建任务、不写任何表；所有
 * 返回值只是预填建议，项目与模块还必须由用户在前端确认。
 */
@Injectable()
export class TaskDraftAssistHttpService {
  constructor(
    @Inject(SessionAuthService)
    private readonly sessions: SessionAuthService,
    @Inject(PostgresUnitOfWork)
    private readonly uow: PostgresUnitOfWork,
    @Inject(DocumentImportAiAssistClient)
    private readonly aiAssist: DocumentImportAiAssistClient,
    @Inject(AiAssistRuntimeService)
    private readonly aiAssistRuntime: AiAssistRuntimeService,
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(TaskDraftAssistCatalogPort)
    private readonly catalog: TaskDraftAssistCatalogPort,
    @Inject(TaskDraftAssistProjectCatalogPort)
    private readonly projectCatalog: TaskDraftAssistProjectCatalogPort,
  ) {}

  async assist(
    headers: HttpHeaderBag,
    projectId: number,
    input: TaskDraftAssistRequest,
  ): Promise<TaskDraftAssistResponse> {
    const snapshot = await this.loadProjectSnapshot(headers, projectId);
    return this.runAssist(input, snapshot, true);
  }

  /**
   * 未选择项目：验证登录并读取当前用户有权访问的项目清单。
   * 用户可以先把聊天截图交给 AI 看，AI 只给疑似项目；用户确认前不写归属。
   */
  async assistStandalone(
    headers: HttpHeaderBag,
    input: TaskDraftAssistRequest,
  ): Promise<TaskDraftAssistResponse> {
    const actorUserId = await this.requireActor(headers);
    const projects = await this.projectCatalog.load(actorUserId);
    return this.runAssist(
      input,
      { ...EMPTY_SNAPSHOT, actorUserId, projects },
      false,
    );
  }

  private async requireActor(headers: HttpHeaderBag): Promise<number> {
    return this.uow.run(async (tx) => {
      const actor = await this.sessions.resolveActorInTransaction(
        tx,
        getHeader(headers, "cookie"),
      );
      if (actor === undefined) {
        throw new ApiHttpError(
          401,
          TASK_DRAFT_ASSIST_SESSION_REQUIRED,
          "登录状态已失效，请重新登录",
        );
      }
      return actor.userId;
    });
  }

  private async runAssist(
    input: TaskDraftAssistRequest,
    snapshot: ProjectSnapshot,
    hasProjectContext: boolean,
  ): Promise<TaskDraftAssistResponse> {
    const resolution = await this.aiAssistRuntime.resolve();
    if (resolution.kind === "DISABLED") {
      throw new ApiHttpError(
        503,
        "AI_ASSIST_DISABLED",
        "AI 辅助转换未启用或配置无效，请管理员在「成员与设置」中配置",
        { reason: resolution.reason },
      );
    }

    const today = todayInShanghai();
    const currentModule = snapshot.catalog.modules.find(
      (item) => item.id === input.moduleId,
    );

    let raw: string;
    try {
      const draft = await this.aiAssist.generateTaskDraft(resolution.config, {
        message: input.message,
        history: input.history,
        today: today.date,
        weekday: today.weekday,
        members: snapshot.members,
        modules: snapshot.catalog.modules,
        projects: snapshot.projects,
        currentModuleName: currentModule?.name ?? null,
        hasProjectContext,
        images: input.images,
      });
      raw = draft.content;
    } catch (error) {
      if (error instanceof AiAssistUpstreamError) {
        throw new ApiHttpError(
          503,
          "AI_ASSIST_UPSTREAM_FAILED",
          "AI 服务暂时不可用，请稍后重试",
          { reason: error.reason },
        );
      }
      throw error;
    }

    const parsed = parseModelOutput(raw);
    const suggestions = await this.resolveSuggestions(
      parsed,
      input,
      snapshot,
      hasProjectContext,
    );
    return taskDraftAssistResponseSchema.parse(
      this.toResponse(
        parsed,
        snapshot,
        input,
        today.date,
        hasProjectContext,
        suggestions,
      ),
    );
  }

  private async resolveSuggestions(
    output: ModelOutput,
    input: TaskDraftAssistRequest,
    snapshot: ProjectSnapshot,
    hasProjectContext: boolean,
  ): Promise<TaskDraftAssistSuggestions> {
    if (hasProjectContext) {
      return {
        projects: [],
        modules: resolveModuleCandidates(
          snapshot.catalog.modules,
          output.moduleName,
          input.message,
        ),
      };
    }

    const projects = resolveProjectCandidates(
      snapshot.projects,
      output.projectName,
      input.message,
    );
    if (
      projects.length !== 1 ||
      (!output.moduleName?.trim() &&
        extractModuleHints(input.message).length === 0)
    ) {
      return { projects, modules: [] };
    }

    const project = projects[0];
    if (project === undefined) return { projects, modules: [] };
    const modules = await this.projectCatalog.loadModules(
      snapshot.actorUserId,
      project.id,
    );
    return {
      projects,
      modules: resolveModuleCandidates(
        modules,
        output.moduleName,
        input.message,
      ),
    };
  }

  private async loadProjectSnapshot(
    headers: HttpHeaderBag,
    projectId: number,
  ): Promise<ProjectSnapshot> {
    return this.uow.run(async (tx) => {
      const actor = await this.sessions.resolveActorInTransaction(
        tx,
        getHeader(headers, "cookie"),
      );
      if (actor === undefined) {
        throw new ApiHttpError(
          401,
          TASK_DRAFT_ASSIST_SESSION_REQUIRED,
          "登录状态已失效，请重新登录",
        );
      }
      // listActiveMembers 在事务内重新鉴权；undefined = 项目不存在或当前用户不可读。
      const members = await this.members.listActiveMembers(tx, {
        actorUserId: actor.userId,
        projectId,
      });
      if (members === undefined) {
        throw new ApiHttpError(
          404,
          "PROJECT_NOT_FOUND",
          "项目不存在或无法访问",
        );
      }
      const catalog = await this.catalog.load(tx, projectId);
      return {
        actorUserId: actor.userId,
        members,
        catalog,
        projects: [],
      };
    });
  }

  private toResponse(
    output: ModelOutput,
    snapshot: ProjectSnapshot,
    input: TaskDraftAssistRequest,
    today: string,
    hasProjectContext: boolean,
    suggestions: TaskDraftAssistSuggestions,
  ): TaskDraftAssistResponse {
    const notes: string[] = [];
    for (const note of output.notes ?? []) {
      const trimmed = note.trim().slice(0, 200);
      if (trimmed.length > 0 && notes.length < MAX_NOTES) notes.push(trimmed);
    }

    if (!hasProjectContext) {
      const dueAt = toDueAt(output.dueDate);
      if (output.dueDate?.trim() && dueAt === null) {
        pushNote(
          notes,
          "截止日期「" + output.dueDate.trim() + "」无法识别，已留空",
        );
      }
      if (dueAt !== null && dueAt.slice(0, 10) < today) {
        pushNote(notes, "截止日期早于今天，请确认");
      }
      pushNote(notes, "未选择项目：项目归属请用确认卡或左侧下拉手动确定");
      if (suggestions.projects.length > 1) {
        pushNote(
          notes,
          "可能是这几个项目：" +
            suggestions.projects.map((item) => item.name).join("、") +
            "，请选一个",
        );
      } else if (
        suggestions.projects.length === 0 &&
        output.projectName?.trim()
      ) {
        pushNote(
          notes,
          "项目「" +
            output.projectName.trim() +
            "」不在可访问项目里，请手动选择",
        );
      }
      if (output.assigneeNames.length > 0) {
        pushNote(notes, "负责人需要选好项目后再确认");
      }
      if (suggestions.modules.length === 0 && output.moduleName?.trim()) {
        pushNote(notes, "模块「" + output.moduleName.trim() + "」暂未匹配");
      }
      return {
        reply: output.reply,
        draft: {
          title: trimmedOrNull(output.title, MAX_TITLE),
          description: trimmedOrNull(output.description, MAX_DESCRIPTION),
          priority: output.priority ?? null,
          dueAt,
          assigneeIds: [],
          assigneeNames: [],
          moduleId: null,
          moduleName: null,
        },
        suggestions,
        confidence: output.confidence ?? "MEDIUM",
        notes: notes.slice(0, MAX_NOTES),
      };
    }

    const moduleCandidates = suggestions.modules;
    const moduleMatch =
      moduleCandidates.length === 1 ? moduleCandidates[0] : null;
    if (output.moduleName?.trim() && moduleCandidates.length === 0) {
      pushNote(
        notes,
        "模块「" + output.moduleName.trim() + "」不在当前项目里，已留空",
      );
    }

    const resolvedModuleId = moduleMatch?.id ?? null;
    const resolvedModuleName = moduleMatch?.name ?? null;

    const assigneeIds: number[] = [];
    const assigneeNames: string[] = [];
    for (const name of output.assigneeNames ?? []) {
      const matched = snapshot.members.find(
        (member) => normalizeName(member.name) === normalizeName(name),
      );
      if (matched === undefined) {
        pushNote(notes, "负责人「" + name.trim() + "」不在项目成员里");
      } else if (!assigneeIds.includes(matched.id)) {
        assigneeIds.push(matched.id);
        assigneeNames.push(matched.name);
      }
    }

    const dueAt = toDueAt(output.dueDate);
    if (output.dueDate?.trim() && dueAt === null) {
      pushNote(
        notes,
        "截止日期「" + output.dueDate.trim() + "」无法识别，已留空",
      );
    }
    if (dueAt !== null && dueAt.slice(0, 10) < today) {
      pushNote(notes, "截止日期早于今天，请确认");
    }

    const confidence = output.confidence ?? "MEDIUM";
    const title = trimmedOrNull(output.title, MAX_TITLE);
    const description = trimmedOrNull(output.description, MAX_DESCRIPTION);
    const priority = output.priority ?? null;
    if (confidence === "LOW") {
      // 低置信度不猜：归属与负责人必须由用户手动确认，文本字段仍可参考。
      if (moduleCandidates.length > 0 || output.moduleName?.trim()) {
        pushNote(notes, "归属没有把握，请在确认卡或左侧下拉中选择");
      }
      if (assigneeIds.length > 0) {
        pushNote(notes, "负责人没有把握，已留空，请手动选择");
      }
      return {
        reply: output.reply,
        draft: {
          title,
          description,
          priority,
          dueAt,
          assigneeIds: [],
          assigneeNames: [],
          moduleId: null,
          moduleName: null,
        },
        suggestions,
        confidence,
        notes: notes.slice(0, MAX_NOTES),
      };
    }

    return {
      reply: output.reply,
      draft: {
        title,
        description,
        priority,
        dueAt,
        assigneeIds,
        assigneeNames,
        moduleId: resolvedModuleId,
        moduleName: resolvedModuleName,
      },
      suggestions,
      confidence,
      notes: notes.slice(0, MAX_NOTES),
    };
  }
}

function parseModelOutput(content: string): ModelOutput {
  const unfenced = content
    .replace(/^\s*\u0060\u0060\u0060(?:json)?\s*/i, "")
    .replace(/\s*\u0060\u0060\u0060\s*$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw invalidResponse();
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw invalidResponse();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  const record = value as Record<string, unknown>;
  const reply = stringField(record["reply"])?.slice(0, 600) ?? "";
  if (reply.length === 0) throw invalidResponse();
  return {
    reply,
    title: stringField(record["title"]),
    description: stringField(record["description"]),
    priority: enumField(record["priority"], ["NORMAL", "HIGH", "URGENT"]),
    dueDate: stringField(record["dueDate"]),
    assigneeNames: stringArrayField(record["assigneeNames"]).slice(0, 3),
    projectName: stringField(record["projectName"]),
    moduleName: stringField(record["moduleName"]),
    confidence:
      enumField(record["confidence"], ["HIGH", "MEDIUM", "LOW"]) ?? "MEDIUM",
    notes: stringArrayField(record["notes"]).slice(0, MAX_NOTES),
  };
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function invalidResponse(): ApiHttpError {
  return new ApiHttpError(
    503,
    "AI_ASSIST_UPSTREAM_FAILED",
    "AI 服务返回了无法识别的内容，请稍后重试",
    { reason: "invalid-response" },
  );
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function trimHintPrefix(value: string): string {
  let next = value;
  const prefixes = [
    "之前说的",
    "上次说的",
    "我们的",
    "咱们的",
    "那个",
    "这个",
    "就是",
    "关于",
    "最近",
    "现在",
    "目前",
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (next.startsWith(prefix) && next.length > prefix.length) {
        next = next.slice(prefix.length);
        changed = true;
      }
    }
  }
  return next;
}

function hintVariants(hint: string): string[] {
  const normalized = normalizeMatchText(trimHintPrefix(hint));
  if (normalized.length === 0) return [];
  const variants = new Set([normalized]);
  for (const suffix of ["项目", "模块", "平台", "系统"]) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length + 1) {
      variants.add(normalized.slice(0, -suffix.length));
    }
  }
  return [...variants].filter((item) => item.length >= 2);
}

function extractProjectHints(message: string): string[] {
  const hints: string[] = [];
  const pattern =
    /([\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9 _-]{1,30})项目/gu;
  for (const match of message.matchAll(pattern)) {
    hints.push(...hintVariants(match[1] ?? ""));
  }
  return [...new Set(hints)];
}

function extractModuleHints(message: string): string[] {
  const hints: string[] = [];
  const pattern =
    /([\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9 _-]{1,30})模块/gu;
  for (const match of message.matchAll(pattern)) {
    hints.push(...hintVariants(match[1] ?? ""));
  }
  return [...new Set(hints)];
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function scoreProjectMatch(
  project: TaskDraftAssistProjectItem,
  hints: readonly string[],
  normalizedMessage: string,
): number {
  const name = normalizeMatchText(project.name);
  const code = normalizeMatchText(project.code);
  let score = 0;
  if (name.length >= 2 && normalizedMessage.includes(name)) score = 90;
  if (code.length >= 2 && normalizedMessage.includes(code)) {
    score = Math.max(score, 88);
  }
  for (const hint of hints) {
    if (hint === name || hint === code) {
      score = Math.max(score, 100);
    } else if (
      name.includes(hint) ||
      hint.includes(name) ||
      (code.length >= 2 && (code.includes(hint) || hint.includes(code)))
    ) {
      score = Math.max(score, 84);
    } else {
      const prefix = commonPrefixLength(hint, name);
      if (prefix >= 2) score = Math.max(score, 62 + prefix);
    }
  }
  return score;
}

function scoreModuleMatch(
  module: TaskDraftAssistModuleItem,
  hints: readonly string[],
  normalizedMessage: string,
): number {
  const name = normalizeMatchText(module.name);
  let score = 0;
  if (name.length >= 2 && normalizedMessage.includes(name)) score = 88;
  for (const hint of hints) {
    if (hint === name) {
      score = Math.max(score, 100);
    } else if (name.includes(hint) || hint.includes(name)) {
      score = Math.max(score, 84);
    } else {
      const prefix = commonPrefixLength(hint, name);
      if (prefix >= 2) score = Math.max(score, 60 + prefix);
    }
  }
  return score;
}

function resolveProjectCandidates(
  projects: readonly TaskDraftAssistProjectItem[],
  projectName: string | null,
  message: string,
): TaskDraftAssistProjectCandidate[] {
  const modelHints = projectName === null ? [] : hintVariants(projectName);
  const messageHints = extractProjectHints(message);
  const hints = [...new Set([...modelHints, ...messageHints])];
  const normalizedMessage = normalizeMatchText(message);
  if (hints.length === 0 && normalizedMessage.length === 0) return [];

  // 用户自己的说法同时命中多个项目时，模型挑的单个名字不能把候选收窄：
  // 确认卡必须把可疑项目都列出来，由用户点选。
  const messageMatches = projects
    .map((project) => ({
      project,
      score: scoreProjectMatch(project, messageHints, normalizedMessage),
    }))
    .filter((item) => item.score >= 84)
    .sort(
      (left, right) =>
        right.score - left.score || left.project.id - right.project.id,
    );
  if (messageMatches.length > 1) {
    return messageMatches.slice(0, MAX_PROJECT_CANDIDATES).map((item) => ({
      id: item.project.id,
      code: item.project.code,
      name: item.project.name,
    }));
  }

  const scored = projects
    .map((project) => ({
      project,
      score: scoreProjectMatch(project, hints, normalizedMessage),
    }))
    .filter((item) => item.score >= 70)
    .sort(
      (left, right) =>
        right.score - left.score || left.project.id - right.project.id,
    );

  const top = scored[0];
  if (top === undefined) return [];
  const exact = scored.filter((item) => item.score >= 98);
  const floor = exact.length > 0 ? 98 : Math.max(70, top.score - 8);
  return scored
    .filter((item) => item.score >= floor)
    .slice(0, MAX_PROJECT_CANDIDATES)
    .map((item) => ({
      id: item.project.id,
      code: item.project.code,
      name: item.project.name,
    }));
}

function resolveModuleCandidates(
  modules: readonly TaskDraftAssistModuleItem[],
  moduleName: string | null,
  message: string,
): TaskDraftAssistModuleCandidate[] {
  const modelHints = moduleName === null ? [] : hintVariants(moduleName);
  const messageHints = extractModuleHints(message);
  const hints = [...new Set([...modelHints, ...messageHints])];
  const normalizedMessage = normalizeMatchText(message);
  if (hints.length === 0 && normalizedMessage.length === 0) return [];

  // 模块同一规则：用户说法本身就模糊时，不采纳模型的单次猜测。
  const messageMatches = modules
    .map((module) => ({
      module,
      score: scoreModuleMatch(module, messageHints, normalizedMessage),
    }))
    .filter((item) => item.score >= 84)
    .sort(
      (left, right) =>
        right.score - left.score || left.module.id - right.module.id,
    );
  if (messageMatches.length > 1) {
    return messageMatches.slice(0, MAX_MODULE_CANDIDATES).map((item) => ({
      id: item.module.id,
      name: item.module.name,
    }));
  }

  const scored = modules
    .map((module) => ({
      module,
      score: scoreModuleMatch(module, hints, normalizedMessage),
    }))
    .filter((item) => item.score >= 60)
    .sort(
      (left, right) =>
        right.score - left.score || left.module.id - right.module.id,
    );

  const top = scored[0];
  if (top === undefined) return [];
  const exact = scored.filter((item) => item.score >= 100);
  const floor = exact.length > 0 ? 100 : Math.max(60, top.score - 8);
  return scored
    .filter((item) => item.score >= floor)
    .slice(0, MAX_MODULE_CANDIDATES)
    .map((item) => ({ id: item.module.id, name: item.module.name }));
}

function trimmedOrNull(
  value: string | null | undefined,
  max: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function pushNote(notes: string[], note: string): void {
  if (notes.length < MAX_NOTES && !notes.includes(note)) notes.push(note);
}

function todayInShanghai(): {
  readonly date: string;
  readonly weekday: string;
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
  }).format(now);
  return { date: year + "-" + month + "-" + day, weekday };
}

/**
 * 只接受 YYYY-MM-DD；统一补 18:00 +08:00（工作日结束），并拒绝 2 月 30 日
 * 这类会被 Date 自动进位的日期。时间与日期都交给前端控件展示与修改。
 */
function toDueAt(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day, 10, 0, 0));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return match[0] + "T18:00:00+08:00";
}
