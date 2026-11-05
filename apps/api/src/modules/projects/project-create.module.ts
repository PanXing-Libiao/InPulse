import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module.js";
import { AuditModule } from "../../audit/audit.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { SearchProjectionModule } from "../search/index.js";
import { ActivityProjectionModule } from "../activity/index.js";
import { NotificationProjectionModule } from "../notifications/index.js";
import { ProjectBootstrapController } from "./project-bootstrap.controller.js";
import { ProjectBootstrapWorkflow } from "./project-bootstrap.workflow.js";
import { ProjectsModule } from "./projects.module.js";
import { ModulesManagementModule } from "../modules/modules-management.module.js";
import { TasksManagementModule } from "../tasks/tasks-management.module.js";

/**
 * F-04 创建项目模块。依赖认证/审计/幂等与三个投影写端口，只在
 * AppModule 有认证 Secret 时挂载，避免匿名健康探针触发认证 keyring fail-closed。
 */
@Module({
  imports: [
    ProjectsModule,
    ModulesManagementModule,
    TasksManagementModule,
    AuthModule,
    AuditModule,
    IdempotencyModule,
    SearchProjectionModule,
    ActivityProjectionModule,
    NotificationProjectionModule,
  ],
  providers: [ProjectBootstrapWorkflow],
  exports: [ProjectBootstrapWorkflow],
  controllers: [ProjectBootstrapController],
})
export class ProjectCreateModule {}
