import { SearchProjectionCapacityError } from "../modules/search/public/search-projection-errors.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  taskCreateResultSchema,
  type TaskCreateRequest,
} from "@inpulse/api-contract";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../idempotency/http-service.js";
import { ApiHttpError } from "../http/contract-errors.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import { ModuleManagementError } from "../modules/modules/modules-management.service.js";
import { FeatureManagementError } from "../modules/features/features-management.service.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import { TaskCreateWorkflow } from "./task-create.workflow.js";
@Injectable()
export class TaskCreateHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly auth: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TaskCreateWorkflow) private readonly workflow: TaskCreateWorkflow,
  ) {}
  async create(
    headers: HttpHeaderBag,
    projectId: number,
    input: TaskCreateRequest,
  ) {
    if (mutationSameOriginValidationError(headers))
      throw new ApiHttpError(
        403,
        "CSRF_ORIGIN_REJECTED",
        "请求未通过同源安全校验",
      );
    const resolve = async (tx: TransactionContext) => {
      const actor = await this.auth.verify(tx, headers);
      if (!actor)
        throw new ApiHttpError(
          401,
          "TASK_SESSION_REQUIRED",
          "登录或 CSRF 状态已失效",
        );
      return actor.userId;
    };
    try {
      const result = await this.idempotency.run({
        operationId: "createTaskWithScope",
        actorId: resolve,
        request: {
          method: "POST",
          path: "/projects/{projectId}/tasks",
          pathParams: { projectId: String(projectId) },
          query: {},
          headers,
          body: input,
        },
        execute: async (tx, actorId) => {
          const body = await this.workflow.execute(
            tx,
            actorId,
            projectId,
            input,
            randomUUID(),
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "TaskCreateResult",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: body,
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await resolve(tx);
          await this.workflow.replay(
            tx,
            actorId,
            taskCreateResultSchema.parse(record.replayAuthContext),
            input,
          );
        },
      });
      return taskCreateResultSchema.parse(result.responseBody);
    } catch (error) {
      if (
        error instanceof TaskManagementError ||
        error instanceof ModuleManagementError ||
        error instanceof FeatureManagementError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError ||
        error instanceof SearchProjectionCapacityError
      )
        throw new ApiHttpError(error.status, error.code, error.message);
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        throw new ApiHttpError(
          409,
          "TASK_SCOPE_CONFLICT",
          "名称或编号已存在，请选择已有归属或修改名称",
        );
      throw error;
    }
  }
}
