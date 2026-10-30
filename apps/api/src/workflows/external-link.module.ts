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
import { ExternalLinksModule } from "../modules/external-links/index.js";
import { ExternalLinkSearchPort } from "../modules/search/external-link-search.port.js";
import { ExternalLinkWorkflow } from "./external-link.workflow.js";
import { ExternalLinkHttpService } from "./external-link-http.service.js";
import { ExternalLinkController } from "./external-link.controller.js";
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
    ExternalLinksModule,
  ],
  providers: [
    ExternalLinkWorkflow,
    ExternalLinkHttpService,
    ExternalLinkSearchPort,
  ],
  controllers: [ExternalLinkController],
})
export class ExternalLinkModule {}
