import {
  RecordLinkQueryPort,
  RecordLinkCommandPort,
} from "./external-link-target.port.js";
import { RecordLifecycleController } from "./record-lifecycle.controller.js";
import { RecordLifecycleRepository } from "./record-lifecycle.repository.js";
import { RecordLifecycleHttpService } from "./record-lifecycle-http.service.js";
import { RecordLifecycleService } from "./record-lifecycle.service.js";
import {
  LeftoverRecordCommandPort,
  PostgresLeftoverRecordCommandPort,
} from "./leftover-record.port.js";
import { LeftoverRecordRepository } from "./leftover-record.repository.js";
import { RecordPublicationCommandPort } from "./record-publication.port.js";
import { RecordPublicationService } from "./record-publication.service.js";
import { RecordPublicationHttpService } from "./record-publication-http.service.js";
import { RecordPublicationAccess } from "./record-publication-access.js";
import { RecordPublicationRepository } from "./record-publication.repository.js";
import { RecordPublicationEffects } from "./record-publication-effects.js";
import { LeftoverSearchProjectionSync } from "./leftover-search-projection.js";
import { RecordDraftRepository } from "./record-draft.repository.js";
import {
  RecordFeedReadPort,
  PostgresRecordFeedReadPort,
} from "./record-feed-read.port.js";
import {
  ChangeRecordReadPort,
  PostgresChangeRecordReadPort,
} from "./change-record-read.port.js";
import {
  MyTaskQueryPort,
  PostgresMyTaskQueryPort,
} from "./my-task-query.port.js";
import { ModulesModule } from "../modules/index.js";
import { FeaturesModule } from "../features/index.js";
import { TasksManagementModule } from "../tasks/index.js";
import { AuditModule } from "../../audit/audit.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { ActivityProjectionModule } from "../activity/index.js";
import { NotificationProjectionModule } from "../notifications/index.js";
import { SearchProjectionModule } from "../search/index.js";
import { Module } from "@nestjs/common";
import { SESSION_HMAC_KEYRING } from "../../auth/auth.constants.js";
import type { VersionedHmacKeyring } from "../../auth/keyring.js";
import { TimeCursorService } from "../../cursors/time-cursor.js";
import { AuthModule } from "../../auth/auth.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { ProjectsModule } from "../projects/index.js";
import { PublishedRecordRepository } from "./published-record.repository.js";
import { PublishedRecordReadService } from "./published-record-read.service.js";
import { PublishedRecordsHttpService } from "./published-records-http.service.js";
import { PublishedRecordsController } from "./published-records.controller.js";
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ProjectsModule,
    ModulesModule,
    FeaturesModule,
    TasksManagementModule,
    AuditModule,
    IdempotencyModule,
    ActivityProjectionModule,
    NotificationProjectionModule,
    SearchProjectionModule,
  ],
  exports: [
    RecordLinkQueryPort,
    RecordLinkCommandPort,
    RecordPublicationCommandPort,
    LeftoverRecordCommandPort,
    ChangeRecordReadPort,
    MyTaskQueryPort,
    RecordFeedReadPort,
    LeftoverSearchProjectionSync,
  ],
  providers: [
    RecordLinkQueryPort,
    RecordLinkCommandPort,
    RecordLifecycleService,
    RecordLifecycleHttpService,
    RecordLifecycleRepository,
    RecordPublicationService,
    LeftoverRecordRepository,
    {
      provide: LeftoverRecordCommandPort,
      useClass: PostgresLeftoverRecordCommandPort,
    },
    RecordPublicationHttpService,
    RecordPublicationAccess,
    RecordPublicationRepository,
    RecordPublicationEffects,
    LeftoverSearchProjectionSync,
    RecordDraftRepository,
    {
      provide: TimeCursorService,
      useFactory: (keyring: VersionedHmacKeyring) =>
        new TimeCursorService(keyring, "CHANGE_RECORDS"),
      inject: [SESSION_HMAC_KEYRING],
    },
    {
      provide: RecordPublicationCommandPort,
      useExisting: RecordPublicationService,
    },
    PublishedRecordRepository,
    PublishedRecordReadService,
    PublishedRecordsHttpService,
    {
      provide: ChangeRecordReadPort,
      useClass: PostgresChangeRecordReadPort,
    },
    {
      provide: MyTaskQueryPort,
      useClass: PostgresMyTaskQueryPort,
    },
    {
      provide: RecordFeedReadPort,
      useClass: PostgresRecordFeedReadPort,
    },
  ],
  controllers: [PublishedRecordsController, RecordLifecycleController],
})
export class PublishedRecordsModule {}
