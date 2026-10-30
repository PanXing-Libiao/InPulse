import {
  RecordDraftCommandPort,
  RecordDraftQueryPort,
} from "./record-draft.port.js";
import { Module } from "@nestjs/common";
import { SESSION_HMAC_KEYRING } from "../../auth/auth.constants.js";
import type { VersionedHmacKeyring } from "../../auth/keyring.js";
import { TimeCursorService } from "../../cursors/time-cursor.js";
import { AuthModule } from "../../auth/auth.module.js";
import { AuditModule } from "../../audit/audit.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { ProjectsModule } from "../projects/index.js";
import { ModulesModule } from "../modules/index.js";
import { RecordDraftsService } from "./record-drafts.service.js";
import { RecordDraftRepository } from "./record-draft.repository.js";
import { RecordDraftsHttpService } from "./record-drafts-http.service.js";
import { RecordDraftsController } from "./record-drafts.controller.js";
@Module({
  imports: [
    AuthModule,
    AuditModule,
    DatabaseModule,
    IdempotencyModule,
    ProjectsModule,
    ModulesModule,
  ],
  providers: [
    RecordDraftsService,
    { provide: RecordDraftCommandPort, useExisting: RecordDraftsService },
    { provide: RecordDraftQueryPort, useExisting: RecordDraftsService },
    RecordDraftRepository,
    {
      provide: TimeCursorService,
      useFactory: (keyring: VersionedHmacKeyring) =>
        new TimeCursorService(keyring, "RECORD_DRAFTS"),
      inject: [SESSION_HMAC_KEYRING],
    },
    RecordDraftsHttpService,
  ],
  exports: [RecordDraftCommandPort, RecordDraftQueryPort],
  controllers: [RecordDraftsController],
})
export class RecordDraftsModule {}
