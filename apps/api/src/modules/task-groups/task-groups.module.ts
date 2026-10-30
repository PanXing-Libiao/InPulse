import { Module } from "@nestjs/common";
import {
  TaskBranchQueryPort,
  PostgresTaskBranchQueryPort,
} from "./task-branch-query.port.js";
import { AuthModule } from "../../auth/auth.module.js";
import { AuditModule } from "../../audit/audit.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { ProjectsModule } from "../projects/index.js";
import { ModulesModule } from "../modules/index.js";
import { TasksManagementModule } from "../tasks/index.js";
import { ActivityProjectionModule } from "../activity/index.js";
import { SearchProjectionModule } from "../search/index.js";
import { NotificationProjectionModule } from "../notifications/index.js";
import { TaskGroupRepository } from "./task-group.repository.js";
import {
  PostgresTaskGroupMembershipReadPort,
  TaskGroupMembershipReadPort,
} from "./task-group-membership-read.port.js";
import {
  PostgresTaskGroupReadPort,
  TaskGroupReadPort,
} from "./task-group-read.port.js";
import {
  SqlTaskGroupDeletionPort,
  TaskGroupDeletionPort,
} from "./task-group-deletion.port.js";
import { TaskGroupsService } from "./task-groups.service.js";
import { TaskGroupsHttpService } from "./task-groups-http.service.js";
import { TaskGroupUnmergeHttpService } from "./task-group-unmerge-http.service.js";
import { TaskGroupsController } from "./task-groups.controller.js";
@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    ModulesModule,
    TasksManagementModule,
    ActivityProjectionModule,
    SearchProjectionModule,
    NotificationProjectionModule,
  ],
  providers: [
    TaskGroupRepository,
    TaskGroupsService,
    TaskGroupsHttpService,
    { provide: TaskBranchQueryPort, useClass: PostgresTaskBranchQueryPort },
    {
      provide: TaskGroupMembershipReadPort,
      useClass: PostgresTaskGroupMembershipReadPort,
    },
    { provide: TaskGroupReadPort, useClass: PostgresTaskGroupReadPort },
    { provide: TaskGroupDeletionPort, useClass: SqlTaskGroupDeletionPort },
    TaskGroupUnmergeHttpService,
  ],
  exports: [
    TaskBranchQueryPort,
    TaskGroupMembershipReadPort,
    TaskGroupReadPort,
    TaskGroupDeletionPort,
  ],
  controllers: [TaskGroupsController],
})
export class TaskGroupsModule {}
