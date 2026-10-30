import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdempotencyModule } from "../idempotency/idempotency.module.js";
import { DocumentImportAiAssistClient } from "../modules/document-import/ai-assist.client.js";
import { AiAssistRuntimeService } from "../modules/document-import/ai-assist-runtime.service.js";
import { AiAssistSettingsRepository } from "../modules/document-import/ai-assist-settings.repository.js";
import { AiAssistSettingsService } from "../modules/document-import/ai-assist-settings.service.js";
import { DocumentImportRunRepository } from "../modules/document-import/document-import-run.repository.js";
import { FeaturesModule } from "../modules/features/index.js";
import { FeaturesManagementModule } from "../modules/features/features-management.module.js";
import { ModulesModule } from "../modules/modules/index.js";
import { ModulesManagementModule } from "../modules/modules/modules-management.module.js";
import { ProjectCreateModule } from "../modules/projects/project-create.module.js";
import { ProjectsModule } from "../modules/projects/index.js";
import { TasksManagementModule } from "../modules/tasks/index.js";
import { AiAssistSettingsController } from "./ai-assist-settings.controller.js";
import { DocumentImportAssistController } from "./document-import-assist.controller.js";
import { DocumentImportController } from "./document-import.controller.js";
import { AiAssistSettingsHttpService } from "./ai-assist-settings-http.service.js";
import { DocumentImportHttpService } from "./document-import-http.service.js";
import { RecordSummaryAssistController } from "./record-summary-assist.controller.js";
import { TaskDraftAssistController } from "./task-draft-assist.controller.js";
import { TaskDraftAssistHttpService } from "./task-draft-assist-http.service.js";
import { TaskDraftAssistCatalogPort } from "./task-draft-assist.catalog.port.js";
import { PostgresTaskDraftAssistCatalog } from "./postgres-task-draft-assist-catalog.js";
import { RecordSummaryAssistHttpService } from "./record-summary-assist-http.service.js";
import { DocumentImportWorkflow } from "./document-import.workflow.js";
import { ProjectImportController } from "./project-import.controller.js";

/**
 * ADR-064 文档导入模块：聚合项目、模块、功能与任务四个域的公开 CommandPort
 * 与读端口，在单一事务内按固定模板创建/复用模块与功能并创建任务。
 * ADR-067 / ADR-068：模块同时承载 AI 辅助转换（运行时配置解析）与管理员
 * 在线配置（加密保存、测试连接）。
 * ADR-076：迭代总结 AI 改写复用同一份运行时配置与出站适配器（配置只有一份，
 * 不为同一份配置再建一个解析入口），因此它的控制器也挂在本模块下。
 * 新建任务 AI 识别同样复用这份配置与出站适配器，候选清单读取走独立只读端口。
 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    ProjectCreateModule,
    ModulesModule,
    ModulesManagementModule,
    FeaturesModule,
    FeaturesManagementModule,
    TasksManagementModule,
  ],
  providers: [
    DocumentImportWorkflow,
    DocumentImportHttpService,
    RecordSummaryAssistHttpService,
    TaskDraftAssistHttpService,
    {
      provide: TaskDraftAssistCatalogPort,
      useClass: PostgresTaskDraftAssistCatalog,
    },
    DocumentImportRunRepository,
    // ADR-068：配置每次调用实时解析（数据库优先，环境变量急停与遗留回退）。
    AiAssistSettingsRepository,
    AiAssistRuntimeService,
    AiAssistSettingsService,
    AiAssistSettingsHttpService,
    DocumentImportAiAssistClient,
  ],
  controllers: [
    DocumentImportController,
    ProjectImportController,
    DocumentImportAssistController,
    RecordSummaryAssistController,
    TaskDraftAssistController,
    AiAssistSettingsController,
  ],
})
export class DocumentImportModule {}
