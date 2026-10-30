import { Inject, Injectable } from "@nestjs/common";
import {
  moduleReplayContextSchema,
  type ModuleEditRequest,
  type ModuleItem,
} from "@inpulse/api-contract";
import { AuditWritePort } from "../../audit/index.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import { ActivityWritePort } from "../activity/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { SearchProjectionWritePort } from "../search/index.js";
import { ModuleManagementRepository } from "./module-management.repository.js";

/** ADR-044：模块层面下线归档，模块命令只剩创建与更新。 */
export type ModuleOperation = "createModule" | "updateModule";
export class ModuleManagementError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missing = () =>
  new ModuleManagementError(
    404,
    "MODULE_NOT_FOUND",
    "项目或模块不存在或无法访问",
  );
export function assertModuleTransition(
  current: Pick<ModuleItem, "rowVersion">,
  version: number,
): void {
  // ADR-044：模块只有 ACTIVE 一种状态，模块命令的唯一冲突源是版本落后。
  if (current.rowVersion !== version)
    throw new ModuleManagementError(
      409,
      "MODULE_VERSION_CONFLICT",
      "模块版本已变化，请重新加载后编辑",
    );
}

@Injectable()
export class ModulesManagementService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(ModuleManagementRepository)
    private readonly repository: ModuleManagementRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}

  async list(actorId: number, projectId: number) {
    // 普通读取使用包含归档项目的实时可读 scope，不调用 ACTIVE 写前检查。
    const scope = await this.access.getAuthorizedSearchScope(actorId);
    if (!scope.projectIds.includes(projectId)) throw missing();
    return {
      items: await this.uow.run((tx) => this.repository.list(tx, projectId)),
    };
  }

  async authorize(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    moduleId?: number,
  ): Promise<void> {
    const check = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (check.kind === "not-found") throw missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities: ["moduleEdit"],
    });
    // 先验证真实归属，避免向错误项目参数请求泄露资源状态。
    if (
      moduleId !== undefined &&
      !(await this.repository.find(tx, projectId, moduleId))
    )
      throw missing();
  }

  async replay(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const resource = moduleReplayContextSchema.parse(context);
    await this.authorize(tx, actorId, resource.projectId, resource.moduleId);
  }

  async execute(
    tx: TransactionContext,
    input: {
      operation: ModuleOperation;
      actorId: number;
      projectId: number;
      moduleId?: number;
      version?: number;
      edit?: ModuleEditRequest;
      requestId: string;
    },
  ): Promise<ModuleItem> {
    await this.authorize(tx, input.actorId, input.projectId, input.moduleId);
    const action = input.operation.replace("Module", "");
    let previous: ModuleItem | undefined;
    let result: ModuleItem;
    if (input.operation === "createModule") {
      result = await this.repository.create(
        tx,
        input.projectId,
        input.actorId,
        input.edit!,
      );
    } else {
      // 父项目共享锁在前；模块排他锁阻止与子级写前 FOR SHARE 检查并行。
      previous = await this.repository.find(
        tx,
        input.projectId,
        input.moduleId!,
        true,
      );
      if (!previous) throw missing();
      assertModuleTransition(previous, input.version!);
      const updated = await this.repository.update(tx, previous, {
        name: input.edit?.name ?? previous.name,
        description: input.edit?.description ?? previous.description,
      });
      if (!updated)
        throw new ModuleManagementError(
          409,
          "MODULE_VERSION_CONFLICT",
          "模块版本已变化，请重新加载后编辑",
        );
      result = updated;
    }
    const audit = await this.audit.append(tx, {
      projectId: result.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: `module.${action}`,
      targetType: "MODULE",
      targetId: String(result.id),
      eventPayload: {
        before: previous ?? null,
        after: result,
        reason: null,
      },
      requestId: input.requestId,
    });
    await this.activity.append(tx, {
      projectId: result.projectId,
      sourceChainId: audit.chainId,
      sourceSequence: audit.sequenceNo,
      sourceEntityType: "MODULE",
      sourceEntityId: result.id,
      activityType: `module.${action}`,
      actorId: input.actorId,
      summary: `模块${{ create: "创建", update: "更新" }[action] ?? action}：${result.name}`,
      metadata: { moduleId: result.id },
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
      sourceRowVersion: result.rowVersion,
      occurredAt: new Date(result.updatedAt),
    });
    await this.search.upsert(tx, {
      projectId: result.projectId,
      entityType: "MODULE",
      entityId: result.id,
      moduleId: null,
      recordId: null,
      title: result.name,
      summary: result.description.slice(0, 5000),
      rawText: `${result.name}\n${result.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
      sourceRowVersion: result.rowVersion,
    });
    return result;
  }
}
