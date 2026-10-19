import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { ActivityProjectionModule } from "../modules/activity/activity-projection.module.js";
import { ExternalLinksModule } from "../modules/external-links/external-links.module.js";
import { SearchProjectionModule } from "../modules/search/search-projection.module.js";
import { ProjectsModule } from "../modules/projects/index.js";
import { ModulesModule } from "../modules/modules/index.js";
import { FeaturesModule } from "../modules/features/index.js";
import { ModulesManagementModule } from "../modules/modules/modules-management.module.js";
import { FeaturesManagementModule } from "../modules/features/features-management.module.js";
import { TasksManagementModule } from "../modules/tasks/index.js";
import { TaskGroupsModule } from "../modules/task-groups/index.js";
import {
  RecordDraftsModule,
  PublishedRecordsModule,
} from "../modules/change-records/index.js";
import { TaskCompletionWorkflow } from "./task-completion.workflow.js";
import { TaskCompletionHttpService } from "./task-completion-http.service.js";
import { TaskCompletionController } from "./task-completion.controller.js";
import { TaskStatusCompatibilityController } from "./task-status-compatibility.controller.js";
import { TaskStatusCompatibilityHttpService } from "./task-status-compatibility-http.service.js";
import { TaskDeletionWorkflow } from "./task-deletion.workflow.js";
import { TaskDeletionHttpService } from "./task-deletion-http.service.js";
import { TaskDeletionController } from "./task-deletion.controller.js";
import { ScopeDeletionWorkflow } from "./scope-deletion.workflow.js";
import { ScopeDeletionHttpService } from "./scope-deletion-http.service.js";
import { ScopeDeletionController } from "./scope-deletion.controller.js";
@Module({
  imports: [
    AuditModule,
    AuthModule,
    DatabaseModule,
    IdempotencyModule,
    ActivityProjectionModule,
    ExternalLinksModule,
    SearchProjectionModule,
    ProjectsModule,
    ModulesModule,
    FeaturesModule,
    ModulesManagementModule,
    FeaturesManagementModule,
    TasksManagementModule,
    TaskGroupsModule,
    RecordDraftsModule,
    PublishedRecordsModule,
  ],
  providers: [
    TaskCompletionWorkflow,
    TaskCompletionHttpService,
    TaskStatusCompatibilityHttpService,
    TaskDeletionWorkflow,
    TaskDeletionHttpService,
    ScopeDeletionWorkflow,
    ScopeDeletionHttpService,
  ],
  exports: [TaskDeletionWorkflow],
  controllers: [
    TaskCompletionController,
    TaskStatusCompatibilityController,
    TaskDeletionController,
    ScopeDeletionController,
  ],
})
export class TaskCompletionModule {}
