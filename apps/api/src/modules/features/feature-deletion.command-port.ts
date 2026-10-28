import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ProjectRoleGateService } from "../projects/index.js";
import {
  FeatureManagementRepository,
  type FeatureDeletionRow,
  type FeatureHardDeletedRow,
} from "./feature-management.repository.js";

/** ADR-096：删除功能的错误口径，与模块侧同构。 */
export class FeatureDeletionError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const featureDeletionMissing = () =>
  new FeatureDeletionError(
    404,
    "FEATURE_NOT_FOUND",
    "项目或功能不存在或无法访问",
  );
export const featureDeletionForbidden = () =>
  new FeatureDeletionError(
    403,
    "FEATURE_DELETE_FORBIDDEN",
    "只有系统管理员或本项目组长可以删除功能",
  );
export const featureDeletionVersionConflict = () =>
  new FeatureDeletionError(
    409,
    "FEATURE_VERSION_CONFLICT",
    "功能版本已变化，请重新加载后删除",
  );

/**
 * ADR-096：删除功能在本域需要暴露的边界。删除模块时对功能的级联物理删除由
 * 模块专用函数一次完成，不再逐个调用本 Port。
 */
export abstract class FeatureDeletionCommandPort {
  /** 与模块侧同一角色门禁；不含资源存在性检查。 */
  abstract authorize(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
  ): Promise<void>;
  abstract findForDeletion(
    tx: TransactionContext,
    projectId: number,
    moduleId: number,
    featureId: number,
    lock?: boolean,
  ): Promise<FeatureDeletionRow | undefined>;
  /** ADR-096：物理删除功能及其全部下级数据；版本不一致时返回 undefined。 */
  abstract hardDelete(
    tx: TransactionContext,
    current: FeatureDeletionRow,
    actorId: number,
    reason: string,
  ): Promise<FeatureHardDeletedRow | undefined>;
}

@Injectable()
export class SqlFeatureDeletionCommandPort extends FeatureDeletionCommandPort {
  constructor(
    @Inject(ProjectRoleGateService)
    private readonly roles: ProjectRoleGateService,
    @Inject(FeatureManagementRepository)
    private readonly repository: FeatureManagementRepository,
  ) {
    super();
  }

  async authorize(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
  ): Promise<void> {
    const role = await this.roles.scopeDeleterRole(tx, actorId, projectId, {
      code: "FEATURE_DELETE_FORBIDDEN",
      message: "当前平台权限配置不允许该成员删除功能",
    });
    if (role === "NOT_MEMBER") throw featureDeletionMissing();
  }

  findForDeletion(
    tx: TransactionContext,
    projectId: number,
    moduleId: number,
    featureId: number,
    lock = false,
  ): Promise<FeatureDeletionRow | undefined> {
    return this.repository.findForDeletion(
      tx,
      projectId,
      moduleId,
      featureId,
      lock,
    );
  }

  hardDelete(
    tx: TransactionContext,
    current: FeatureDeletionRow,
    actorId: number,
    reason: string,
  ): Promise<FeatureHardDeletedRow | undefined> {
    return this.repository.hardDelete(tx, current, actorId, reason);
  }
}
