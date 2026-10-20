import { Module } from "@nestjs/common";

import type { DatabaseClient } from "@inpulse/database/client";
import { SESSION_HMAC_KEYRING } from "../../auth/auth.constants.js";
import { AuthModule } from "../../auth/auth.module.js";
import type { VersionedHmacKeyring } from "../../auth/keyring.js";
import { TimeCursorService } from "../../cursors/time-cursor.js";
import { DATABASE_CLIENT } from "../../database/database.constants.js";
import { DatabaseModule } from "../../database/database.module.js";
import { IdempotencyModule } from "../../idempotency/idempotency.module.js";
import { NotificationPreferencesService } from "./notification-preferences.service.js";
import { NotificationQueryService } from "./notification-query.service.js";
import { NotificationStateService } from "./notification.service.js";
import { NotificationsController } from "./notifications.controller.js";

@Module({
  imports: [AuthModule, DatabaseModule, IdempotencyModule],
  providers: [
    {
      provide: NotificationStateService,
      useFactory: (client: DatabaseClient) =>
        new NotificationStateService(client.sql),
      inject: [DATABASE_CLIENT],
    },
    {
      provide: TimeCursorService,
      useFactory: (keyring: VersionedHmacKeyring) =>
        new TimeCursorService(keyring, "NOTIFICATION"),
      inject: [SESSION_HMAC_KEYRING],
    },
    {
      provide: NotificationPreferencesService,
      useFactory: (client: DatabaseClient) =>
        new NotificationPreferencesService(client.sql),
      inject: [DATABASE_CLIENT],
    },
    {
      provide: NotificationQueryService,
      useFactory: (
        state: NotificationStateService,
        cursor: TimeCursorService,
      ) => new NotificationQueryService(state, cursor),
      inject: [NotificationStateService, TimeCursorService],
    },
  ],
  controllers: [NotificationsController],
})
export class NotificationsModule {}
