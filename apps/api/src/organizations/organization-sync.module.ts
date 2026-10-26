import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { ORGANIZATION_SYNC_PORT } from "./organization-sync.port.js";
import { PostgresOrganizationSyncService } from "./organization-sync.service.js";

/** ADR-097 的跨域公开写端口；不依赖 AuthModule，避免模块循环。 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ORGANIZATION_SYNC_PORT,
      useClass: PostgresOrganizationSyncService,
    },
  ],
  exports: [ORGANIZATION_SYNC_PORT],
})
export class OrganizationSyncModule {}
