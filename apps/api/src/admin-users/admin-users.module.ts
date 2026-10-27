import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { ProjectsModule } from "../modules/projects/projects.module.js";
import { TasksManagementModule } from "../modules/tasks/index.js";
import { TaskCompletionModule } from "../workflows/task-completion.module.js";
import { AdminUsersController } from "./admin-user.controller.js";
import { AdminUserOffboardingRepository } from "./admin-user-offboarding.repository.js";
import { AdminUserRepository } from "./admin-user.repository.js";
import { AdminUserService } from "./admin-user.service.js";
import { AdminUsersHttpService } from "./admin-user-http.service.js";
import { AdminCasdoorImportHttpService } from "./admin-casdoor-import-http.service.js";
import { AdminCasdoorImportService } from "./admin-casdoor-import.service.js";

/** F-03 用户管理支柱；所有写命令只创建一个 UnitOfWork。 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    TasksManagementModule,
    TaskCompletionModule,
  ],
  providers: [
    AdminUserRepository,
    AdminUserOffboardingRepository,
    AdminUserService,
    AdminUsersHttpService,
    AdminCasdoorImportService,
    AdminCasdoorImportHttpService,
  ],
  controllers: [AdminUsersController],
})
export class AdminUsersModule {}
