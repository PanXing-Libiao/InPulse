import { TaskCenterController } from "./task-center.controller.js";
import { Module } from "@nestjs/common";

import type { VersionedHmacKeyring } from "../../auth/keyring.js";
import { SESSION_HMAC_KEYRING } from "../../auth/auth.constants.js";
import { AuthModule } from "../../auth/auth.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { PublishedRecordsModule } from "../change-records/index.js";
import { ExternalLinksModule } from "../external-links/index.js";
import { ModulesModule } from "../modules/index.js";
import { ProjectsModule } from "../projects/index.js";
import { TaskGroupsModule } from "../task-groups/index.js";
import { TasksManagementModule } from "../tasks/index.js";
import { AggregateReadCursorService } from "./aggregate-read-cursor.js";
import { LeftoverItemsController } from "./leftover-items.controller.js";
import { MyRecordDraftsController } from "./my-record-drafts.controller.js";
import {
  MyRecordDraftsQueryService,
  MY_RECORD_DRAFTS_CURSOR,
  MY_RECORD_DRAFTS_CURSOR_NAMESPACE,
} from "./my-record-drafts-query.service.js";
import { LeftoverItemsQueryService } from "./leftover-items-query.service.js";
import { MyTasksController } from "./my-tasks.controller.js";
import { MyTasksQueryService } from "./my-tasks-query.service.js";
import { ProjectOverviewController } from "./project-overview.controller.js";
import { ProjectOverviewQueryService } from "./project-overview-query.service.js";
import { RecordFeedController } from "./record-feed.controller.js";
import { RecordSummaryController } from "./record-summary.controller.js";
import {
  RecordFeedQueryService,
  RECORD_FEED_CURSOR,
  RECORD_FEED_CURSOR_NAMESPACE,
} from "./record-feed-query.service.js";
import { RecordSummaryQueryService } from "./record-summary-query.service.js";
import { TaskGroupMembershipController } from "./task-group-membership.controller.js";
import { TaskGroupMembershipQueryService } from "./task-group-membership-query.service.js";
import { TaskBoardController } from "./task-board.controller.js";
import { TaskBoardQueryService } from "./task-board-query.service.js";
import { TaskGroupReadController } from "./task-group-read.controller.js";
import { TaskGroupQueryService } from "./task-group-query.service.js";
import { TimeCursorService } from "../../cursors/time-cursor.js";

/**
 * F-20 / F-25 / F-29 / F-32 聚合读宿主模块（A 裁决 §6 附带要求）。
 *
 * 只依赖 A 的 ProjectAccessQueryPort / ProjectQueryPort 与 B、C 已发布的公开
 * QueryPort，不导出任何 Repository、不注册命令端口、不参与任何命令 UnitOfWork；
 * 五条路由的授权全部在服务层通过服务端 AuthorizedProjectScope 完成。
 */
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ProjectsModule,
    ModulesModule,
    TasksManagementModule,
    PublishedRecordsModule,
    TaskGroupsModule,
    ExternalLinksModule,
  ],
  providers: [
    {
      provide: AggregateReadCursorService,
      useFactory: (keyring: VersionedHmacKeyring) =>
        new AggregateReadCursorService(keyring),
      inject: [SESSION_HMAC_KEYRING],
    },
    {
      provide: RECORD_FEED_CURSOR,
      useFactory: (keyring: VersionedHmacKeyring) =>
        new TimeCursorService(keyring, RECORD_FEED_CURSOR_NAMESPACE),
      inject: [SESSION_HMAC_KEYRING],
    },
    {
      provide: MY_RECORD_DRAFTS_CURSOR,
      useFactory: (keyring: VersionedHmacKeyring) =>
        new TimeCursorService(keyring, MY_RECORD_DRAFTS_CURSOR_NAMESPACE),
      inject: [SESSION_HMAC_KEYRING],
    },
    TaskGroupQueryService,
    TaskGroupMembershipQueryService,
    ProjectOverviewQueryService,
    LeftoverItemsQueryService,
    MyTasksQueryService,
    TaskBoardQueryService,
    RecordFeedQueryService,
    MyRecordDraftsQueryService,
    RecordSummaryQueryService,
  ],
  controllers: [
    // R-5 的静态段 /task-groups/memberships 必须先于 TaskGroupReadController 的
    // :groupId 参数路由注册，否则会被吞掉（集成测试断言实际路由解析）。
    TaskGroupMembershipController,
    TaskGroupReadController,
    ProjectOverviewController,
    LeftoverItemsController,
    MyTasksController,
    TaskBoardController,
    TaskCenterController,
    RecordFeedController,
    RecordSummaryController,
    MyRecordDraftsController,
  ],
})
export class AggregateReadModule {}
