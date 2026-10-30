import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { ProjectsModule } from "../modules/projects/index.js";
import { ModulesManagementModule } from "../modules/modules/modules-management.module.js";
import { TasksManagementModule } from "../modules/tasks/index.js";
import { TaskCreateController } from "./task-create.controller.js";
import { TaskCreateHttpService } from "./task-create-http.service.js";
import { TaskCreateWorkflow } from "./task-create.workflow.js";
@Module({
  imports: [
    AuthModule,
    IdempotencyModule,
    ProjectsModule,
    ModulesManagementModule,
    TasksManagementModule,
  ],
  providers: [TaskCreateWorkflow, TaskCreateHttpService],
  controllers: [TaskCreateController],
})
export class TaskCreateModule {}
