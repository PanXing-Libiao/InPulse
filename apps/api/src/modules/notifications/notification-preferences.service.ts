import type { Sql } from "postgres";

import {
  expandPersonalNotificationSettings,
  isPersonalNotificationSetting,
  type PersonalNotificationSetting,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";

export interface NotificationPreferences {
  readonly disabledSettings: readonly PersonalNotificationSetting[];
}

/**
 * 个人通知偏好：每个用户的关闭项以「实际通知类型」落库。
 * 通知写入端口按类型直接判断；通知列表与未读数不按该偏好过滤。
 * 关闭项只阻止后续新通知写入；历史通知不删除、不隐藏，重新开启也不补发。
 */
export class NotificationPreferencesService {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async read(userId: number): Promise<NotificationPreferences> {
    const rows = (await this.#sql.unsafe<{ setting_key: string }[]>(
      `SELECT DISTINCT setting_key
         FROM app.user_notification_suppressions
        WHERE user_id = $1
        ORDER BY setting_key`,
      [userId],
    )) as unknown as readonly { setting_key: string }[];
    return {
      disabledSettings: rows
        .map((row) => row.setting_key)
        .filter(isPersonalNotificationSetting),
    };
  }

  async replace(
    tx: TransactionContext,
    userId: number,
    disabledSettings: readonly PersonalNotificationSetting[],
  ): Promise<NotificationPreferences> {
    const normalized = [...new Set(disabledSettings)].sort();
    await tx.sql`
      DELETE FROM app.user_notification_suppressions
       WHERE user_id = ${userId}
    `;
    for (const entry of expandPersonalNotificationSettings(normalized)) {
      await tx.sql`
        INSERT INTO app.user_notification_suppressions (
          user_id,
          notification_type,
          setting_key
        )
        VALUES (${userId}, ${entry.notificationType}, ${entry.settingKey})
        ON CONFLICT (user_id, notification_type) DO NOTHING
      `;
    }
    return { disabledSettings: normalized };
  }
}
