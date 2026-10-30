import type {
  RecordDraftContent,
  RecordDraftItem,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
export interface RecordSourceSnapshot {
  taskId: number;
  projectId: number;
  moduleId: number;
  assigneeId: number;
}
/** Workflow has authorized/locked the real source and parents in the shared transaction. */
export abstract class RecordDraftCommandPort {
  /** Bind only an unbound matching draft; never move scope or replace an existing task link. Caller prelocks parents/task/record. */
  abstract bindForCompletion(
    tx: TransactionContext,
    actorId: number,
    source: RecordSourceSnapshot,
    recordId: number,
    version: number,
    requestId: string,
  ): Promise<RecordDraftItem>;
  abstract createFromTask(
    tx: TransactionContext,
    actorId: number,
    source: RecordSourceSnapshot,
    content: RecordDraftContent,
    requestId: string,
  ): Promise<RecordDraftItem>;
  abstract updateFromTask(
    tx: TransactionContext,
    actorId: number,
    source: RecordSourceSnapshot,
    recordId: number,
    version: number,
    content: RecordDraftContent,
    requestId: string,
  ): Promise<RecordDraftItem>;
}
export abstract class RecordDraftQueryPort {
  abstract lockDraft(
    tx: TransactionContext,
    projectId: number,
    recordId: number,
  ): Promise<RecordDraftItem | undefined>;
  abstract authorsForTask(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
  ): Promise<number[]>;
  abstract findDraft(
    tx: TransactionContext,
    projectId: number,
    recordId: number,
  ): Promise<RecordDraftItem | undefined>;
  abstract listForTask(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
  ): Promise<RecordDraftItem[]>;
}
