import { createHmac, timingSafeEqual } from "node:crypto";

import type { VersionedHmacKeyring } from "../auth/keyring.js";

export const TIME_CURSOR_TTL_MS = 15 * 60 * 1000;
export const TIME_CURSOR_MAX_LENGTH = 512;

export interface TimeCursorEncodeInput {
  readonly actorUserId: number;
  readonly namespace: string;
  readonly projectId: number | null;
  readonly afterAt: string;
  readonly afterId: string;
  /** 通知等列表的排序分组，例如 UNREAD / READ；解码后原样返回。 */
  readonly sortGroup?: string | null;
  /**
   * 可选：本接口的规范化筛选摘要（B-3b 跨项目记录读）。提供后解码必须复现
   * 完全相同的字符串，否则按筛选不匹配拒绝，游标不得跨筛选复用。
   */
  readonly filterKey?: string | null;
  readonly nowMs?: number;
}

export interface TimeCursorDecodeContext {
  readonly actorUserId: number;
  readonly namespace: string;
  readonly projectId: number | null;
  /** 与 encode 对称的可选筛选摘要；调用方必须传入同一份规范化文本。 */
  readonly filterKey?: string | null;
  readonly nowMs?: number;
}

export interface TimeCursorValue {
  readonly at: string;
  readonly id: string;
  readonly sortGroup?: string | null;
}

interface TimeCursorPayload {
  readonly v: number;
  readonly u: number;
  readonly n: string;
  readonly p: number | null;
  readonly f: string | null;
  readonly a: string;
  readonly i: string;
  readonly g: string | null;
  readonly e: number;
}

export class TimeCursorError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "TimeCursorError";
  }
}

/**
 * 服务端签名的时间游标：base64url(payload).base64url(HMAC-SHA-256)。
 * 同时绑定 keyring 版本、当前用户、业务命名空间、可选的 projectId 与可选的
 * 规范化筛选摘要，防止把 Activity 游标用于通知、其他项目或其他筛选条件。
 * 调用方只能解析，不能伪造。
 */
export class TimeCursorService {
  constructor(
    private readonly keyring: VersionedHmacKeyring,
    private readonly namespace: string,
  ) {}

  encode(input: TimeCursorEncodeInput): string {
    if (!positiveInteger(input.actorUserId)) {
      throw new Error("time cursor actorUserId must be a positive integer");
    }
    if (this.namespace !== input.namespace) {
      throw new Error("time cursor namespace does not match service");
    }
    if (
      input.projectId !== null &&
      (!Number.isSafeInteger(input.projectId) || input.projectId <= 0)
    ) {
      throw new Error(
        "time cursor projectId must be a positive integer or null",
      );
    }
    if (!validTimestamp(input.afterAt)) {
      throw new Error("time cursor afterAt is invalid");
    }
    if (!positiveIntegerString(input.afterId)) {
      throw new Error("time cursor afterId must be a positive integer string");
    }
    if (
      input.sortGroup !== undefined &&
      input.sortGroup !== null &&
      !validSortGroup(input.sortGroup)
    ) {
      throw new Error("time cursor sortGroup is invalid");
    }

    const nowMs = input.nowMs ?? Date.now();
    const payload: TimeCursorPayload = {
      v: this.keyring.currentVersion,
      u: input.actorUserId,
      n: input.namespace,
      p: input.projectId,
      f: input.filterKey ?? null,
      a: input.afterAt,
      i: input.afterId,
      g: input.sortGroup ?? null,
      e: nowMs + TIME_CURSOR_TTL_MS,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    return `${encoded}.${sign(encoded, this.keyring.currentKey()).toString(
      "base64url",
    )}`;
  }

  decode(
    cursor: string | undefined,
    context: TimeCursorDecodeContext,
  ): TimeCursorValue | null {
    if (cursor === undefined) {
      return null;
    }
    if (cursor.length > TIME_CURSOR_MAX_LENGTH) {
      fail("too-long", "time cursor exceeds the maximum length");
    }

    const separator = cursor.indexOf(".");
    if (
      separator <= 0 ||
      separator === cursor.length - 1 ||
      cursor.indexOf(".", separator + 1) !== -1
    ) {
      fail("malformed", "time cursor must contain one payload and signature");
    }
    const encoded = cursor.slice(0, separator);
    const signatureRaw = cursor.slice(separator + 1);
    if (
      !BASE64URL_PATTERN.test(encoded) ||
      !BASE64URL_PATTERN.test(signatureRaw)
    ) {
      fail("malformed", "time cursor contains invalid base64url characters");
    }

    const payload = parsePayload(encoded);
    let key: Buffer;
    try {
      key = this.keyring.keyFor(payload.v);
    } catch {
      fail("version", "time cursor key version is not available");
    }

    const expected = sign(encoded, key);
    const provided = Buffer.from(signatureRaw, "base64url");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(expected, provided)
    ) {
      fail("signature", "time cursor signature is invalid");
    }

    const nowMs = context.nowMs ?? Date.now();
    if (nowMs >= payload.e) {
      fail("expired", "time cursor has expired");
    }
    if (payload.u !== context.actorUserId) {
      fail("actor-mismatch", "time cursor actor does not match");
    }
    if (payload.n !== context.namespace) {
      fail("namespace-mismatch", "time cursor namespace does not match");
    }
    if (payload.p !== context.projectId) {
      fail("project-mismatch", "time cursor project does not match");
    }
    if ((payload.f ?? null) !== (context.filterKey ?? null)) {
      fail("filter-mismatch", "time cursor filter does not match");
    }
    const value: TimeCursorValue = { at: payload.a, id: payload.i };
    return payload.g === null ? value : { ...value, sortGroup: payload.g };
  }
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function sign(value: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveIntegerString(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function validSortGroup(value: string): boolean {
  return (
    value.length > 0 && value.length <= 32 && /^[A-Z][A-Z0-9_]*$/.test(value)
  );
}

function validTimestamp(value: string): boolean {
  return (
    value.length <= 64 &&
    TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parsePayload(raw: string): TimeCursorPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    fail("malformed", "time cursor payload is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    fail("malformed", "time cursor payload must be an object");
  }
  const payload = value as Partial<TimeCursorPayload>;
  if (!positiveInteger(payload.v ?? 0)) {
    fail("malformed", "time cursor key version is invalid");
  }
  if (!positiveInteger(payload.u ?? 0)) {
    fail("malformed", "time cursor actor id is invalid");
  }
  if (
    typeof payload.n !== "string" ||
    payload.n.length === 0 ||
    payload.n.length > 40 ||
    !/^[A-Z][A-Z0-9_]*$/.test(payload.n)
  ) {
    fail("malformed", "time cursor namespace is invalid");
  }
  if (
    payload.f !== undefined &&
    payload.f !== null &&
    (typeof payload.f !== "string" ||
      payload.f.length === 0 ||
      payload.f.length > 1024)
  ) {
    fail("malformed", "time cursor filter key is invalid");
  }
  if (
    payload.p !== null &&
    (!Number.isSafeInteger(payload.p) || (payload.p ?? 0) <= 0)
  ) {
    fail("malformed", "time cursor projectId is invalid");
  }
  if (typeof payload.a !== "string" || !validTimestamp(payload.a)) {
    fail("malformed", "time cursor after timestamp is invalid");
  }
  if (typeof payload.i !== "string" || !positiveIntegerString(payload.i)) {
    fail("malformed", "time cursor after id is invalid");
  }
  if (
    payload.g !== undefined &&
    payload.g !== null &&
    (typeof payload.g !== "string" || !validSortGroup(payload.g))
  ) {
    fail("malformed", "time cursor sort group is invalid");
  }
  if (!positiveInteger(payload.e ?? 0)) {
    fail("malformed", "time cursor expiry is invalid");
  }
  return {
    v: payload.v!,
    u: payload.u!,
    n: payload.n,
    p: payload.p ?? null,
    f: payload.f ?? null,
    a: payload.a,
    i: payload.i,
    g: payload.g ?? null,
    e: payload.e!,
  };
}

function fail(reason: string, message: string): never {
  throw new TimeCursorError(reason, message);
}
