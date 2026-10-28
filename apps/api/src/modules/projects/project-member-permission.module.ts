import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module.js";
import { AuthModule } from "../../auth/auth.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { ProjectMemberPermissionController } from "./project-member-permission.controller.js";
import { ProjectMemberPermissionHttpService } from "./project-member-permission-http.service.js";
import { ProjectMemberPermissionService } from "./project-member-permission.service.js";
import { ProjectsModule } from "./projects.module.js";

/** ADR-104：全平台项目成员三档权限的读取与管理员保存。 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
  ],
  providers: [
    ProjectMemberPermissionService,
    ProjectMemberPermissionHttpService,
  ],
  controllers: [ProjectMemberPermissionController],
})
export class ProjectMemberPermissionModule {}
