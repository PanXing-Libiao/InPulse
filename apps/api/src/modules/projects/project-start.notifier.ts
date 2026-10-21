import { Inject, Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";
import { PROJECT_NOTIFICATION_TYPES } from "../notifications/index.js";
import { ProjectNotificationDispatcher } from "./project-notification.dispatcher.js";
import { ProjectMembersQueryPort } from "./project-members-query.port.js";

/** 项目开工通知类型；与前端通知中心的 `notificationType` 同名。 */
export const PROJECT_STARTED_NOTIFICATION =
  PROJECT_NOTIFICATION_TYPES.projectStatusChange;

/**
 * ADR-035 项目开工通知：项目由「未开始」进入「进行中」时通知全体活跃成员。
 *
 * 手动切换（F-06.3 状态接口）与首个任务完成触发的自动升级共用同一文案与
 * 收件人计算；维护中与其它状态迁移都不通知，避免反复切换刷屏。
 * 收件人由服务端按当前成员关系实时计算，不接受调用方传入的收件人集合。
 */
@Injectable()
export class ProjectStartNotifier {
  constructor(
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(ProjectNotificationDispatcher)
    private readonly notifications: ProjectNotificationDispatcher,
  ) {}

  async notify(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly code: string;
      readonly name: string;
      readonly chainId: string;
      readonly sequenceNo: number;
      readonly occurredAt: Date;
    },
  ): Promise<void> {
    const recipients = await this.members.listActiveMemberIds(tx, {
      projectId: input.projectId,
    });
    await this.notifications.dispatch(
      tx,
      {
        projectId: input.projectId,
        sourceChainId: input.chainId,
        sourceSequence: input.sequenceNo,
        notificationType: PROJECT_STARTED_NOTIFICATION,
        title: `项目已开始：${input.name}`.slice(0, 500),
        body: `项目 ${input.code} 由未开始进入进行中。`,
        targetPath: `/projects/${input.projectId}`,
        createdAt: input.occurredAt,
      },
      recipients,
    );
  }
}
