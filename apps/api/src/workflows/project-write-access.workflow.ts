import { Inject, Injectable } from "@nestjs/common";

import {
  SessionAuthService,
  type AuthenticatedSessionActor,
} from "../auth/session-auth.service.js";
import type { TransactionContext } from "../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
  type ProjectForWriteResource,
} from "../modules/projects/index.js";
import {
  ModuleQueryPort,
  type ModuleForWriteResource,
} from "../modules/modules/index.js";

/**
 * Workflow 层复用的父级写前检查编排。
 *
 * 只负责在调用方已经持有的事务中解析 Session actor，并按
 * 项目 -> 模块 的顺序取得对应行的 FOR SHARE；业务写入与归档操作
 * 不在此处实现。任意一层返回 `not-found` 时，后续 Port 不得被调用，
 * 调用方也不应继续业务写入。ADR-043：项目层为三态；ADR-044：模块层下线归档；
 * ADR-109：功能层已移除。两层都不再有归档只读态，因此这里只可能返回
 * `unauthenticated` / `project-not-found` / `module-not-found`。
 */

export type ProjectWriteAccessStep =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "project-not-found" }
  | {
      readonly kind: "allowed";
      readonly actor: AuthenticatedSessionActor;
      readonly project: ProjectForWriteResource;
    };

export type ModuleWriteAccessFailure =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "project-not-found" }
  | { readonly kind: "module-not-found" };

export type ModuleWriteAccessResult =
  | ModuleWriteAccessFailure
  | {
      readonly kind: "allowed";
      readonly actor: AuthenticatedSessionActor;
      readonly project: ProjectForWriteResource;
      readonly module: ModuleForWriteResource;
    };

export interface CheckModuleForWriteInput {
  readonly cookieHeader: string | undefined;
  readonly projectId: number;
  readonly moduleId: number;
}

@Injectable()
export class ProjectWriteAccessWorkflow {
  constructor(
    @Inject(SessionAuthService)
    private readonly sessionAuth: SessionAuthService,
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly projectAccess: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort)
    private readonly modules: ModuleQueryPort,
  ) {}

  async checkModuleForWrite(
    tx: TransactionContext,
    input: CheckModuleForWriteInput,
  ): Promise<ModuleWriteAccessResult> {
    const project = await this.resolveProjectAccess(
      tx,
      input.cookieHeader,
      input.projectId,
    );
    if (project.kind !== "allowed") {
      return project;
    }

    const module = await this.modules.checkModuleForWrite(tx, {
      projectId: input.projectId,
      moduleId: input.moduleId,
    });
    if (module.kind === "not-found") {
      return { kind: "module-not-found" };
    }

    return {
      kind: "allowed",
      actor: project.actor,
      project: project.project,
      module: module.resource,
    };
  }

  private async resolveProjectAccess(
    tx: TransactionContext,
    cookieHeader: string | undefined,
    projectId: number,
  ): Promise<ProjectWriteAccessStep> {
    const actor = await this.sessionAuth.resolveActorInTransaction(
      tx,
      cookieHeader,
    );
    if (actor === undefined) {
      return { kind: "unauthenticated" };
    }

    const project = await this.projectAccess.checkProjectForWrite(tx, {
      actorUserId: actor.userId,
      projectId,
    });
    if (project.kind === "not-found") {
      return { kind: "project-not-found" };
    }

    return {
      kind: "allowed",
      actor,
      project: project.resource,
    };
  }
}
