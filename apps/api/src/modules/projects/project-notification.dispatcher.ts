import { Inject, Injectable } from "@nestjs/common";
import type { PersonalNotificationSetting } from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";
import { NotificationWritePort } from "../notifications/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "./project-access.port.js";

/** 一个项目业务事件的站内通知内容；收件人由调用方按业务场景给出。 */
export interface ProjectNotificationEvent {
  readonly projectId: number;
  readonly sourceChainId: string;
  readonly sourceSequence: number;
  readonly notificationType: PersonalNotificationSetting;
  readonly title: string;
  readonly body: string;
  readonly targetPath: string | null;
  readonly createdAt: Date;
}

/**
 * 项目内站内通知的唯一发送入口。
 *
 * 业务 Workflow 只负责给出候选收件人；这里统一去重、按用户 ID 升序处理，并按
 * 当前项目访问权剔除已停用、已移出项目或无权访问的用户，再交给通知写端口。
 * 个人通知偏好仍由写端口在落库前判断；本类不接受客户端传入的收件人概念。
 */
@Injectable()
export class ProjectNotificationDispatcher {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(NotificationWritePort)
    private readonly notifications: NotificationWritePort,
  ) {}

  async dispatch(
    tx: TransactionContext,
    event: ProjectNotificationEvent,
    recipientIds: readonly number[],
  ): Promise<number> {
    let inserted = 0;
    for (const recipientId of normalizeRecipientIds(recipientIds)) {
      const check = await this.access.checkProjectForWrite(tx, {
        actorUserId: recipientId,
        projectId: event.projectId,
      });
      if (check.kind !== "allowed") continue;
      const result = await this.notifications.write(tx, {
        ...event,
        recipientId,
      });
      if (result.inserted) inserted += 1;
    }
    return inserted;
  }
}

/** 去重、丢弃非法 ID 并按升序处理，保证通知写入顺序稳定。 */
export function normalizeRecipientIds(
  recipientIds: readonly number[],
): readonly number[] {
  return [...new Set(recipientIds)]
    .filter(
      (recipientId) => Number.isSafeInteger(recipientId) && recipientId > 0,
    )
    .sort((left, right) => left - right);
}
