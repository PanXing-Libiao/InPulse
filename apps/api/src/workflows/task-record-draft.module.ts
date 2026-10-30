import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { ProjectsModule } from "../modules/projects/index.js";
import { ModulesModule } from "../modules/modules/index.js";
import { TasksManagementModule } from "../modules/tasks/index.js";
import { RecordDraftsModule } from "../modules/change-records/index.js";
import { TaskRecordDraftWorkflow } from "./task-record-draft.workflow.js";
import { TaskRecordDraftHttpService } from "./task-record-draft-http.service.js";
import { TaskRecordDraftController } from "./task-record-draft.controller.js";
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    ModulesModule,
    TasksManagementModule,
    RecordDraftsModule,
  ],
  providers: [TaskRecordDraftWorkflow, TaskRecordDraftHttpService],
  controllers: [TaskRecordDraftController],
})
export class TaskRecordDraftModule {}
