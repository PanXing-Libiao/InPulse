import { TaskCreateCommandPort } from "./create.command-port.js";
import {
  TaskLinkQueryPort,
  TaskLinkCommandPort,
} from "./external-link-target.port.js";
import {
  FollowupTaskCommandPort,
  PostgresFollowupTaskCommandPort,
} from "./followup-task.port.js";
import { TaskQueryPort, PostgresTaskQueryPort } from "./task-query.port.js";
import {
  TaskStatusCommandPort,
  ExistingTaskStatusCommandPort,
} from "./task-status.port.js";
import {
  TaskCompletionCommandPort,
  PostgresTaskCompletionCommandPort,
} from "./task-completion.port.js";
import {
  SqlTaskDeletionCommandPort,
  TaskDeletionCommandPort,
} from "./task-deletion.command-port.js";
import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { AuditModule } from "../../audit/audit.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { ProjectsModule } from "../projects/index.js";
import { ModulesModule } from "../modules/index.js";
import { ActivityProjectionModule } from "../activity/index.js";
import { SearchProjectionModule } from "../search/index.js";
import { NotificationProjectionModule } from "../notifications/index.js";
import { TasksController } from "./tasks.controller.js";
import { TasksHttpService } from "./tasks-http.service.js";
import { TasksManagementService } from "./tasks-management.service.js";
import { TaskManagementRepository } from "./task-management.repository.js";
import { ProjectMemberTaskCommandPort } from "./project-member-task.command-port.js";

@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    ModulesModule,
    ActivityProjectionModule,
    SearchProjectionModule,
    NotificationProjectionModule,
  ],
  providers: [
    TaskCreateCommandPort,
    TaskLinkQueryPort,
    TaskLinkCommandPort,
    TaskManagementRepository,
    {
      provide: FollowupTaskCommandPort,
      useClass: PostgresFollowupTaskCommandPort,
    },
    { provide: TaskStatusCommandPort, useClass: ExistingTaskStatusCommandPort },
    {
      provide: TaskCompletionCommandPort,
      useClass: PostgresTaskCompletionCommandPort,
    },
    { provide: TaskQueryPort, useClass: PostgresTaskQueryPort },
    { provide: TaskDeletionCommandPort, useClass: SqlTaskDeletionCommandPort },
    TasksManagementService,
    TasksHttpService,
    ProjectMemberTaskCommandPort,
  ],
  exports: [
    TaskCreateCommandPort,
    TaskLinkQueryPort,
    TaskLinkCommandPort,
    ProjectMemberTaskCommandPort,
    FollowupTaskCommandPort,
    TaskQueryPort,
    TaskCompletionCommandPort,
    TaskStatusCommandPort,
    TaskDeletionCommandPort,
  ],
  controllers: [TasksController],
})
export class TasksManagementModule {}
