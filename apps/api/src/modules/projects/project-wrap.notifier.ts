import { Inject, Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";
import { NotificationWritePort } from "../notifications/index.js";
import { ProjectMembersQueryPort } from "./project-members-query.port.js";
import type { ProjectWrapSnapshot } from "./projects-write.port.js";

/** ADR-091：项目封箱个人通知；个人设置沿用 project.status.change 开关。 */
export const PROJECT_WRAPPED_NOTIFICATION = "project.wrapped";

@Injectable()
export class ProjectWrapNotifier {
  constructor(
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(NotificationWritePort)
    private readonly notifications: NotificationWritePort,
  ) {}

  async notify(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly chainId: string;
      readonly sequenceNo: number;
      readonly occurredAt: Date;
      readonly snapshot: ProjectWrapSnapshot;
    },
  ): Promise<void> {
    const recipients = await this.members.listActiveMemberIds(tx, {
      projectId: input.projectId,
    });
    const stats = input.snapshot.stats;
    const body =
      "这一箱，有你的名字。" +
      String(stats.completedTaskCount) +
      " 个任务、" +
      String(stats.publishedRecordCount) +
      " 篇记录、" +
      String(stats.activeMemberCount) +
      " 个人、" +
      String(stats.durationDays) +
      " 天，一起走到这里。";
    for (const recipientId of recipients) {
      await this.notifications.write(tx, {
        recipientId,
        projectId: input.projectId,
        sourceChainId: input.chainId,
        sourceSequence: input.sequenceNo,
        notificationType: PROJECT_WRAPPED_NOTIFICATION,
        title: ("项目封箱：" + input.snapshot.project.name).slice(0, 500),
        body,
        targetPath: "/projects/" + String(input.projectId),
        createdAt: input.occurredAt,
      });
    }
  }
}
