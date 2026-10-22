import { Inject, Injectable } from "@nestjs/common";
import {
  DOCUMENT_IMPORT_MAX_MEMBERS,
  DOCUMENT_IMPORT_TEMPLATE_VERSION,
  type DocumentImportAssistTarget,
  type DocumentImportIssue,
  type DocumentImportMemberRef,
  type DocumentImportSummary,
  type ProjectDocumentImportPreviewResponse,
  type ProjectDocumentImportReplayContext,
  type ProjectDocumentImportResult,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";
import { AuditWritePort } from "../audit/audit.port.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectCodePort,
  ProjectMembersQueryPort,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";
import { ProjectCreationLockPort } from "../modules/projects/project-creation-lock.port.js";
import {
  ActiveUsersQueryPort,
  type ActiveUserTokenResolution,
} from "../modules/projects/projects-write.port.js";
import { ModuleReadPort } from "../modules/modules/index.js";
import { FeatureReadPort } from "../modules/features/index.js";
import { ModuleCreateCommandPort } from "../modules/modules/create.command-port.js";
import { FeatureCreateCommandPort } from "../modules/features/create.command-port.js";
import { TaskCreateCommandPort } from "../modules/tasks/create.command-port.js";
import { TaskQueryPort } from "../modules/tasks/index.js";
import {
  DocumentImportRunRepository,
  type DocumentImportDuplicateRecord,
} from "../modules/document-import/document-import-run.repository.js";
import {
  normalizeDocumentName,
  parseDocumentTemplate,
  type ParsedDocument,
  type ParsedTask,
  type ParsedTaskPriority,
} from "../modules/document-import/document-template.parser.js";
import { ProjectBootstrapWorkflow } from "../modules/projects/project-bootstrap.workflow.js";
import { UserReadPort } from "../auth/user-read.port.js";
import type { AiAssistTarget } from "../modules/document-import/ai-assist-target.js";

/** 文档导入的稳定业务错误；HTTP 映射由 document-import-http.service 负责。 */
export class DocumentImportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DocumentImportError";
  }
}

export type DocumentImportMode = "PROJECT" | "NEW_PROJECT";

export const DOCUMENT_IMPORT_INVALID_CODE = "DOCUMENT_IMPORT_INVALID";
export const DOCUMENT_IMPORT_DUPLICATE_CODE = "DOCUMENT_IMPORT_DUPLICATE";
export const DOCUMENT_IMPORT_STALE_CODE = "DOCUMENT_IMPORT_STALE";
export const DOCUMENT_IMPORT_PROJECT_NOT_FOUND_CODE = "PROJECT_NOT_FOUND";
export const DOCUMENT_IMPORT_TARGET_NOT_FOUND_CODE =
  "DOCUMENT_IMPORT_TARGET_NOT_FOUND";

interface PlannedModule {
  readonly line: number;
  readonly name: string;
  readonly description: string;
  readonly action: "CREATE" | "REUSE";
  readonly moduleId: number | null;
  readonly code: string | null;
}

interface PlannedFeature {
  readonly line: number;
  readonly moduleIndex: number;
  readonly featureIndex: number;
  readonly name: string;
  readonly currentBehavior: string;
  readonly acceptanceCriteria: string | null;
  readonly tags: readonly string[];
  readonly action: "CREATE" | "REUSE";
  readonly featureId: number | null;
  readonly code: string | null;
}

export type PlannedImpactRef =
  | { readonly kind: "local"; readonly featureIndex: number }
  | { readonly kind: "existing"; readonly featureId: number };

interface PlannedTask {
  readonly line: number;
  readonly scope: "FEATURE" | "MODULE";
  readonly moduleIndex: number;
  readonly featureIndex: number | null;
  readonly title: string;
  readonly assigneeIds: readonly number[];
  readonly assignees: readonly DocumentImportMemberRef[];
  readonly priority: ParsedTaskPriority;
  readonly dueAt: string | null;
  readonly description: string;
  readonly impactRefs: readonly PlannedImpactRef[];
}

interface PlannedProject {
  readonly line: number;
  readonly name: string;
  readonly code: string;
  readonly description: string;
  readonly memberIds: readonly number[];
  readonly members: readonly DocumentImportMemberRef[];
  readonly codeAvailable: boolean;
}

interface DocumentImportPlan {
  readonly digest: string;
  readonly issues: DocumentImportIssue[];
  readonly modules: readonly PlannedModule[];
  readonly features: readonly PlannedFeature[];
  readonly tasks: readonly PlannedTask[];
  readonly project: PlannedProject | null;
  readonly duplicate: DocumentImportDuplicateRecord | null;
  readonly summary: DocumentImportSummary;
}

/** issues 收集上限与契约一致，防止超大问题清单撑爆响应。 */
export const DOCUMENT_IMPORT_MAX_ISSUES = 5_000;

function pushIssue(
  issues: DocumentImportIssue[],
  issue: DocumentImportIssue,
): void {
  if (issues.length >= DOCUMENT_IMPORT_MAX_ISSUES) {
    return;
  }
  issues.push(issue);
}

function sameStringSets(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * ADR-064 文档导入编排。预览与执行共用同一份计划阶段（模式校验、成员解析、
 * 复用判定、查重），执行阶段在项目锁之后重新计算计划，保证预览与落库一致。
 * 只接收显式 `TransactionContext`；创建、审计、批次行与项目创建复用
 * 既有 CommandPort/Workflow，全部在同一事务内。
 */
@Injectable()
export class DocumentImportWorkflow {
  constructor(
    @Inject(ProjectCreationLockPort)
    private readonly projectLock: ProjectCreationLockPort,
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ActiveUsersQueryPort)
    private readonly activeUsers: ActiveUsersQueryPort,
    // ADR-073：整项目导入要把创建者默认算进项目成员，需要取创建者姓名做展示引用。
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(ProjectCodePort) private readonly codes: ProjectCodePort,
    @Inject(ModuleReadPort) private readonly moduleRead: ModuleReadPort,
    @Inject(FeatureReadPort) private readonly featureRead: FeatureReadPort,
    @Inject(TaskQueryPort) private readonly taskQuery: TaskQueryPort,
    @Inject(ModuleCreateCommandPort)
    private readonly moduleCreate: ModuleCreateCommandPort,
    @Inject(FeatureCreateCommandPort)
    private readonly featureCreate: FeatureCreateCommandPort,
    @Inject(TaskCreateCommandPort)
    private readonly taskCreate: TaskCreateCommandPort,
    @Inject(DocumentImportRunRepository)
    private readonly runs: DocumentImportRunRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ProjectBootstrapWorkflow)
    private readonly projectBootstrap: ProjectBootstrapWorkflow,
  ) {}

  /**
   * ADR-094：解析 AI 辅助转换目标。项目写权限与模块 / 功能的真实归属都在
   * 同一个只读短事务内校验；不存在与无权访问统一按 404，避免泄露资源存在性。
   * 调用方必须在事务外发起上游请求。
   */
  async resolveAssistTarget(
    tx: TransactionContext,
    actorId: number,
    target: DocumentImportAssistTarget,
  ): Promise<AiAssistTarget> {
    const access = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId: target.projectId,
    });
    if (access.kind === "not-found") {
      throw this.targetNotFound();
    }
    if (target.moduleId === null) {
      return { kind: "PROJECT_ROOT", projectId: target.projectId };
    }
    const module = await this.moduleRead.find(
      tx,
      target.projectId,
      target.moduleId,
    );
    if (module === undefined) {
      throw this.targetNotFound();
    }
    if (target.featureId === null) {
      return {
        kind: "MODULE",
        projectId: target.projectId,
        moduleId: module.moduleId,
        moduleName: module.name,
      };
    }
    const feature = await this.featureRead.find(
      tx,
      target.projectId,
      target.moduleId,
      target.featureId,
    );
    if (feature === undefined) {
      throw this.targetNotFound();
    }
    return {
      kind: "FEATURE",
      projectId: target.projectId,
      moduleId: module.moduleId,
      moduleName: module.name,
      featureId: feature.featureId,
      featureName: feature.name,
    };
  }

  private issuePush(
    issues: DocumentImportIssue[],
    severity: "ERROR" | "WARNING",
    line: number,
    code: string,
    message: string,
  ): void {
    pushIssue(issues, { severity, line, code, message });
  }

  private async resolveTokens(
    tx: TransactionContext,
    tokens: readonly string[],
  ): Promise<ReadonlyMap<string, ActiveUserTokenResolution>> {
    const normalized = [
      ...new Set(tokens.map((token) => normalizeDocumentName(token))),
    ];
    if (normalized.length === 0) {
      return new Map();
    }
    const resolutions = await this.activeUsers.resolveActiveUsersByTokens(
      tx,
      normalized,
    );
    return new Map(resolutions.map((item) => [item.token, item]));
  }

  /**
   * 计划阶段：解析结果 + 数据库事实（成员、复用、查重、编码占用）合成
   * 可展示、可执行的计划。任何 ERROR 都会让预览/执行以 422 拒绝。
   */
  private async preparePlan(
    tx: TransactionContext,
    input: {
      readonly mode: DocumentImportMode;
      readonly projectId: number | null;
      readonly creatorUserId: number;
      readonly parsed: ParsedDocument;
    },
  ): Promise<DocumentImportPlan> {
    const issues: DocumentImportIssue[] = [...input.parsed.issues];
    const error = (line: number, code: string, message: string): void =>
      this.issuePush(issues, "ERROR", line, code, message);
    const warning = (line: number, code: string, message: string): void =>
      this.issuePush(issues, "WARNING", line, code, message);

    const project = input.parsed.project;
    if (input.mode === "PROJECT" && project !== null) {
      error(
        project.line,
        "PROJECT_SECTION_NOT_ALLOWED",
        "项目内导入的文档不能包含项目段（# 项目：……）；如需创建新项目请改用整项目导入",
      );
    }
    if (input.mode === "NEW_PROJECT" && project === null) {
      error(
        1,
        "PROJECT_SECTION_REQUIRED",
        "整项目导入的文档必须以「# 项目：名称」开头，并填写项目编码",
      );
    }

    let codeAvailable = false;
    if (input.mode === "NEW_PROJECT" && project !== null) {
      if (project.code === null) {
        error(
          project.line,
          "PROJECT_CODE_REQUIRED",
          "项目编码必填：请在项目段使用「- 项目编码：SHOP」填写（大写字母开头，长度 2～32）",
        );
      } else if (input.projectId === null) {
        codeAvailable = await this.codes.isCodeAvailable(tx, project.code);
      }
    }

    const tokens: string[] = [];
    for (const token of project?.memberTokens ?? []) {
      tokens.push(token);
    }
    for (const module of input.parsed.modules) {
      for (const feature of module.features) {
        for (const task of feature.tasks) {
          for (const token of task.assigneeTokens) {
            tokens.push(token);
          }
        }
      }
      for (const task of module.tasks) {
        for (const token of task.assigneeTokens) {
          tokens.push(token);
        }
      }
    }
    const byToken = await this.resolveTokens(tx, tokens);

    const modules = await this.planModules(tx, input, error, warning);
    const features = await this.planFeatures(
      tx,
      input,
      modules,
      error,
      warning,
    );
    const tasks = await this.planTasks(tx, input, modules, byToken, error);

    if (input.mode === "PROJECT" && input.projectId !== null) {
      const activeMemberIds = new Set(
        await this.members.listActiveMemberIds(tx, {
          projectId: input.projectId,
        }),
      );
      for (const task of tasks) {
        for (const ref of task.assignees) {
          if (!activeMemberIds.has(ref.userId)) {
            error(
              task.line,
              "ASSIGNEE_NOT_MEMBER",
              "负责人「" +
                ref.token +
                "」不是当前项目的活跃成员；请先把他加入项目成员",
            );
          }
        }
      }
    }

    let plannedProject: PlannedProject | null = null;
    if (input.mode === "NEW_PROJECT" && project !== null) {
      const memberIds: number[] = [];
      const members: DocumentImportMemberRef[] = [];
      const seen = new Set<number>();
      const addMember = (ref: DocumentImportMemberRef): void => {
        if (seen.has(ref.userId)) {
          return;
        }
        seen.add(ref.userId);
        memberIds.push(ref.userId);
        members.push(ref);
      };
      // ADR-073：创建者默认就算项目成员（文档写不写都加入），名单第一位固定是创建者；
      // 因此 memberIds / members / summary.memberAddCount 现在都含创建者（与落库的成员行一致）。
      // 这里读姓名只为预览展示（UserReadPort 是展示用只读端口，返回停用用户；创建者来自
      // 当前有效会话，不参与成员资格判据）。
      const creatorRef = (
        await this.users.listByIds(tx, [input.creatorUserId])
      )[0];
      if (creatorRef !== undefined) {
        addMember({
          token: creatorRef.name,
          userId: creatorRef.userId,
          name: creatorRef.name,
        });
      }
      /** 判「名单是否完整」用的账号：文档写出的成员 + 默认在内的创建者。 */
      const listedUserIds = new Set<number>([input.creatorUserId]);
      for (const token of project.memberTokens) {
        const resolution = byToken.get(normalizeDocumentName(token));
        if (resolution === undefined || resolution.kind === "not-found") {
          error(
            project.line,
            "MEMBER_UNRESOLVED",
            "项目成员「" + token + "」未找到匹配的启用用户；请使用登录名或姓名",
          );
          continue;
        }
        if (resolution.kind === "ambiguous") {
          error(
            project.line,
            "MEMBER_AMBIGUOUS",
            "项目成员「" + token + "」匹配到多个用户，请改用登录名",
          );
          continue;
        }
        listedUserIds.add(resolution.userId);
        addMember({ token, userId: resolution.userId, name: resolution.name });
      }
      if (project.memberTokens.length === 0) {
        error(
          project.line,
          "MEMBER_REQUIRED",
          "整项目导入必须用「- 项目成员：」列出成员，且须包含创建者本人与全部任务负责人",
        );
      } else {
        const reportedAssignees = new Set<number>();
        for (const task of tasks) {
          for (const ref of task.assignees) {
            if (
              listedUserIds.has(ref.userId) ||
              reportedAssignees.has(ref.userId)
            ) {
              continue;
            }
            reportedAssignees.add(ref.userId);
            error(
              task.line,
              "ASSIGNEE_NOT_INITIAL_MEMBER",
              "任务负责人「" +
                ref.token +
                "」没有出现在「- 项目成员：」里；请把 TA 也写进项目成员",
            );
          }
        }
      }
      // 负责人照样自动并入成员集合：上方的 ERROR 会拦住导入，这里是兜底（创建者已在上面并入过）。
      for (const task of tasks) {
        for (const ref of task.assignees) {
          addMember(ref);
        }
      }
      if (memberIds.length > DOCUMENT_IMPORT_MAX_MEMBERS) {
        error(
          project.line,
          "MEMBER_LIMIT_EXCEEDED",
          "项目成员（含创建者）与任务负责人合计超过 " +
            String(DOCUMENT_IMPORT_MAX_MEMBERS) +
            " 人上限",
        );
      }
      plannedProject = {
        line: project.line,
        name: project.name,
        code: project.code ?? "",
        description: project.description,
        memberIds,
        members,
        codeAvailable,
      };
    }

    const duplicate =
      (input.mode === "PROJECT" && input.projectId !== null
        ? await this.runs.findDuplicateInProject(
            tx,
            input.projectId,
            input.parsed.digest,
          )
        : await this.runs.findDuplicateGlobally(tx, input.parsed.digest)) ??
      null;

    const summary: DocumentImportSummary = {
      moduleCount: modules.length,
      featureCount: features.length,
      taskCount: tasks.length,
      moduleCreateCount: modules.filter((item) => item.action === "CREATE")
        .length,
      moduleReuseCount: modules.filter((item) => item.action === "REUSE")
        .length,
      featureCreateCount: features.filter((item) => item.action === "CREATE")
        .length,
      featureReuseCount: features.filter((item) => item.action === "REUSE")
        .length,
      taskCreateCount: tasks.length,
      memberAddCount: plannedProject?.memberIds.length ?? 0,
    };

    issues.sort((a, b) => a.line - b.line);
    return {
      digest: input.parsed.digest,
      issues,
      modules,
      features,
      tasks,
      project: plannedProject,
      duplicate,
      summary,
    };
  }

  private async planModules(
    tx: TransactionContext,
    input: {
      readonly mode: DocumentImportMode;
      readonly projectId: number | null;
      readonly parsed: ParsedDocument;
    },
    error: (line: number, code: string, message: string) => void,
    warning: (line: number, code: string, message: string) => void,
  ): Promise<PlannedModule[]> {
    const planned: PlannedModule[] = [];
    for (const module of input.parsed.modules) {
      if (input.mode === "NEW_PROJECT" || input.projectId === null) {
        planned.push({
          line: module.line,
          name: module.name,
          description: module.description,
          action: "CREATE",
          moduleId: null,
          code: null,
        });
        continue;
      }
      const matches = await this.moduleRead.matchByName(
        tx,
        input.projectId,
        normalizeDocumentName(module.name),
      );
      const fallback: PlannedModule = {
        line: module.line,
        name: module.name,
        description: module.description,
        action: "CREATE",
        moduleId: null,
        code: null,
      };
      if (matches.length === 0) {
        planned.push(fallback);
        continue;
      }
      const active = matches.filter((item) => !item.deleted);
      if (active.length === 0) {
        error(
          module.line,
          "MODULE_NAME_TAKEN_DELETED",
          "模块「" +
            module.name +
            "」与一个已删除的同名模块冲突，既不能复用也无法新建；请更换名称",
        );
        planned.push(fallback);
        continue;
      }
      if (active.length > 1) {
        error(
          module.line,
          "MODULE_NAME_AMBIGUOUS",
          "项目内存在多个同名模块「" + module.name + "」，无法确定复用对象",
        );
        planned.push(fallback);
        continue;
      }
      const existing = active[0]!;
      if (
        module.description !== "" &&
        module.description !== existing.description
      ) {
        warning(
          module.line,
          "MODULE_REUSE_DIFFERS",
          "模块「" +
            module.name +
            "」已存在且说明与文档不一致；复用不会覆盖现有内容",
        );
      }
      planned.push({
        line: module.line,
        name: module.name,
        description: module.description,
        action: "REUSE",
        moduleId: existing.moduleId,
        code: existing.code,
      });
    }
    return planned;
  }

  private async planFeatures(
    tx: TransactionContext,
    input: {
      readonly mode: DocumentImportMode;
      readonly projectId: number | null;
      readonly parsed: ParsedDocument;
    },
    modules: readonly PlannedModule[],
    error: (line: number, code: string, message: string) => void,
    warning: (line: number, code: string, message: string) => void,
  ): Promise<PlannedFeature[]> {
    const planned: PlannedFeature[] = [];
    for (const [moduleIndex, module] of input.parsed.modules.entries()) {
      const modulePlan = modules[moduleIndex]!;
      for (const [featureIndex, feature] of module.features.entries()) {
        const fallback: PlannedFeature = {
          line: feature.line,
          moduleIndex,
          featureIndex,
          name: feature.name,
          currentBehavior: feature.currentBehavior,
          acceptanceCriteria: feature.acceptanceCriteria,
          tags: feature.tags,
          action: "CREATE",
          featureId: null,
          code: null,
        };
        const reuseScope =
          input.mode === "PROJECT" &&
          input.projectId !== null &&
          modulePlan.action === "REUSE" &&
          modulePlan.moduleId !== null;
        if (!reuseScope) {
          planned.push(fallback);
          continue;
        }
        const matches = await this.featureRead.matchByName(
          tx,
          input.projectId!,
          modulePlan.moduleId!,
          normalizeDocumentName(feature.name),
        );
        const active = matches.filter((item) => !item.deleted);
        if (active.length > 1) {
          error(
            feature.line,
            "FEATURE_NAME_AMBIGUOUS",
            "模块内存在多个同名功能「" + feature.name + "」，无法确定复用对象",
          );
          planned.push(fallback);
          continue;
        }
        if (active.length === 0) {
          planned.push(fallback);
          continue;
        }
        const existing = active[0]!;
        const behaviorDiffers =
          feature.currentBehavior !== "" &&
          feature.currentBehavior !== existing.currentBehavior;
        const acceptanceDiffers =
          feature.acceptanceCriteria !== null &&
          feature.acceptanceCriteria !== existing.acceptanceCriteria;
        const tagsDiffer =
          feature.tags.length > 0 &&
          !sameStringSets(feature.tags, existing.tags);
        if (behaviorDiffers || acceptanceDiffers || tagsDiffer) {
          warning(
            feature.line,
            "FEATURE_REUSE_DIFFERS",
            "功能「" +
              feature.name +
              "」已存在且当前说明/验收标准/标签与文档不一致；复用不会覆盖现有内容",
          );
        }
        planned.push({
          ...fallback,
          action: "REUSE",
          featureId: existing.featureId,
          code: existing.code,
        });
      }
    }
    return planned;
  }

  private async planTasks(
    tx: TransactionContext,
    input: {
      readonly mode: DocumentImportMode;
      readonly projectId: number | null;
      readonly parsed: ParsedDocument;
    },
    modules: readonly PlannedModule[],
    byToken: ReadonlyMap<string, ActiveUserTokenResolution>,
    error: (line: number, code: string, message: string) => void,
  ): Promise<PlannedTask[]> {
    const planned: PlannedTask[] = [];
    for (const [moduleIndex, module] of input.parsed.modules.entries()) {
      const modulePlan = modules[moduleIndex]!;
      const entries: {
        readonly task: ParsedTask;
        readonly featureIndex: number | null;
      }[] = [];
      for (const [featureIndex, feature] of module.features.entries()) {
        for (const task of feature.tasks) {
          entries.push({ task, featureIndex });
        }
      }
      for (const task of module.tasks) {
        entries.push({ task, featureIndex: null });
      }
      entries.sort((a, b) => a.task.line - b.task.line);
      for (const entry of entries) {
        const assignees: DocumentImportMemberRef[] = [];
        const assigneeIds = new Set<number>();
        for (const token of entry.task.assigneeTokens) {
          const resolution = byToken.get(normalizeDocumentName(token));
          if (resolution === undefined || resolution.kind === "not-found") {
            error(
              entry.task.line,
              "ASSIGNEE_UNRESOLVED",
              "负责人「" + token + "」未找到匹配的启用用户；请使用登录名或姓名",
            );
            continue;
          }
          if (resolution.kind === "ambiguous") {
            error(
              entry.task.line,
              "ASSIGNEE_AMBIGUOUS",
              "负责人「" + token + "」匹配到多个用户，请改用登录名",
            );
            continue;
          }
          if (assigneeIds.has(resolution.userId)) {
            continue;
          }
          assigneeIds.add(resolution.userId);
          assignees.push({
            token,
            userId: resolution.userId,
            name: resolution.name,
          });
        }
        let impactRefs: PlannedImpactRef[] = [];
        if (entry.task.scope === "MODULE") {
          impactRefs = await this.resolveImpactRefs(
            tx,
            input,
            module,
            modulePlan,
            entry.task,
            error,
          );
        }
        planned.push({
          line: entry.task.line,
          scope: entry.task.scope,
          moduleIndex,
          featureIndex: entry.featureIndex,
          title: entry.task.title,
          assigneeIds: [...assigneeIds].sort((a, b) => a - b),
          assignees,
          priority: entry.task.priority,
          dueAt: entry.task.dueAt,
          description: entry.task.description,
          impactRefs,
        });
      }
    }
    return planned;
  }

  private async resolveImpactRefs(
    tx: TransactionContext,
    input: {
      readonly mode: DocumentImportMode;
      readonly projectId: number | null;
    },
    module: ParsedDocument["modules"][number],
    modulePlan: PlannedModule,
    task: ParsedTask,
    error: (line: number, code: string, message: string) => void,
  ): Promise<PlannedImpactRef[]> {
    const refs: PlannedImpactRef[] = [];
    for (const name of task.impactFeatureNames) {
      const normalized = normalizeDocumentName(name);
      const localIndex = module.features.findIndex(
        (feature) => normalizeDocumentName(feature.name) === normalized,
      );
      if (localIndex >= 0) {
        refs.push({ kind: "local", featureIndex: localIndex });
        continue;
      }
      const canLookupExisting =
        input.mode === "PROJECT" &&
        input.projectId !== null &&
        modulePlan.action === "REUSE" &&
        modulePlan.moduleId !== null;
      if (canLookupExisting) {
        const matches = await this.featureRead.matchByName(
          tx,
          input.projectId!,
          modulePlan.moduleId!,
          normalized,
        );
        const active = matches.filter((item) => !item.deleted);
        if (active.length === 1) {
          refs.push({ kind: "existing", featureId: active[0]!.featureId });
          continue;
        }
        if (active.length > 1) {
          error(
            task.line,
            "IMPACT_FEATURE_AMBIGUOUS",
            "影响功能「" + name + "」匹配到多个功能，无法确定引用对象",
          );
          continue;
        }
      }
      error(
        task.line,
        "IMPACT_FEATURE_UNRESOLVED",
        "影响功能「" +
          name +
          "」在模块「" +
          module.name +
          "」内不存在；请先在本模块定义该功能",
      );
    }
    return refs;
  }

  /** 项目内导入预览：只读不写库，返回计划、行级问题与重复导入提示。 */
  async previewInProject(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    text: string,
  ): Promise<ProjectDocumentImportPreviewResponse> {
    const access = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (access.kind === "not-found") {
      throw this.projectNotFound();
    }
    const parsed = parseDocumentTemplate(text);
    const plan = await this.preparePlan(tx, {
      mode: "PROJECT",
      projectId,
      creatorUserId: actorId,
      parsed,
    });
    this.assertNoErrors(plan.issues);
    return this.buildPreviewResponse(plan, parsed);
  }

  /** 整项目导入预览：任何已登录用户可调用；校验编码、成员与全部下级计划。 */
  async previewNewProject(
    tx: TransactionContext,
    actorId: number,
    text: string,
  ): Promise<ProjectDocumentImportPreviewResponse> {
    const parsed = parseDocumentTemplate(text);
    const plan = await this.preparePlan(tx, {
      mode: "NEW_PROJECT",
      projectId: null,
      creatorUserId: actorId,
      parsed,
    });
    this.assertNoErrors(plan.issues);
    return this.buildPreviewResponse(plan, parsed);
  }

  /**
   * 项目内导入执行：项目锁 → 写权限 → 摘要一致性 → 重新计划 → 单事务创建。
   * 计划含 ERROR 时整笔 422；同摘要批次已存在时 409；绝不部分落库。
   */
  async executeInProject(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    text: string,
    expectedDigest: string,
    requestId: string,
  ): Promise<ProjectDocumentImportResult> {
    await this.projectLock.lock(tx, projectId);
    const access = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (access.kind === "not-found") {
      throw this.projectNotFound();
    }
    const parsed = parseDocumentTemplate(text);
    if (parsed.digest !== expectedDigest) {
      throw this.staleDocument();
    }
    const plan = await this.preparePlan(tx, {
      mode: "PROJECT",
      projectId,
      creatorUserId: actorId,
      parsed,
    });
    this.assertNoErrors(plan.issues);
    if (plan.duplicate !== null) {
      throw this.duplicateDocument(plan.duplicate);
    }
    const code = await this.codes.findProjectCode(tx, projectId);
    if (code === undefined) {
      throw this.projectNotFound();
    }
    return this.finishImport(tx, {
      actorId,
      projectId,
      projectCode: code,
      plan,
      requestId,
      addedMemberCount: 0,
    });
  }

  /**
   * 整项目导入执行：编码唯一约束兜底并发；先创建项目与全部成员（含任务负责人
   * 自动加入），再按文档创建模块、功能与任务，批次行与审计同一事务。
   */
  async executeNewProject(
    tx: TransactionContext,
    actorId: number,
    text: string,
    expectedDigest: string,
    requestId: string,
  ): Promise<ProjectDocumentImportResult> {
    const parsed = parseDocumentTemplate(text);
    if (parsed.digest !== expectedDigest) {
      throw this.staleDocument();
    }
    const plan = await this.preparePlan(tx, {
      mode: "NEW_PROJECT",
      projectId: null,
      creatorUserId: actorId,
      parsed,
    });
    this.assertNoErrors(plan.issues);
    if (plan.duplicate !== null) {
      throw this.duplicateDocument(plan.duplicate);
    }
    if (plan.project === null) {
      throw new DocumentImportError(
        422,
        DOCUMENT_IMPORT_INVALID_CODE,
        "整项目导入文档缺少项目段",
        { issues: [] },
      );
    }
    const bootstrap = await this.projectBootstrap.execute(tx, actorId, {
      name: plan.project.name,
      code: plan.project.code,
      description: plan.project.description,
      memberIds: [...plan.project.memberIds],
    });
    return this.finishImport(tx, {
      actorId,
      projectId: bootstrap.body.project.id,
      projectCode: bootstrap.body.project.code,
      plan,
      requestId,
      addedMemberCount: plan.project.members.length,
    });
  }

  /**
   * 幂等重放授权：重新验证当前认证（由调用方完成）与项目及全部结果资源的
   * 当前可读权限；任一缺失按 404 拒绝，不泄露已存响应。
   */
  async replay(
    tx: TransactionContext,
    actorId: number,
    context: ProjectDocumentImportReplayContext,
  ): Promise<void> {
    const access = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId: context.projectId,
    });
    if (access.kind === "not-found") {
      throw this.projectNotFound();
    }
    const missing = (): DocumentImportError =>
      new DocumentImportError(
        404,
        DOCUMENT_IMPORT_PROJECT_NOT_FOUND_CODE,
        "项目或结果资源不存在",
      );
    if (context.moduleIds.length > 0) {
      const found = await this.moduleRead.listNames(tx, {
        projectIds: [context.projectId],
        moduleIds: context.moduleIds,
      });
      if (found.length !== new Set(context.moduleIds).size) {
        throw missing();
      }
    }
    if (context.featureIds.length > 0) {
      const found = await this.featureRead.listNames(tx, {
        projectIds: [context.projectId],
        featureIds: context.featureIds,
      });
      if (found.length !== new Set(context.featureIds).size) {
        throw missing();
      }
    }
    if (context.taskIds.length > 0) {
      const found = await this.taskQuery.listByIds(
        tx,
        [context.projectId],
        context.taskIds,
      );
      if (found.length !== new Set(context.taskIds).size) {
        throw missing();
      }
    }
  }

  private assertNoErrors(issues: readonly DocumentImportIssue[]): void {
    const errors = issues.filter((issue) => issue.severity === "ERROR");
    if (errors.length > 0) {
      throw new DocumentImportError(
        422,
        DOCUMENT_IMPORT_INVALID_CODE,
        "文档存在错误，请修正后重试",
        { issues },
      );
    }
  }

  private staleDocument(): DocumentImportError {
    return new DocumentImportError(
      409,
      DOCUMENT_IMPORT_STALE_CODE,
      "文档内容与预览结果不一致，请重新预览后再执行",
    );
  }

  private duplicateDocument(
    duplicate: DocumentImportDuplicateRecord,
  ): DocumentImportError {
    return new DocumentImportError(
      409,
      DOCUMENT_IMPORT_DUPLICATE_CODE,
      "同一文档已导入过，请勿重复导入",
      {
        projectId: duplicate.projectId,
        importedAt: duplicate.importedAt,
        actorName: duplicate.actorName,
      },
    );
  }

  private projectNotFound(): DocumentImportError {
    return new DocumentImportError(
      404,
      DOCUMENT_IMPORT_PROJECT_NOT_FOUND_CODE,
      "项目不存在或无法访问",
    );
  }

  private targetNotFound(): DocumentImportError {
    return new DocumentImportError(
      404,
      DOCUMENT_IMPORT_TARGET_NOT_FOUND_CODE,
      "目标位置不存在或无法访问",
    );
  }

  private async finishImport(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly projectCode: string;
      readonly plan: DocumentImportPlan;
      readonly requestId: string;
      readonly addedMemberCount: number;
    },
  ): Promise<ProjectDocumentImportResult> {
    try {
      const created = await this.createEntities(
        tx,
        input.actorId,
        input.projectId,
        input.plan,
        input.requestId,
      );
      await this.runs.insert(tx, {
        projectId: input.projectId,
        documentDigest: input.plan.digest,
        templateVersion: DOCUMENT_IMPORT_TEMPLATE_VERSION,
        actorId: input.actorId,
        moduleCount: input.plan.summary.moduleCreateCount,
        featureCount: input.plan.summary.featureCreateCount,
        taskCount: input.plan.summary.taskCreateCount,
        reusedModuleCount: input.plan.summary.moduleReuseCount,
        reusedFeatureCount: input.plan.summary.featureReuseCount,
        addedMemberCount: input.addedMemberCount,
      });
      await this.audit.append(tx, {
        projectId: input.projectId,
        actorType: "USER",
        actorId: input.actorId,
        action: "project.documentImport",
        targetType: "PROJECT",
        targetId: String(input.projectId),
        eventPayload: {
          digest: input.plan.digest,
          templateVersion: DOCUMENT_IMPORT_TEMPLATE_VERSION,
          moduleCount: input.plan.summary.moduleCount,
          featureCount: input.plan.summary.featureCount,
          taskCount: input.plan.summary.taskCount,
          createdModuleCount: input.plan.summary.moduleCreateCount,
          createdFeatureCount: input.plan.summary.featureCreateCount,
          reusedModuleCount: input.plan.summary.moduleReuseCount,
          reusedFeatureCount: input.plan.summary.featureReuseCount,
          addedMemberCount: input.addedMemberCount,
        },
        requestId: input.requestId,
      });
      return this.buildResult({
        projectId: input.projectId,
        projectCode: input.projectCode,
        plan: input.plan,
        created,
      });
    } catch (error) {
      if (
        uniqueViolation(error, "document_import_runs_project_digest_unique")
      ) {
        throw new DocumentImportError(
          409,
          DOCUMENT_IMPORT_DUPLICATE_CODE,
          "同一文档已导入过，请勿重复导入",
        );
      }
      if (uniqueViolation(error, "modules_name_project_unique")) {
        throw new DocumentImportError(
          409,
          "DOCUMENT_IMPORT_CONFLICT",
          "模块名称与现有模块冲突，请重新预览后重试",
        );
      }
      throw error;
    }
  }

  private async createEntities(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    plan: DocumentImportPlan,
    requestId: string,
  ): Promise<CreatedEntities> {
    const moduleIds: number[] = [];
    const modules: { id: number; code: string }[] = [];
    for (const module of plan.modules) {
      if (module.action === "REUSE" && module.moduleId !== null) {
        moduleIds.push(module.moduleId);
        modules.push({ id: module.moduleId, code: module.code ?? "" });
        continue;
      }
      const created = await this.moduleCreate.create(
        tx,
        actorId,
        projectId,
        { name: module.name, description: module.description },
        requestId,
      );
      moduleIds.push(created.id);
      modules.push({ id: created.id, code: created.code });
    }

    const plannedFeatureIndex = new Map<string, number>();
    for (const [index, feature] of plan.features.entries()) {
      plannedFeatureIndex.set(
        String(feature.moduleIndex) + ":" + String(feature.featureIndex),
        index,
      );
    }

    const featureIds: number[] = [];
    const features: { id: number; code: string; moduleId: number }[] = [];
    for (const [index, feature] of plan.features.entries()) {
      const moduleId = moduleIds[feature.moduleIndex];
      if (moduleId === undefined) {
        throw new Error("document import plan has an unknown module index");
      }
      if (feature.action === "REUSE" && feature.featureId !== null) {
        featureIds[index] = feature.featureId;
        features.push({
          id: feature.featureId,
          code: feature.code ?? "",
          moduleId,
        });
        continue;
      }
      const created = await this.featureCreate.create(
        tx,
        actorId,
        projectId,
        moduleId,
        {
          name: feature.name,
          currentBehavior: feature.currentBehavior,
          ...(feature.acceptanceCriteria === null
            ? {}
            : { acceptanceCriteria: feature.acceptanceCriteria }),
          tags: [...feature.tags],
        },
        requestId,
      );
      featureIds[index] = created.id;
      features.push({ id: created.id, code: created.code, moduleId });
    }

    const tasks: CreatedTaskResult[] = [];
    for (const task of plan.tasks) {
      const moduleId = moduleIds[task.moduleIndex];
      if (moduleId === undefined) {
        throw new Error("document import plan has an unknown module index");
      }
      let featureId: number | null = null;
      if (task.scope === "FEATURE" && task.featureIndex !== null) {
        const key = String(task.moduleIndex) + ":" + String(task.featureIndex);
        const plannedIndex = plannedFeatureIndex.get(key);
        if (plannedIndex === undefined) {
          throw new Error("document import plan has an unknown feature index");
        }
        featureId = featureIds[plannedIndex] ?? null;
      }
      let impactFeatureIds: number[] = [];
      if (task.scope === "MODULE" && task.impactRefs.length > 0) {
        impactFeatureIds = task.impactRefs
          .map((ref): number | null => {
            if (ref.kind === "existing") {
              return ref.featureId;
            }
            const key =
              String(task.moduleIndex) + ":" + String(ref.featureIndex);
            const plannedIndex = plannedFeatureIndex.get(key);
            if (plannedIndex === undefined) {
              return null;
            }
            return featureIds[plannedIndex] ?? null;
          })
          .filter((id): id is number => id !== null);
      }
      const created = await this.taskCreate.create(
        tx,
        actorId,
        { projectId, moduleId, featureId, impactFeatureIds },
        {
          title: task.title,
          description: task.description,
          priority: task.priority,
          assigneeIds: [...task.assigneeIds],
          dueAt: task.dueAt,
        },
        requestId,
      );
      tasks.push({
        id: created.id,
        code: created.code,
        moduleId,
        featureId: task.scope === "FEATURE" ? featureId : null,
        scopeType: task.scope,
      });
    }
    return { modules, features, tasks };
  }

  private buildPreviewResponse(
    plan: DocumentImportPlan,
    parsed: ParsedDocument,
  ): ProjectDocumentImportPreviewResponse {
    return {
      digest: plan.digest,
      templateVersion: DOCUMENT_IMPORT_TEMPLATE_VERSION,
      project:
        plan.project === null
          ? null
          : {
              name: plan.project.name,
              code: plan.project.code,
              description: plan.project.description,
              codeAvailable: plan.project.codeAvailable,
              members: plan.project.members.map((ref) => ({ ...ref })),
            },
      summary: plan.summary,
      modules: plan.modules.map((module) => ({
        line: module.line,
        name: module.name,
        action: module.action,
        moduleId: module.moduleId,
      })),
      features: plan.features.map((feature) => ({
        line: feature.line,
        moduleName: parsed.modules[feature.moduleIndex]!.name,
        name: feature.name,
        action: feature.action,
        featureId: feature.featureId,
      })),
      tasks: plan.tasks.map((task) => ({
        line: task.line,
        scope: task.scope,
        moduleName: parsed.modules[task.moduleIndex]!.name,
        featureName:
          task.featureIndex === null
            ? null
            : parsed.modules[task.moduleIndex]!.features[task.featureIndex]!
                .name,
        title: task.title,
        assignees: task.assignees.map((ref) => ({ ...ref })),
        priority: task.priority,
        dueAt: task.dueAt,
      })),
      issues: plan.issues,
      canApply:
        plan.duplicate === null &&
        (plan.project === null || plan.project.codeAvailable),
      duplicate:
        plan.duplicate === null
          ? null
          : {
              projectId: plan.duplicate.projectId,
              importedAt: plan.duplicate.importedAt,
              actorName: plan.duplicate.actorName,
            },
    };
  }

  private buildResult(input: {
    readonly projectId: number;
    readonly projectCode: string;
    readonly plan: DocumentImportPlan;
    readonly created: CreatedEntities;
  }): ProjectDocumentImportResult {
    return {
      projectId: input.projectId,
      projectCode: input.projectCode,
      digest: input.plan.digest,
      counts: {
        modules: input.plan.summary.moduleCreateCount,
        features: input.plan.summary.featureCreateCount,
        tasks: input.plan.summary.taskCreateCount,
        reusedModules: input.plan.summary.moduleReuseCount,
        reusedFeatures: input.plan.summary.featureReuseCount,
        addedMembers: input.plan.summary.memberAddCount,
      },
      modules: input.created.modules,
      features: input.created.features,
      tasks: input.created.tasks,
    };
  }
}

interface CreatedEntities {
  modules: { id: number; code: string }[];
  features: { id: number; code: string; moduleId: number }[];
  tasks: CreatedTaskResult[];
}

interface CreatedTaskResult {
  readonly id: number;
  readonly code: string;
  readonly moduleId: number;
  readonly featureId: number | null;
  readonly scopeType: "FEATURE" | "MODULE";
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === constraint
  );
}
