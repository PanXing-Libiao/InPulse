import { createHmac } from "node:crypto";

import type { TransactionContext } from "../database/transaction-context.js";
import { canonicalizeJson } from "@inpulse/canonical-json";
import {
  AUDIT_CANONICAL_VERSION,
  type AuditAppendResult,
  type AuditHeadLock,
  type AuditWriteInput,
  AuditWritePort,
} from "./audit.port.js";
import type { AuditKeyProvider } from "./audit-keyring.js";
import { applyRequestAuditMeta } from "./request-audit-context.js";

interface AuditLockRow {
  readonly locked_last_sequence: string;
  readonly locked_last_hash: Buffer;
  readonly locked_key_version: number;
}

interface AuditActorSnapshot {
  readonly id: number;
  readonly name: string;
  readonly loginName: string;
}

/**
 * 基于 PostgreSQL 有限追加函数的审计写适配器（技术设计 §7）。
 *
 * 只接收显式 `TransactionContext`，在调用方事务内执行 `audit_lock_head` 与
 * `audit_append_locked`，从不自行开启事务，也不使用全局客户端。record_hash
 * 使用 `canonicalizeJson`（RFC 8785 JCS）对完整 envelope 生成 UTF-8 字节，
 * 再以链头当前密钥版本的 HMAC-SHA-256 计算；仅对完整 JCS 字节求 HMAC。
 */
export class PostgresAuditWritePort extends AuditWritePort {
  constructor(private readonly keyProvider: AuditKeyProvider) {
    super();
  }

  async append(
    tx: TransactionContext,
    input: AuditWriteInput,
  ): Promise<AuditAppendResult> {
    // 调用方显式提供的三字段优先，缺省取请求级审计上下文；两处都没有则留空。
    const effective = applyRequestAuditMeta(input);
    const actorSnapshot = await this.loadActorSnapshot(tx, effective);
    const chainId = auditChainId(effective.projectId);
    let lock = await this.lockHead(tx, chainId, effective.projectId);
    const currentVersion = this.keyProvider.currentVersion;

    if (
      effective.nextKeyVersion === undefined &&
      currentVersion > lock.keyVersion
    ) {
      const rotation = await this.appendLocked(
        tx,
        chainId,
        lock,
        {
          projectId: effective.projectId,
          actorType: "SYSTEM",
          actorId: null,
          action: "AUDIT_KEY_ROTATED",
          targetType: "SYSTEM",
          targetId: null,
          eventPayload: { newKeyVersion: currentVersion },
          requestId: effective.requestId,
          clientRequestId: effective.clientRequestId ?? null,
          ipAddress: effective.ipAddress ?? null,
          userAgent: effective.userAgent ?? null,
          occurredAt: effective.occurredAt ?? new Date(),
          nextKeyVersion: currentVersion,
        },
        null,
      );
      lock = {
        chainId,
        projectId: effective.projectId,
        lastSequence: rotation.sequenceNo,
        lastHash: rotation.recordHash,
        keyVersion: currentVersion,
      };
    }

    return this.appendLocked(tx, chainId, lock, effective, actorSnapshot);
  }

  private async appendLocked(
    tx: TransactionContext,
    chainId: string,
    lock: AuditHeadLock,
    input: AuditWriteInput,
    actorSnapshot: AuditActorSnapshot | null,
  ): Promise<AuditAppendResult> {
    const sequenceNo = lock.lastSequence + 1;
    const keyVersion = lock.keyVersion;
    const nextKeyVersion = input.nextKeyVersion ?? keyVersion;

    this.assertRotation(input, keyVersion, nextKeyVersion);

    const eventPayload = buildEventPayload(
      input,
      nextKeyVersion,
      actorSnapshot,
    );
    const envelope = {
      chainScope: chainId,
      sequenceNo,
      keyVersion,
      prevHash: lock.lastHash.toString("base64url"),
      eventPayload,
    };
    const recordHash = createHmac("sha256", this.keyProvider.keyFor(keyVersion))
      .update(canonicalizeJson(envelope), "utf8")
      .digest();

    const appended = (await tx.sql`
      SELECT *
        FROM app.audit_append_locked(
          ${chainId}::TEXT,
          ${input.projectId === null ? null : input.projectId}::INTEGER,
          ${sequenceNo}::BIGINT,
          ${lock.lastHash}::BYTEA,
          ${keyVersion}::SMALLINT,
          ${nextKeyVersion}::SMALLINT,
          ${input.actorType}::TEXT,
          ${input.actorId === null ? null : input.actorId}::INTEGER,
          ${input.action}::TEXT,
          ${input.targetType}::TEXT,
          ${input.targetId === null ? null : input.targetId}::TEXT,
          ${JSON.stringify(eventPayload)}::JSONB,
          ${input.requestId}::TEXT,
          ${input.clientRequestId == null ? null : input.clientRequestId}::TEXT,
          ${input.ipAddress == null ? null : input.ipAddress}::INET,
          ${input.userAgent == null ? null : input.userAgent}::TEXT,
          ${(input.occurredAt ?? new Date()).toISOString()}::TIMESTAMPTZ,
          ${recordHash}::BYTEA,
          ${AUDIT_CANONICAL_VERSION}::TEXT
        )
    `) as unknown as readonly { appended_sequence_no: string }[];
    const row = appended[0];
    if (row === undefined) {
      throw new Error("audit append returned no row");
    }
    return {
      chainId,
      sequenceNo: Number(row.appended_sequence_no),
      recordHash,
    };
  }

  private async lockHead(
    tx: TransactionContext,
    chainId: string,
    projectId: number | null,
  ): Promise<AuditHeadLock> {
    const rows = (await tx.sql`
      SELECT *
        FROM app.audit_lock_head(
          ${chainId}::TEXT,
          ${projectId === null ? null : projectId}::INTEGER,
          ${this.keyProvider.currentVersion}::SMALLINT
        )
    `) as unknown as AuditLockRow[];
    const head = rows[0];
    if (head === undefined) {
      throw new Error("audit head lock returned no row");
    }
    return {
      chainId,
      projectId,
      lastSequence: Number(head.locked_last_sequence),
      lastHash: Buffer.from(head.locked_last_hash),
      keyVersion: head.locked_key_version,
    };
  }

  private async loadActorSnapshot(
    tx: TransactionContext,
    input: AuditWriteInput,
  ): Promise<AuditActorSnapshot | null> {
    if (input.actorType === "SYSTEM") {
      return null;
    }
    if (input.actorId === null) {
      throw new Error("user audit requires an actor id");
    }
    const rows = (await tx.sql`
      SELECT id, name, login_name AS "loginName"
        FROM app.users
       WHERE id = ${input.actorId}
    `) as unknown as readonly AuditActorSnapshot[];
    const actor = rows[0];
    if (actor === undefined) {
      throw new Error("audit actor does not exist");
    }
    return {
      id: actor.id,
      name: actor.name,
      loginName: actor.loginName,
    };
  }

  private assertRotation(
    input: AuditWriteInput,
    keyVersion: number,
    nextKeyVersion: number,
  ): void {
    if (nextKeyVersion === keyVersion) {
      return;
    }
    if (
      nextKeyVersion <= keyVersion ||
      input.action !== "AUDIT_KEY_ROTATED" ||
      input.eventPayload["newKeyVersion"] !== nextKeyVersion
    ) {
      throw new Error("invalid audit key rotation");
    }
  }
}

function auditChainId(projectId: number | null): string {
  return projectId === null ? "SYSTEM" : `PROJECT:${projectId}`;
}

function buildEventPayload(
  input: AuditWriteInput,
  nextKeyVersion: number,
  actorSnapshot: AuditActorSnapshot | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...input.eventPayload,
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    targetType: input.targetType,
    targetId: input.targetId,
    requestId: input.requestId,
    clientRequestId: input.clientRequestId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    actorSnapshot,
  };
  if (input.nextKeyVersion !== undefined) {
    payload["newKeyVersion"] = nextKeyVersion;
  }
  return payload;
}
