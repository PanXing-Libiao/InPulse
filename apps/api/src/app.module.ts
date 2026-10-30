import { TaskCreateModule } from "./workflows/task-create.module.js";
import { DocumentImportModule } from "./workflows/document-import.module.js";
import { ExternalLinkModule } from "./workflows/external-link.module.js";
import { LeftoverTaskModule } from "./workflows/leftover-task.module.js";
import { TaskRecordDraftModule } from "./workflows/task-record-draft.module.js";
import { TaskCompletionModule } from "./workflows/task-completion.module.js";
import { TaskGroupsModule } from "./modules/task-groups/task-groups.module.js";
import { RecordDraftsModule } from "./modules/change-records/record-drafts.module.js";
import { PublishedRecordsModule } from "./modules/change-records/published-records.module.js";
import { TasksManagementModule } from "./modules/tasks/tasks-management.module.js";
import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { ModulesManagementModule } from "./modules/modules/modules-management.module.js";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ApiExceptionFilter } from "./http/api-exception.filter.js";
import { ContractResponseInterceptor } from "./http/contract-response.interceptor.js";
import { AuthModule } from "./auth/auth.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuditLogReadModule } from "./audit/audit-log-read.module.js";
import { RequestAuditContextMiddleware } from "./audit/request-audit-context.middleware.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdempotencyModule } from "./idempotency/idempotency.module.js";
import { ActivityProjectionModule } from "./modules/activity/activity-projection.module.js";
import { ActivityModule } from "./modules/activity/activity.module.js";
import { NotificationProjectionModule } from "./modules/notifications/notification-projection.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { ProjectsModule } from "./modules/projects/projects.module.js";
import { ProjectCreateModule } from "./modules/projects/project-create.module.js";
import { ProjectsReadModule } from "./modules/projects/projects-read.module.js";
import { ProjectMemberManagementModule } from "./modules/projects/project-member-management.module.js";
import { ProjectMemberPermissionModule } from "./modules/projects/project-member-permission.module.js";
import { ProjectManagementModule } from "./modules/projects/project-management.module.js";
import { AggregateReadModule } from "./modules/aggregate-read/aggregate-read.module.js";
import { SearchModule } from "./modules/search/search.module.js";
import { AdminUsersModule } from "./admin-users/admin-users.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { WecomBindingModule } from "./modules/wecom-binding/wecom-binding.module.js";
import { WecomRobotModule } from "./modules/wecom-robot/wecom-robot.module.js";
import { ProjectWecomGroupModule } from "./modules/wecom-group/project-wecom-group.module.js";

/** Secret 未配置时保持健康探针可启动；配置后挂载鉴权模块并 fail closed。 */
const authModules = process.env["SESSION_HASH_KEYRING_FILE"]?.trim()
  ? [
      AuthModule,
      AuditLogReadModule,
      SearchModule,
      ActivityModule,
      NotificationsModule,
      ProjectCreateModule,
      ProjectsReadModule,
      ProjectMemberManagementModule,
      ProjectMemberPermissionModule,
      ProjectManagementModule,
      ModulesManagementModule,
      AdminUsersModule,
      OrganizationsModule,
      WecomBindingModule,
      WecomRobotModule,
      ProjectWecomGroupModule,
      TasksManagementModule,
      RecordDraftsModule,
      PublishedRecordsModule,
      TaskRecordDraftModule,
      TaskCompletionModule,
      TaskCreateModule,
      DocumentImportModule,
      LeftoverTaskModule,
      ExternalLinkModule,
      TaskGroupsModule,
      AggregateReadModule,
    ]
  : [];

@Module({
  imports: [
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    AuditModule,
    HealthModule,
    ActivityProjectionModule,
    NotificationProjectionModule,
    ...authModules,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ContractResponseInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * 所有路由（含健康探针与未匹配路径）都建立请求级审计上下文；
   * 集成测试同样实例化 AppModule，因此不能只依赖 `main.ts` 注册中间件。
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestAuditContextMiddleware).forRoutes("*");
  }
}
