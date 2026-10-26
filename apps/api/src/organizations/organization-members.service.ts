import { Injectable } from "@nestjs/common";
import type { MyOrganizationMembersResponse } from "@inpulse/api-contract";

import { SessionAuthService } from "../auth/session-auth.service.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { OrganizationRepository } from "./organization.repository.js";

/**
 * ADR-097 同组织可见：身份解析与成员查询共用同一个事务；
 * 匿名、停用或无效 Session 返回 undefined（401）。
 */
@Injectable()
export class OrganizationMembersService {
  constructor(
    private readonly unitOfWork: PostgresUnitOfWork,
    private readonly sessionAuthService: SessionAuthService,
    private readonly repository: OrganizationRepository,
  ) {}

  async getMyMembers(
    cookieHeader: string | undefined,
  ): Promise<MyOrganizationMembersResponse | undefined> {
    return this.unitOfWork.run(async (tx) => {
      const actor = await this.sessionAuthService.resolveActorInTransaction(
        tx,
        cookieHeader,
      );
      if (actor === undefined) {
        return undefined;
      }
      const memberships = await this.repository.listForUser(tx, actor.userId);
      if (memberships.length === 0) {
        return { organizations: [], items: [] };
      }
      const items = await this.repository.listActiveMembers(
        tx,
        memberships.map((organization) => organization.id),
      );
      return {
        organizations: memberships.map((organization) => ({
          id: organization.id,
          name: organization.name,
          source: organization.source,
          groupPath: organization.groupPath,
        })),
        items,
      };
    });
  }
}
