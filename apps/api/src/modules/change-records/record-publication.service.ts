import { Inject, Injectable } from "@nestjs/common";
import {
  publishedRecordContentSchema,
  recordPublicationReplayContextSchema,
  type RecordDraftContent,
  type PublishedRecordContent,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ProjectCodePort } from "../projects/index.js";
import { RecordDraftRepository } from "./record-draft.repository.js";
import { PublishedRecordRepository } from "./published-record.repository.js";
import {
  RecordPublicationRepository,
  type PublicationIdentity,
} from "./record-publication.repository.js";
import { RecordPublicationAccess } from "./record-publication-access.js";
import {
  RecordPublicationEffects,
  validatePublishedRecordSearch,
} from "./record-publication-effects.js";
import { RecordDraftError } from "./record-drafts.service.js";
import type { RecordPublicationCommandPort } from "./record-publication.port.js";
@Injectable()
export class RecordPublicationService implements RecordPublicationCommandPort {
  constructor(
    @Inject(RecordPublicationAccess)
    private readonly access: RecordPublicationAccess,
    @Inject(RecordPublicationRepository)
    private readonly repository: RecordPublicationRepository,
    @Inject(RecordDraftRepository)
    private readonly drafts: RecordDraftRepository,
    @Inject(PublishedRecordRepository)
    private readonly published: PublishedRecordRepository,
    @Inject(ProjectCodePort) private readonly codes: ProjectCodePort,
    @Inject(RecordPublicationEffects)
    private readonly effects: RecordPublicationEffects,
  ) {}
  private conflict() {
    return new RecordDraftError(
      409,
      "RECORD_VERSION_CONFLICT",
      "记录版本已变化，请加载最新内容后合并",
    );
  }
  private content(input: RecordDraftContent): RecordDraftContent {
    const {
      title,
      contextProblem,
      changeSolution,
      resultVerification,
      remainingIssues,
    } = input;
    return {
      title,
      contextProblem,
      changeSolution,
      resultVerification,
      remainingIssues,
    };
  }
  private validate(input: PublishedRecordContent) {
    const parsed = publishedRecordContentSchema.safeParse(input);
    if (!parsed.success)
      throw new RecordDraftError(
        422,
        "RECORD_PUBLICATION_VALIDATION_FAILED",
        "请检查必填内容；每条遗留问题最多10000字符、最多50条。草稿和输入已保留。",
      );
    return parsed.data;
  }
  async publish(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    expectedRowVersion: number,
    requestId: string,
  ) {
    const { record, source } = await this.access.prepare(
      tx,
      actorId,
      projectId,
      recordId,
      true,
    );
    if (record.rowVersion !== expectedRowVersion) throw this.conflict();
    const before = await this.drafts.find(tx, projectId, recordId);
    if (!before) throw this.conflict();
    const input = this.validate({
      ...this.content(before),
      confirmLeftoverResolved: false,
    });
    const code = await this.codes.allocateChangeRecordCode(tx, projectId);
    validatePublishedRecordSearch({ ...before, ...input, code });
    const after = await this.save(tx, actorId, record, input, code);
    const recipients = [
      after.authorId,
      after.handlerId,
      ...(source ? [source.assigneeId] : []),
    ];
    await this.effects.append(
      tx,
      actorId,
      before,
      after,
      "PUBLISH",
      requestId,
      recipients,
    );
    return after;
  }
  async update(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    rowVersion: number,
    currentVersion: number,
    input: PublishedRecordContent,
    requestId: string,
  ) {
    const { record } = await this.access.prepare(
      tx,
      actorId,
      projectId,
      recordId,
      false,
    );
    if (
      record.rowVersion !== rowVersion ||
      record.currentVersion !== currentVersion
    )
      throw this.conflict();
    const before = await this.published.find(tx, projectId, recordId);
    if (!before) throw this.conflict();
    const validated = this.validate(input);
    validatePublishedRecordSearch({ ...before, ...validated });
    const after = await this.save(tx, actorId, record, validated, before.code);
    const assignee = await this.access.taskAssignee(tx, record);
    await this.effects.append(tx, actorId, before, after, "UPDATE", requestId, [
      before.authorId,
      ...(assignee === undefined ? [] : [assignee]),
    ]);
    return after;
  }
  private async save(
    tx: TransactionContext,
    actorId: number,
    record: PublicationIdentity,
    input: PublishedRecordContent,
    code: string,
  ) {
    const items = await this.repository.leftovers(
      tx,
      record.projectId,
      record.id,
    );
    const itemById = new Map(items.map((item) => [item.id, item]));
    const submitted: {
      content: string;
      item: { id: number; status: string; rowVersion: number };
    }[] = [];
    for (const entry of input.remainingIssues) {
      if (entry.id === undefined) {
        submitted.push({
          content: entry.content,
          item: await this.repository.createLeftover(
            tx,
            record.projectId,
            record.id,
            actorId,
          ),
        });
        continue;
      }
      const item = itemById.get(entry.id);
      if (!item)
        throw new RecordDraftError(
          409,
          "RECORD_LEFTOVER_CONFLICT",
          "提交的遗留问题与当前记录版本不一致，请加载最新内容后重试",
        );
      submitted.push({ content: entry.content, item });
    }
    // 已转任务的条目即使未提交也必须留在新版本快照里：任务链接与记录必须始终对得上。
    for (const item of items) {
      if (item.status !== "CONVERTED") continue;
      if (submitted.some((entry) => entry.item.id === item.id)) continue;
      if (item.content === null) throw this.conflict();
      submitted.push({ content: item.content, item });
    }
    // 已转任务的条目保持原状：既不改状态也不重复建任务，只保留其版本快照。
    const removedActive = items.filter(
      (item) =>
        item.status === "ACTIVE" &&
        !submitted.some((entry) => entry.item.id === item.id),
    );
    if (removedActive.length > 0 && !input.confirmLeftoverResolved)
      throw new RecordDraftError(
        422,
        "LEFTOVER_RESOLUTION_CONFIRMATION_REQUIRED",
        "清空或移除未转换的遗留问题前，请明确确认问题已解决",
      );
    for (const entry of removedActive) {
      if (
        !(await this.repository.setLeftoverStatus(
          tx,
          record.projectId,
          record.id,
          entry,
          "RESOLVED",
        ))
      )
        throw this.conflict();
    }
    for (const entry of submitted) {
      if (entry.item.status === "CONVERTED") continue;
      // 历史条目被重新提交时恢复为 ACTIVE，保证状态与当前版本一致。
      if (
        entry.item.status !== "ACTIVE" &&
        !(await this.repository.setLeftoverStatus(
          tx,
          record.projectId,
          record.id,
          entry.item,
          "ACTIVE",
        ))
      )
        throw this.conflict();
    }
    const content = {
      ...this.content(input),
      remainingIssues: submitted.map((entry) => ({
        id: entry.item.id,
        content: entry.content,
      })),
    };
    if (
      !(await this.repository.writeVersion(tx, record, actorId, content, code))
    )
      throw this.conflict();
    const result = await this.published.find(tx, record.projectId, record.id);
    if (!result) throw this.conflict();
    return result;
  }
  async appendLeftover(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    rowVersion: number,
    currentVersion: number,
    content: string,
    requestId: string,
  ) {
    const { record } = await this.access.prepare(
      tx,
      actorId,
      projectId,
      recordId,
      false,
    );
    if (
      record.rowVersion !== rowVersion ||
      record.currentVersion !== currentVersion
    )
      throw this.conflict();
    const before = await this.published.find(tx, projectId, recordId);
    if (!before) throw this.conflict();
    const validated = this.validate({
      ...this.content(before),
      remainingIssues: [...before.remainingIssues, { content }],
      confirmLeftoverResolved: true,
    });
    validatePublishedRecordSearch({ ...before, ...validated });
    const after = await this.save(tx, actorId, record, validated, before.code);
    const assignee = await this.access.taskAssignee(tx, record);
    await this.effects.append(
      tx,
      actorId,
      before,
      after,
      "ADD_LEFTOVER",
      requestId,
      [before.authorId, ...(assignee === undefined ? [] : [assignee])],
    );
    return after;
  }
  async replay(tx: TransactionContext, actorId: number, context: unknown) {
    const saved = recordPublicationReplayContextSchema.parse(context);
    const { record } = await this.access.prepare(
      tx,
      actorId,
      saved.projectId,
      saved.recordId,
      false,
    );
    if (record.moduleId !== saved.moduleId || record.taskId !== saved.taskId)
      throw this.conflict();
    const items = await this.repository.leftovers(
      tx,
      saved.projectId,
      saved.recordId,
    );
    if (
      saved.leftoverItemIds.some((id) => !items.some((item) => item.id === id))
    )
      throw new RecordDraftError(
        404,
        "RECORD_LEFTOVER_NOT_FOUND",
        "遗留项不存在或无法访问",
      );
  }
}
