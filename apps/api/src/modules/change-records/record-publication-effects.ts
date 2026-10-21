import { Inject, Injectable } from "@nestjs/common";
import type {
  PublishedRecord,
  RecordDraftItem,
  RecordDraftContent,
} from "@inpulse/api-contract";
import { AuditWritePort } from "../../audit/index.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ProjectNotificationDispatcher } from "../projects/index.js";
import { ActivityWritePort } from "../activity/index.js";
import { PROJECT_NOTIFICATION_TYPES } from "../notifications/index.js";
import {
  SearchProjectionWritePort,
  validateSearchProjectionWriteInput,
  SearchProjectionWriteValidationError,
  type SearchProjectionWriteInput,
} from "../search/index.js";
import { RecordDraftError } from "./record-drafts.service.js";
import { LeftoverSearchProjectionSync } from "./leftover-search-projection.js";
type SearchRecord = RecordDraftContent & {
  id: number;
  projectId: number;
  code: string;
  rowVersion: number;
};
export function validatePublishedRecordSearch(
  record: SearchRecord,
): SearchProjectionWriteInput {
  const input: SearchProjectionWriteInput = {
    projectId: record.projectId,
    entityType: "CHANGE_RECORD",
    entityId: record.id,
    // 记录自身的 entityId 就是打开记录页所需的 id，上级归属不重复下发。
    moduleId: null,
    featureId: null,
    recordId: null,
    title: record.title,
    summary: record.contextProblem.slice(0, 5000),
    rawText: [
      record.code,
      record.title,
      record.contextProblem,
      record.changeSolution,
      record.resultVerification,
      ...record.remainingIssues.map((entry) => entry.content),
    ].join("\n"),
    visibilityScope: "MEMBER",
    sourceStatus: "PUBLISHED",
    sourceRowVersion: record.rowVersion,
  };
  try {
    validateSearchProjectionWriteInput(input);
  } catch (error) {
    if (error instanceof SearchProjectionWriteValidationError)
      throw new RecordDraftError(
        422,
        "RECORD_SEARCH_CAPACITY_EXCEEDED",
        "内容过长，超出发布容量。请缩短正文后重试；草稿和输入已保留。",
      );
    throw error;
  }
  return input;
}
@Injectable()
export class RecordPublicationEffects {
  constructor(
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(LeftoverSearchProjectionSync)
    private readonly leftovers: LeftoverSearchProjectionSync,
    @Inject(ProjectNotificationDispatcher)
    private readonly notifications: ProjectNotificationDispatcher,
  ) {}
  async append(
    tx: TransactionContext,
    actorId: number,
    before: PublishedRecord | RecordDraftItem,
    after: PublishedRecord,
    kind: "PUBLISH" | "UPDATE" | "ADD_LEFTOVER",
    requestId: string,
    recipients: readonly number[],
  ) {
    const input = validatePublishedRecordSearch(after),
      action =
        kind === "PUBLISH"
          ? PROJECT_NOTIFICATION_TYPES.recordPublish
          : kind === "UPDATE"
            ? PROJECT_NOTIFICATION_TYPES.recordVersionCreate
            : PROJECT_NOTIFICATION_TYPES.recordLeftoverAdd,
      label =
        kind === "PUBLISH"
          ? "发布"
          : kind === "UPDATE"
            ? "修订"
            : "追加遗留问题";
    const event = await this.audit.append(tx, {
      projectId: after.projectId,
      actorType: "USER",
      actorId,
      action,
      targetType: "CHANGE_RECORD",
      targetId: String(after.id),
      eventPayload: { before, after },
      requestId,
    });
    await this.activity.append(tx, {
      projectId: after.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "CHANGE_RECORD",
      sourceEntityId: after.id,
      activityType: action,
      actorId,
      summary: `${label}迭代记录：${after.title}`,
      metadata: {
        recordId: after.id,
        moduleId: after.moduleId,
        featureId: after.featureId,
        version: after.currentVersion,
      },
      visibilityScope: "MEMBER",
      sourceStatus: "PUBLISHED",
      sourceRowVersion: after.rowVersion,
      occurredAt: new Date(after.updatedAt),
    });
    await this.search.upsert(tx, input);
    await this.leftovers.syncRecord(tx, after);
    // Candidates come only from the application service's server-side source context.
    await this.notifications.dispatch(
      tx,
      {
        projectId: after.projectId,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        notificationType: action,
        title: `${label}迭代记录：${after.title}`.slice(0, 500),
        body: `${after.code} · v${after.currentVersion}`,
        targetPath: `/records?view=published&projectId=${after.projectId}&publishedId=${after.id}`,
        createdAt: new Date(after.updatedAt),
      },
      recipients,
    );
  }
}
