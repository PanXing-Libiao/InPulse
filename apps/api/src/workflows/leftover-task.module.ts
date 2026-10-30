import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { ProjectsModule } from "../modules/projects/index.js";
import { ModulesModule } from "../modules/modules/index.js";
import { TasksManagementModule } from "../modules/tasks/index.js";
import { PublishedRecordsModule } from "../modules/change-records/index.js";
import { ActivityProjectionModule } from "../modules/activity/index.js";
import { SearchProjectionModule } from "../modules/search/index.js";
import { LeftoverTaskWorkflow } from "./leftover-task.workflow.js";
import { LeftoverTaskHttpService } from "./leftover-task-http.service.js";
import { LeftoverTaskController } from "./leftover-task.controller.js";
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    IdempotencyModule,
    AuditModule,
    ProjectsModule,
    ModulesModule,
    TasksManagementModule,
    PublishedRecordsModule,
    ActivityProjectionModule,
    SearchProjectionModule,
  ],
  providers: [LeftoverTaskWorkflow, LeftoverTaskHttpService],
  controllers: [LeftoverTaskController],
})
export class LeftoverTaskModule {}
