import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  DOCUMENT_IMPORT_ASSIST_MAX_ISSUES,
  documentImportAssistResponseSchema,
  projectDocumentImportPreviewResponseSchema,
  projectDocumentImportReplayContextSchema,
  projectDocumentImportResultSchema,
  type DocumentImportAssistRequest,
  type DocumentImportAssistResponse,
  type DocumentImportIssue,
  type ProjectDocumentImportPreviewRequest,
  type ProjectDocumentImportPreviewResponse,
  type ProjectDocumentImportReplayContext,
  type ProjectDocumentImportRequest,
  type ProjectDocumentImportResult,
} from "@inpulse/api-contract";

import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../auth/csrf.http.js";
import { SessionAuthService } from "../auth/session-auth.service.js";
import { UserReadPort } from "../auth/user-read.port.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { ApiHttpError } from "../http/contract-errors.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../idempotency/http-service.js";
import { AiAssistRuntimeService } from "../modules/document-import/ai-assist-runtime.service.js";
import {
  AiAssistUpstreamError,
  DocumentImportAiAssistClient,
  type AiAssistDraft,
} from "../modules/document-import/ai-assist.client.js";
import type { AiAssistTarget } from "../modules/document-import/ai-assist-target.js";
import { validateAiAssistTarget } from "../modules/document-import/ai-assist-target.js";
import { parseDocumentTemplate } from "../modules/document-import/document-template.parser.js";
import { FeatureManagementError } from "../modules/features/features-management.service.js";
import { ModuleManagementError } from "../modules/modules/modules-management.service.js";
import {
  ProjectBootstrapConflictError,
  ProjectBootstrapValidationError,
  ProjectCodeConflictError,
} from "../modules/projects/project-bootstrap.workflow.js";
import { SearchProjectionCapacityError } from "../modules/search/public/search-projection-errors.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import {
  DocumentImportError,
  DocumentImportWorkflow,
} from "./document-import.workflow.js";

const DOCUMENT_IMPORT_SESSION_REQUIRED = "DOCUMENT_IMPORT_SESSION_REQUIRED";
/**
 * ADR-064 文档导入 HTTP 编排：预览为纯校验读路径（只验证身份，不写任何
 * 持久化状态），执行为数据库级幂等写命令。预览与执行共用同一份计划阶段，
 * 摘要不一致 409；计划含 ERROR 时 422 并携带行级问题；同一文档已导入过
 * 时 409，绝不产生部分写入。
 */
@Injectable()
export class DocumentImportHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly auth: AuthenticatedMutationService,
    @Inject(SessionAuthService)
    private readonly sessions: SessionAuthService,
    @Inject(PostgresUnitOfWork)
    private readonly uow: PostgresUnitOfWork,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(DocumentImportWorkflow)
    private readonly workflow: DocumentImportWorkflow,
    @Inject(AiAssistRuntimeService)
    private readonly aiAssistRuntime: AiAssistRuntimeService,
    @Inject(DocumentImportAiAssistClient)
    private readonly aiAssist: DocumentImportAiAssistClient,
    @Inject(UserReadPort)
    private readonly users: UserReadPort,
  ) {}

  /** 项目内导入预览：仅已登录且拥有项目写权限的用户。 */
  previewInProject(
    headers: HttpHeaderBag,
    projectId: number,
    input: ProjectDocumentImportPreviewRequest,
  ): Promise<ProjectDocumentImportPreviewResponse> {
    return this.preview(headers, (tx, actorId) =>
      this.workflow.previewInProject(tx, actorId, projectId, input.document),
    );
  }

  /** 整项目导入预览：任意已登录用户，校验编码、成员与全部下级计划。 */
  previewNewProject(
    headers: HttpHeaderBag,
    input: ProjectDocumentImportPreviewRequest,
  ): Promise<ProjectDocumentImportPreviewResponse> {
    return this.preview(headers, (tx, actorId) =>
      this.workflow.previewNewProject(tx, actorId, input.document),
    );
  }

  /**
   * 取创建者（本次导入人）的展示姓名：短只读事务读一次，只用进 system 提示词。
   * 读不到返回 undefined，由提示词退化为「姓名未知、不要编造」（ADR-067 2.5 不含用户正文）。
   */
  private async resolveCreatorName(
    userId: number,
  ): Promise<string | undefined> {
    const [user] = await this.uow.run((tx) =>
      this.users.listByIds(tx, [userId]),
    );
    const name = user === undefined ? "" : user.name.trim();
    return name.length === 0 ? undefined : name;
  }

  /**
   * ADR-067 AI 辅助转换：身份解析走只读短事务，上游调用在事务外执行
   * （绝不在数据库事务内发起网络请求）；返回前用既有解析器预检草稿。
   * 创建者（本次导入人）必须出现在草稿的项目成员名单里，所以整项目模式要先读出 TA 的
   * 姓名注入提示词（短只读事务，仍不把上游调用放进事务）；姓名读不到时退化为「不要编造」。
   */
  async assist(
    headers: HttpHeaderBag,
    input: DocumentImportAssistRequest,
  ): Promise<DocumentImportAssistResponse> {
    const actor = await this.sessions.resolveActor(
      getHeader(headers, "cookie"),
    );
    if (actor === undefined) {
      throw new ApiHttpError(
        401,
        DOCUMENT_IMPORT_SESSION_REQUIRED,
        "登录状态已失效，请重新登录",
      );
    }
    let target: AiAssistTarget | undefined;
    const requestedTarget = input.target;
    if (requestedTarget !== undefined) {
      try {
        target = await this.uow.run((tx) =>
          this.workflow.resolveAssistTarget(tx, actor.userId, requestedTarget),
        );
      } catch (error) {
        throw mapDocumentImportError(error);
      }
    }
    const resolution = await this.aiAssistRuntime.resolve();
    if (resolution.kind === "DISABLED") {
      throw new ApiHttpError(
        503,
        "AI_ASSIST_DISABLED",
        "AI 辅助转换未启用或配置无效，请管理员在「成员与设置」中配置",
        { reason: resolution.reason },
      );
    }
    const creatorName =
      input.mode === "WHOLE_PROJECT"
        ? await this.resolveCreatorName(actor.userId)
        : undefined;
    let draft: AiAssistDraft;
    try {
      draft = await this.aiAssist.generateDraft(resolution.config, {
        mode: input.mode,
        text: input.text,
        creatorName,
        target,
      });
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
    const parsed = parseDocumentTemplate(draft.markdown);
    const issues: DocumentImportIssue[] = [
      ...parsed.issues,
      ...(target === undefined ? [] : validateAiAssistTarget(parsed, target)),
    ];
    if (draft.truncated) {
      issues.push({
        severity: "ERROR",
        line: Math.min(draft.markdown.split("\n").length, 1_000_000),
        code: "AI_ASSIST_TRUNCATED",
        message: "AI 输出因长度上限可能不完整，请精简文档或分次生成后再预览。",
      });
    }
    return documentImportAssistResponseSchema.parse({
      markdown: draft.markdown,
      model: draft.model,
      issues: issues.slice(0, DOCUMENT_IMPORT_ASSIST_MAX_ISSUES),
    });
  }

  /** 项目内导入执行：项目锁内重新计划，单事务创建，整笔幂等。 */
  executeInProject(
    headers: HttpHeaderBag,
    projectId: number,
    input: ProjectDocumentImportRequest,
  ): Promise<ProjectDocumentImportResult> {
    return this.execute({
      headers,
      operationId: "importProjectDocument",
      path: "/projects/{projectId}/document-imports",
      pathParams: { projectId: String(projectId) },
      body: input,
      run: (tx, actorId) =>
        this.workflow.executeInProject(
          tx,
          actorId,
          projectId,
          input.document,
          input.expectedDigest,
          randomUUID(),
        ),
    });
  }

  /** 整项目导入执行：单事务创建项目、成员、模块、功能与任务，整笔幂等。 */
  executeNewProject(
    headers: HttpHeaderBag,
    input: ProjectDocumentImportRequest,
  ): Promise<ProjectDocumentImportResult> {
    return this.execute({
      headers,
      operationId: "importProject",
      path: "/project-imports",
      pathParams: {},
      body: input,
      run: (tx, actorId) =>
        this.workflow.executeNewProject(
          tx,
          actorId,
          input.document,
          input.expectedDigest,
          randomUUID(),
        ),
    });
  }

  private async preview(
    headers: HttpHeaderBag,
    handler: (
      tx: TransactionContext,
      actorId: number,
    ) => Promise<ProjectDocumentImportPreviewResponse>,
  ): Promise<ProjectDocumentImportPreviewResponse> {
    try {
      const body = await this.uow.run(async (tx) => {
        const actor = await this.sessions.resolveActorInTransaction(
          tx,
          getHeader(headers, "cookie"),
        );
        if (actor === undefined) {
          throw new ApiHttpError(
            401,
            DOCUMENT_IMPORT_SESSION_REQUIRED,
            "登录状态已失效，请重新登录",
          );
        }
        return handler(tx, actor.userId);
      });
      return projectDocumentImportPreviewResponseSchema.parse(body);
    } catch (error) {
      throw mapDocumentImportError(error);
    }
  }
  private async execute(input: {
    readonly headers: HttpHeaderBag;
    readonly operationId: "importProjectDocument" | "importProject";
    readonly path: string;
    readonly pathParams: Readonly<Record<string, string>>;
    readonly body: ProjectDocumentImportRequest;
    readonly run: (
      tx: TransactionContext,
      actorId: number,
    ) => Promise<ProjectDocumentImportResult>;
  }): Promise<ProjectDocumentImportResult> {
    if (mutationSameOriginValidationError(input.headers)) {
      throw new ApiHttpError(
        403,
        "CSRF_ORIGIN_REJECTED",
        "请求未通过同源安全校验",
      );
    }
    const resolve = async (tx: TransactionContext) => {
      const actor = await this.auth.verify(tx, input.headers);
      if (actor === undefined) {
        throw new ApiHttpError(
          401,
          DOCUMENT_IMPORT_SESSION_REQUIRED,
          "登录或 CSRF 状态已失效",
        );
      }
      return actor.userId;
    };
    try {
      const result = await this.idempotency.run({
        operationId: input.operationId,
        actorId: resolve,
        request: {
          method: "POST",
          path: input.path,
          pathParams: input.pathParams,
          query: {},
          headers: input.headers,
          body: input.body,
        },
        execute: async (tx, actorId) => {
          const body = await input.run(tx, actorId);
          return {
            responseStatus: 200,
            responseSchemaRef: "ProjectDocumentImportResult",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: replayContextOf(body),
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await resolve(tx);
          await this.workflow.replay(
            tx,
            actorId,
            projectDocumentImportReplayContextSchema.parse(
              record.replayAuthContext,
            ),
          );
        },
      });
      return projectDocumentImportResultSchema.parse(result.responseBody);
    } catch (error) {
      throw mapDocumentImportError(error);
    }
  }
}
function replayContextOf(
  result: ProjectDocumentImportResult,
): ProjectDocumentImportReplayContext {
  return {
    projectId: result.projectId,
    moduleIds: result.modules.map((item) => item.id),
    featureIds: result.features.map((item) => item.id),
    taskIds: result.tasks.map((item) => item.id),
  };
}

/** 业务错误统一映射为稳定 HTTP 错误体；未知错误保持原样由全局 Filter 处理。 */
function mapDocumentImportError(error: unknown): unknown {
  if (error instanceof ApiHttpError) {
    return error;
  }
  if (error instanceof DocumentImportError) {
    return new ApiHttpError(
      error.status,
      error.code,
      error.message,
      error.details,
    );
  }
  if (
    error instanceof IdempotencyHttpError ||
    error instanceof ProjectCodeConflictError ||
    error instanceof ProjectBootstrapValidationError ||
    error instanceof ProjectBootstrapConflictError ||
    error instanceof ModuleManagementError ||
    error instanceof FeatureManagementError ||
    error instanceof TaskManagementError ||
    error instanceof ProjectCapabilityAccessError ||
    error instanceof SearchProjectionCapacityError
  ) {
    return new ApiHttpError(error.status, error.code, error.message);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    return new ApiHttpError(
      409,
      "DOCUMENT_IMPORT_CONFLICT",
      "文档与现有数据冲突，请重新预览后重试",
    );
  }
  return error;
}
