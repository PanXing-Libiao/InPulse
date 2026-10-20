import type { TransactionContext } from "../../database/transaction-context.js";
import {
  NotificationWritePort,
  validateNotificationWriteInput,
  type NotificationWriteInput,
  type NotificationWriteResult,
} from "./notification.write-port.js";

/**
 * 显式接收调用方事务的通知写适配器。
 * `(source_chain_id, source_sequence, recipient_id, notification_type)` 唯一，
 * 重复写业务事件时 no-op，不产生重复通知。收件人关闭该个人通知类型时同样
 * 不落库（`inserted=false`），由通知写入侧统一执行，不依赖前端。
 */
export class PostgresNotificationWritePort extends NotificationWritePort {
  async write(
    tx: TransactionContext,
    input: NotificationWriteInput,
  ): Promise<NotificationWriteResult> {
    validateNotificationWriteInput(input);
    const rows = (await tx.sql`
      INSERT INTO app.notifications (
        recipient_id,
        project_id,
        source_chain_id,
        source_sequence,
        notification_type,
        title,
        body,
        target_path,
        created_at
      )
      SELECT
        ${input.recipientId},
        ${input.projectId},
        ${input.sourceChainId},
        ${input.sourceSequence},
        ${input.notificationType},
        ${input.title},
        ${input.body},
        ${input.targetPath},
        ${input.createdAt.toISOString()}
       WHERE NOT EXISTS (
         SELECT 1
           FROM app.user_notification_suppressions AS s
          WHERE s.user_id = ${input.recipientId}
            AND s.notification_type = ${input.notificationType}
       )
      ON CONFLICT (
        source_chain_id,
        source_sequence,
        recipient_id,
        notification_type
      ) DO NOTHING
      RETURNING id
    `) as unknown as readonly { id: string }[];
    return { inserted: rows.length > 0 };
  }
}
