import { Injectable } from "@nestjs/common";

import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { PostgresUserCredentialRepository } from "./user-credential.repository.js";
import { PostgresUserSessionRepository } from "./user-session.repository.js";

/**
 * 用户停用或改密时复用的事务内失效切片：
 * 1. 递增 `users.auth_version`（并满足 row_version 触发器）；
 * 2. 撤销该用户全部未撤销 Session。
 *
 * 调用方若已持有事务，应使用 `invalidateUserSessionsInTransaction`，
 * 把用户状态变更和 Session 失效放在同一个 UnitOfWork 中。
 */
@Injectable()
export class UserAuthInvalidationService {
  constructor(
    private readonly unitOfWork: PostgresUnitOfWork,
    private readonly userRepository: PostgresUserCredentialRepository,
    private readonly sessionRepository: PostgresUserSessionRepository,
  ) {}

  async invalidateUserSessions(userId: number): Promise<boolean> {
    return this.unitOfWork.run((tx) =>
      this.invalidateUserSessionsInTransaction(tx, userId),
    );
  }

  async invalidateUserSessionsInTransaction(
    tx: TransactionContext,
    userId: number,
  ): Promise<boolean> {
    const incremented = await this.userRepository.incrementAuthVersion(
      tx,
      userId,
    );
    if (!incremented) {
      return false;
    }
    await this.sessionRepository.revokeAllForUser(tx, userId);
    return true;
  }
}
