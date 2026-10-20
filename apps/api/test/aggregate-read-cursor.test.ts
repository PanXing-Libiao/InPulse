import { describe, expect, test } from "vitest";

import { AGGREGATE_READ_CURSOR_MAX_LENGTH } from "@inpulse/api-contract";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import {
  AggregateReadCursorError,
  AggregateReadCursorService,
  AGGREGATE_READ_CURSOR_TTL_MS,
  type AggregateReadCursorErrorReason,
  type AggregateReadCursorNamespace,
} from "../src/modules/aggregate-read/aggregate-read-cursor.js";

function build(
  versions: readonly { readonly version: number; readonly key: Buffer }[],
  currentVersion: number,
): AggregateReadCursorService {
  return new AggregateReadCursorService(
    VersionedHmacKeyring.fromEntries(versions, currentVersion),
  );
}

function service(): AggregateReadCursorService {
  return build([{ version: 1, key: Buffer.alloc(32, 0x42) }], 1);
}

const nowMs = 1_800_000_000_000;

const context = {
  actorUserId: 7,
  namespace: "MY_TASKS" as AggregateReadCursorNamespace,
  filterKey: JSON.stringify([null, null, null, null]),
  nowMs,
};

function expectReason(
  run: () => unknown,
  reason: AggregateReadCursorErrorReason,
): void {
  expect(run).toThrowError(
    expect.objectContaining<Partial<AggregateReadCursorError>>({
      name: "AggregateReadCursorError",
      reason,
    }),
  );
}

describe("AggregateReadCursorService", () => {
  test("签发不透明游标并绑定 actor、命名空间与筛选", () => {
    const cursors = service();
    const token = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs,
    });

    expect(token.includes(".")).toBe(true);
    expect(/[^A-Za-z0-9_.-]/.test(token)).toBe(false);
    expect(token.length).toBeLessThanOrEqual(AGGREGATE_READ_CURSOR_MAX_LENGTH);
    expect(cursors.decode(token, context)).toBe(42);
    expect(cursors.decode(undefined, context)).toBeNull();

    const groupToken = cursors.encode({
      actorUserId: 7,
      namespace: "TASK_GROUP_RECORDS",
      filterKey: "TASK_GROUP_RECORDS:11:all",
      afterId: 99,
      nowMs,
    });
    expect(
      cursors.decode(groupToken, {
        ...context,
        namespace: "TASK_GROUP_RECORDS",
        filterKey: "TASK_GROUP_RECORDS:11:all",
      }),
    ).toBe(99);
    expectReason(
      () => cursors.decode(groupToken, context),
      "namespace-mismatch",
    );
  });

  test("拒绝篡改签名", () => {
    const cursors = service();
    const token = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs,
    });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    expectReason(() => cursors.decode(tampered, context), "signature");
  });

  test("拒绝过期游标并保留 TTL 边界", () => {
    const cursors = service();
    const atBoundary = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs: nowMs - AGGREGATE_READ_CURSOR_TTL_MS,
    });
    expectReason(() => cursors.decode(atBoundary, context), "expired");

    const justInside = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs: nowMs - AGGREGATE_READ_CURSOR_TTL_MS + 1,
    });
    expect(cursors.decode(justInside, context)).toBe(42);
  });

  test("拒绝跨用户与跨筛选复用", () => {
    const cursors = service();
    const token = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs,
    });

    expectReason(
      () => cursors.decode(token, { ...context, actorUserId: 8 }),
      "actor-mismatch",
    );
    expectReason(
      () =>
        cursors.decode(token, {
          ...context,
          filterKey: JSON.stringify([9, null, null, null]),
        }),
      "filter-mismatch",
    );
  });

  test("拒绝畸形游标与缺失 keyring 版本", () => {
    const cursors = service();
    expectReason(() => cursors.decode("not-a-cursor", context), "malformed");
    expectReason(() => cursors.decode("a.b.c", context), "malformed");
    expectReason(() => cursors.decode(".signature", context), "malformed");
    expectReason(() => cursors.decode("payload.", context), "malformed");
    expectReason(() => cursors.decode("!!!.AAA", context), "malformed");
    expectReason(
      () =>
        cursors.decode(
          Buffer.from("notjson", "utf8").toString("base64url") + "." + "AAAA",
          context,
        ),
      "malformed",
    );

    const rotating = build([{ version: 2, key: Buffer.alloc(32, 0x24) }], 2);
    const token = service().encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs,
    });
    expectReason(() => rotating.decode(token, context), "version");
  });

  test("MY_TASKS 游标携带多列排序键并随签名绑定（ADR-037）", () => {
    const cursors = service();
    const sortKey = "6|0||1|2|2026-09-18T01:00:00.000Z|42";
    const token = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      sortKey,
      nowMs,
    });

    expect(
      cursors.decodeKey(token, { ...context, requireSortKey: true }),
    ).toEqual({ afterId: 42, sortKey });
    expect(cursors.decode(token, { ...context, requireSortKey: true })).toBe(
      42,
    );
    // 其它命名空间仍只有单列位置。
    const groupToken = cursors.encode({
      actorUserId: 7,
      namespace: "TASK_GROUP_RECORDS",
      filterKey: "TASK_GROUP_RECORDS:11:all",
      afterId: 99,
      nowMs,
    });
    expect(
      cursors.decodeKey(groupToken, {
        ...context,
        filterKey: "TASK_GROUP_RECORDS:11:all",
        namespace: "TASK_GROUP_RECORDS",
      }),
    ).toEqual({ afterId: 99, sortKey: null });
  });

  test("MY_TASKS 拒绝缺少排序键的旧载荷，且篡改排序键被签名拒绝", () => {
    const cursors = service();
    const legacy = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      nowMs,
    });
    expectReason(
      () => cursors.decodeKey(legacy, { ...context, requireSortKey: true }),
      "version",
    );
    // 不要求排序键的调用方（如其它命名空间路径）仍可解出单列位置。
    expect(cursors.decodeKey(legacy, context)).toEqual({
      afterId: 42,
      sortKey: null,
    });

    const token = cursors.encode({
      actorUserId: 7,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 42,
      sortKey: "6|0||1|2|2026-09-18T01:00:00.000Z|42",
      nowMs,
    });
    const [payloadRaw, signature] = token.split(".") as [string, string];
    const payload = JSON.parse(
      Buffer.from(payloadRaw, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const forged = Buffer.from(
      JSON.stringify({ ...payload, k: "6|0||3|2||42" }),
      "utf8",
    ).toString("base64url");
    expectReason(
      () =>
        cursors.decodeKey(forged + "." + signature, {
          ...context,
          requireSortKey: true,
        }),
      "signature",
    );
  });

  test("MY_TASKS 最长排序键游标仍符合响应契约上限", () => {
    const cursors = service();
    // 真实排序键同时带完成时间与截止时间时长度最大；回归 2026-10-20 发现的
    // 「nextCursor 超过 256 导致 listMyTasks 响应契约校验 500」。
    const sortKey =
      "7|0|2026-09-18T01:00:00.000Z|3|2|1|2026-12-31T23:59:59.999Z|2147483647";
    const token = cursors.encode({
      actorUserId: 2147483647,
      namespace: "MY_TASKS",
      filterKey: context.filterKey,
      afterId: 2147483647,
      sortKey,
      nowMs,
    });

    expect(token.length).toBeLessThanOrEqual(AGGREGATE_READ_CURSOR_MAX_LENGTH);
    expect(
      cursors.decodeKey(token, {
        ...context,
        actorUserId: 2147483647,
        requireSortKey: true,
      }),
    ).toEqual({ afterId: 2147483647, sortKey });
  });

  test("签发拒绝非正整数的 afterId", () => {
    const cursors = service();
    expect(() =>
      cursors.encode({
        actorUserId: 7,
        namespace: "MY_TASKS",
        filterKey: context.filterKey,
        afterId: 0,
        nowMs,
      }),
    ).toThrowError(/positive integer/);
  });
});
