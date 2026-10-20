import { describe, expect, test } from "vitest";

import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import {
  TimeCursorError,
  TimeCursorService,
  TIME_CURSOR_MAX_LENGTH,
  TIME_CURSOR_TTL_MS,
  type TimeCursorDecodeContext,
} from "../src/cursors/time-cursor.js";

function keyring(
  versions: readonly { readonly version: number; readonly key: Buffer }[],
  currentVersion: number,
): VersionedHmacKeyring {
  return VersionedHmacKeyring.fromEntries(versions, currentVersion);
}

const context: TimeCursorDecodeContext & { readonly nowMs: number } = {
  actorUserId: 7,
  namespace: "ACTIVITY",
  projectId: 42,
  nowMs: 1_800_000_000_000,
};

describe("TimeCursorService", () => {
  test("签发并校验绑定用户、命名空间和项目的签名游标", () => {
    const service = new TimeCursorService(
      keyring([{ version: 1, key: Buffer.alloc(32, 0x42) }], 1),
      "ACTIVITY",
    );
    const token = service.encode({
      ...context,
      afterAt: "2026-09-08T00:00:00.000Z",
      afterId: "42",
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(TIME_CURSOR_MAX_LENGTH);
    expect(service.decode(token, context)).toEqual({
      at: "2026-09-08T00:00:00.000Z",
      id: "42",
    });
    expect(service.decode(undefined, context)).toBeNull();
  });

  test("携带排序组时原样返回", () => {
    const service = new TimeCursorService(
      keyring([{ version: 1, key: Buffer.alloc(32, 0x42) }], 1),
      "ACTIVITY",
    );
    const token = service.encode({
      ...context,
      afterAt: "2026-09-08T00:00:00.000Z",
      afterId: "42",
      sortGroup: "UNREAD",
    });

    expect(service.decode(token, context)).toEqual({
      at: "2026-09-08T00:00:00.000Z",
      id: "42",
      sortGroup: "UNREAD",
    });
  });

  test("拒绝篡改签名、过期和绑到其他用户或项目的游标", () => {
    const service = new TimeCursorService(
      keyring([{ version: 1, key: Buffer.alloc(32, 0x42) }], 1),
      "ACTIVITY",
    );
    const token = service.encode({
      ...context,
      afterAt: "2026-09-08T00:00:00.000Z",
      afterId: "42",
    });

    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expectReject(tampered, context, "signature");
    expectReject(
      token,
      { ...context, nowMs: context.nowMs + TIME_CURSOR_TTL_MS + 1 },
      "expired",
    );
    expectReject(token, { ...context, actorUserId: 8 }, "actor-mismatch");
    expectReject(token, { ...context, projectId: 43 }, "project-mismatch");
    expectReject(
      token,
      { ...context, namespace: "NOTIFICATION", projectId: null },
      "namespace-mismatch",
    );
  });

  test("拒绝畸形游标、未知 key 版本与错误命名空间编码", () => {
    const service = new TimeCursorService(
      keyring([{ version: 1, key: Buffer.alloc(32, 0x42) }], 1),
      "ACTIVITY",
    );
    const rotating = new TimeCursorService(
      keyring(
        [
          { version: 1, key: Buffer.alloc(32, 0x42) },
          { version: 2, key: Buffer.alloc(32, 0x24) },
        ],
        2,
      ),
      "ACTIVITY",
    );

    expect(() => service.decode("not-a-cursor", context)).toThrowError(
      expect.objectContaining<Partial<TimeCursorError>>({
        reason: "malformed",
      }),
    );

    const token = rotating.encode({
      ...context,
      afterAt: "2026-09-08T00:00:00.000Z",
      afterId: "42",
    });
    expectReject(token, context, "version");
    expect(() =>
      service.encode({
        ...context,
        namespace: "NOTIFICATION",
        afterAt: "2026-09-08T00:00:00.000Z",
        afterId: "42",
      }),
    ).toThrow("namespace does not match service");
  });
});

function expectReject(
  cursor: string,
  decodeContext: TimeCursorDecodeContext,
  reason: string,
): void {
  const service = new TimeCursorService(
    keyring([{ version: 1, key: Buffer.alloc(32, 0x42) }], 1),
    "ACTIVITY",
  );
  expect(() => service.decode(cursor, decodeContext)).toThrowError(
    expect.objectContaining<Partial<TimeCursorError>>({ reason }),
  );
}
