import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { ActivityProjectionModule } from "../modules/activity/activity-projection.module.js";
import { ProjectsModule } from "../modules/projects/projects.module.js";
import { AdminUsersController } from "./admin-user.controller.js";
import { AdminUserRepository } from "./admin-user.repository.js";
import { AdminUserService } from "./admin-user.service.js";
import { AdminUsersHttpService } from "./admin-user-http.service.js";

/** F-03 用户管理支柱；所有写命令只创建一个 UnitOfWork。 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ActivityProjectionModule,
    ProjectsModule,
  ],
  providers: [AdminUserRepository, AdminUserService, AdminUsersHttpService],
  controllers: [AdminUsersController],
})
export class AdminUsersModule {}
