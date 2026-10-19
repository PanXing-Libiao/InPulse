import type { TransactionContext } from "../../database/transaction-context.js";

export const ACTIVITY_VISIBILITY_SCOPES = ["MEMBER", "ADMIN_ONLY"] as const;
export const ACTIVITY_ENTITY_TYPES = [
  "PROJECT",
  "MODULE",
  "FEATURE",
  "TASK",
  "CHANGE_RECORD",
  "EXTERNAL_LINK",
  "TASK_GROUP",
  "LEFTOVER_ITEM",
] as const;

/** `activity_projection.summary` 的字符上限；动态摘要构造器必须按同一上限截断。 */
export const ACTIVITY_SUMMARY_MAX_LENGTH = 1000;

export type ActivityVisibilityScope =
  (typeof ACTIVITY_VISIBILITY_SCOPES)[number];
export type ActivitySourceEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export interface ActivityWriteInput {
  readonly projectId: number;
  readonly sourceChainId: string;
  readonly sourceSequence: number;
  readonly sourceEntityType: ActivitySourceEntityType;
  readonly sourceEntityId: number;
  readonly activityType: string;
  readonly actorId: number | null;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly visibilityScope: ActivityVisibilityScope;
  readonly sourceStatus: string;
  readonly sourceRowVersion: number;
  readonly occurredAt: Date;
}

export interface ActivityVisibilityUpdateInput {
  readonly projectId: number;
  readonly sourceEntityType: ActivitySourceEntityType;
  readonly sourceEntityId: number;
  readonly visibilityScope: ActivityVisibilityScope;
  readonly sourceStatus: string;
  readonly sourceRowVersion: number;
}

export class ActivityWriteValidationError extends Error {
  readonly code = "ACTIVITY_WRITE_VALIDATION_ERROR" as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = "ActivityWriteValidationError";
  }
}

/**
 * 项目动态投影维护边界。调用方必须持有业务事务与脱敏后的白名单字段；
 * 本 Port 只负责校验、写入和按来源实体同步派生可见性，不读取业务表。
 */
export interface ActivityUserRenameInput {
  readonly userId: number;
  readonly previousName: string;
  readonly replacementName: string;
}

export abstract class ActivityWritePort {
  abstract append(
    tx: TransactionContext,
    input: ActivityWriteInput,
  ): Promise<void>;

  abstract updateEntityVisibility(
    tx: TransactionContext,
    input: ActivityVisibilityUpdateInput,
  ): Promise<void>;

  /**
   * ADR-082：账号墓碑化时改写该用户参与的人员类动态摘要。
   * 只改项目动态投影，不触碰审计原始事件载荷或 HMAC 哈希链。
   */
  abstract renameUserReferences(
    tx: TransactionContext,
    input: ActivityUserRenameInput,
  ): Promise<number>;
}

export function validateActivityWriteInput(input: ActivityWriteInput): void {
  if (!positiveInteger(input.projectId)) {
    invalid("projectId must be a positive integer");
  }
  if (input.sourceChainId !== `PROJECT:${input.projectId}`) {
    invalid("sourceChainId must match the project audit chain");
  }
  if (!positiveInteger(input.sourceSequence)) {
    invalid("sourceSequence must be a positive integer");
  }
  if (!ACTIVITY_ENTITY_TYPES.includes(input.sourceEntityType)) {
    invalid("sourceEntityType is not supported");
  }
  if (!positiveInteger(input.sourceEntityId)) {
    invalid("sourceEntityId must be a positive integer");
  }
  if (
    input.activityType.trim().length === 0 ||
    input.activityType.length > 100
  ) {
    invalid("activityType must contain 1 to 100 characters");
  }
  if (input.actorId !== null && !positiveInteger(input.actorId)) {
    invalid("actorId must be null or a positive integer");
  }
  if (
    input.summary.trim().length === 0 ||
    input.summary.length > ACTIVITY_SUMMARY_MAX_LENGTH
  ) {
    invalid("summary must contain 1 to 1000 characters");
  }
  if (
    typeof input.metadata !== "object" ||
    input.metadata === null ||
    Array.isArray(input.metadata)
  ) {
    invalid("metadata must be a JSON object");
  }
  if (!ACTIVITY_VISIBILITY_SCOPES.includes(input.visibilityScope)) {
    invalid("visibilityScope is not supported");
  }
  if (
    input.sourceStatus.trim().length === 0 ||
    input.sourceStatus.length > 50
  ) {
    invalid("sourceStatus must contain 1 to 50 characters");
  }
  if (!positiveInteger(input.sourceRowVersion)) {
    invalid("sourceRowVersion must be a positive integer");
  }
  if (!Number.isFinite(input.occurredAt.getTime())) {
    invalid("occurredAt must be a valid date");
  }
}

export function validateActivityVisibilityUpdateInput(
  input: ActivityVisibilityUpdateInput,
): void {
  if (!positiveInteger(input.projectId)) {
    invalid("projectId must be a positive integer");
  }
  if (!ACTIVITY_ENTITY_TYPES.includes(input.sourceEntityType)) {
    invalid("sourceEntityType is not supported");
  }
  if (!positiveInteger(input.sourceEntityId)) {
    invalid("sourceEntityId must be a positive integer");
  }
  if (!ACTIVITY_VISIBILITY_SCOPES.includes(input.visibilityScope)) {
    invalid("visibilityScope is not supported");
  }
  if (
    input.sourceStatus.trim().length === 0 ||
    input.sourceStatus.length > 50
  ) {
    invalid("sourceStatus must contain 1 to 50 characters");
  }
  if (!positiveInteger(input.sourceRowVersion)) {
    invalid("sourceRowVersion must be a positive integer");
  }
}

export function validateActivityUserRenameInput(
  input: ActivityUserRenameInput,
): void {
  if (!positiveInteger(input.userId)) {
    invalid("userId must be a positive integer");
  }
  if (
    input.previousName.trim().length === 0 ||
    input.previousName.length > 200 ||
    input.replacementName.trim().length === 0 ||
    input.replacementName.length > 200
  ) {
    invalid("user names must contain 1 to 200 characters");
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function invalid(reason: string): never {
  throw new ActivityWriteValidationError(reason);
}
