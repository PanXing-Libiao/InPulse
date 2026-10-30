import { Inject, Injectable } from "@nestjs/common";
import {
  taskDraftAssistResponseSchema,
  type TaskDraftAssistRequest,
  type TaskDraftAssistResponse,
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
} from "./task-draft-assist.catalog.port.js";

const TASK_DRAFT_ASSIST_SESSION_REQUIRED = "TASK_DRAFT_ASSIST_SESSION_REQUIRED";
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 20_000;
const MAX_NOTES = 8;

/**
 * 模型输出只用名称，不产出 ID：这里只接受已知字段，跨项目、凭空人名与
 * 不存在的模块由服务端按真实清单匹配时丢弃。
 */
interface ModelOutput {
  readonly reply: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly priority: "NORMAL" | "HIGH" | "URGENT" | null;
  readonly dueDate: string | null;
  readonly assigneeNames: readonly string[];
  readonly moduleName: string | null;
  readonly featureName: string | null;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly notes: readonly string[];
}

interface ProjectSnapshot {
  readonly members: readonly { readonly id: number; readonly name: string }[];
  readonly catalog: TaskDraftAssistCatalog;
}

/**
 * 新建任务 AI 识别 HTTP 编排。
 *
 * 读权限与候选清单位于同一个只读短事务：先按实时成员关系确认当前用户能读
 * 这个项目，再取活跃成员、模块与功能名称。事务结束后才解析 AI 配置并调用
 * 上游（网络请求绝不在数据库事务内）。本接口不创建任务、不写任何表；所有
 * 返回值只是预填建议，最终创建仍走既有 createTask 的完整校验。
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
  ) {}

  async assist(
    headers: HttpHeaderBag,
    projectId: number,
    input: TaskDraftAssistRequest,
  ): Promise<TaskDraftAssistResponse> {
    const snapshot = await this.loadProjectSnapshot(headers, projectId);
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
    const currentFeature = snapshot.catalog.features.find(
      (item) => item.id === input.featureId,
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
        features: snapshot.catalog.features,
        currentModuleName: currentModule?.name ?? null,
        currentFeatureName: currentFeature?.name ?? null,
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
    return taskDraftAssistResponseSchema.parse(
      this.toResponse(parsed, snapshot, today.date),
    );
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
      return { members, catalog };
    });
  }

  private toResponse(
    output: ModelOutput,
    snapshot: ProjectSnapshot,
    today: string,
  ): TaskDraftAssistResponse {
    const notes: string[] = [];
    for (const note of output.notes ?? []) {
      const trimmed = note.trim().slice(0, 200);
      if (trimmed.length > 0 && notes.length < MAX_NOTES) notes.push(trimmed);
    }

    const moduleMatch = matchByName(
      snapshot.catalog.modules,
      output.moduleName,
    );
    if (output.moduleName?.trim() && moduleMatch === null) {
      pushNote(
        notes,
        "模块「" + output.moduleName.trim() + "」不在当前项目里，已留空",
      );
    }

    const featureCandidates =
      moduleMatch === null
        ? snapshot.catalog.features
        : snapshot.catalog.features.filter(
            (item) => item.moduleId === moduleMatch.id,
          );
    let featureMatch = matchByName(featureCandidates, output.featureName);
    if (featureMatch === null && moduleMatch === null) {
      // 模型只认出功能、没认出模块时，用功能反推模块；同名功能跨模块时不猜。
      const globalMatches = snapshot.catalog.features.filter(
        (item) =>
          normalizeName(item.name) === normalizeName(output.featureName ?? ""),
      );
      if (globalMatches.length === 1) featureMatch = globalMatches[0] ?? null;
    }
    if (output.featureName?.trim() && featureMatch === null) {
      pushNote(
        notes,
        "功能「" + output.featureName.trim() + "」没匹配到，已留空",
      );
    }
    const resolvedModuleId = moduleMatch?.id ?? featureMatch?.moduleId ?? null;
    const resolvedModuleName =
      moduleMatch?.name ??
      snapshot.catalog.modules.find((item) => item.id === resolvedModuleId)
        ?.name ??
      null;

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
    const resolvedFeatureId = featureMatch?.id ?? null;
    if (confidence === "LOW") {
      // 低置信度不猜：归属与负责人必须由用户手动确认，文本字段仍可参考。
      if (resolvedModuleId !== null || resolvedFeatureId !== null) {
        pushNote(notes, "归属没有把握，已留空，请手动选择");
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
          featureId: null,
          featureName: null,
        },
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
        featureId: resolvedFeatureId,
        featureName: featureMatch?.name ?? null,
      },
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
    moduleName: stringField(record["moduleName"]),
    featureName: stringField(record["featureName"]),
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

function matchByName<T extends { readonly name: string }>(
  items: readonly T[],
  name: string | null | undefined,
): T | null {
  const target = normalizeName(name);
  if (target.length === 0) return null;
  return items.find((item) => normalizeName(item.name) === target) ?? null;
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
