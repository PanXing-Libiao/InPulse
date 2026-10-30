import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildGroupWrapText,
  buildPersonalWrapText,
  imageMessageFromPoster,
  normalizeWrapSnapshot,
  posterBufferInfo,
  renderWrapPoster,
} from "./wrap-poster.mjs";

test("ships OFL Noto fonts for deterministic poster rendering", () => {
  for (const name of [
    "NotoSansSC-Regular.ttf",
    "NotoSansSC-Black.ttf",
    "OFL.txt",
  ]) {
    assert.ok(
      existsSync(
        fileURLToPath(new URL(`./assets/fonts/${name}`, import.meta.url)),
      ),
      name,
    );
  }
});

const snapshot = {
  version: 1,
  project: { id: 7, code: "SHOP", name: "商城系统" },
  stats: {
    completedTaskCount: 42,
    publishedRecordCount: 18,
    activeMemberCount: 6,
    activeModuleCount: 3,
    openTaskCount: 0,
    durationDays: 96,
    completionPercent: 100,
  },
  participants: [
    { userId: 6, name: "林雨研", role: "LEADER", completedTaskCount: 20 },
    { userId: 7, name: "刘安楠", role: "MEMBER", completedTaskCount: 12 },
  ],
  timeline: {
    foundedAt: "2026-07-15T00:00:00.000Z",
    firstRecordAt: "2026-07-20T00:00:00.000Z",
    lastTaskCompletedAt: "2026-10-18T00:00:00.000Z",
    sealedAt: "2026-10-20T00:00:00.000Z",
  },
};

test("normalizes a version 1 snapshot and formats dates in Asia/Shanghai", () => {
  const value = normalizeWrapSnapshot(JSON.stringify(snapshot));
  assert.equal(value.version, 1);
  assert.equal(value.project.name, "商城系统");
  assert.equal(value.stats.completedTaskCount, 42);
  assert.equal(value.stats.activeFeatureCount, undefined);
  assert.equal(value.participants.length, 2);
  assert.equal(value.timeline.foundedAt, "2026.07.15");
  assert.equal(value.timeline.sealedAt, "2026.10.20");
});

test("accepts an already normalized snapshot and renders a missing first record date", async () => {
  const normalized = normalizeWrapSnapshot({
    ...snapshot,
    timeline: { ...snapshot.timeline, firstRecordAt: null },
  });
  assert.equal(normalized.timeline.firstRecordAt, "—");
  assert.deepEqual(normalizeWrapSnapshot(normalized), normalized);
  const poster = await renderWrapPoster({
    snapshot: normalized,
    recipientName: "林雨研",
  });
  assert.equal(poster.width, 1080);
  assert.ok(poster.buffer.length > 20000);
});

test("rejects unknown template versions and malformed participant rows", () => {
  assert.throws(
    () => normalizeWrapSnapshot({ ...snapshot, version: 2 }),
    /不支持的项目封箱模板版本/,
  );
  assert.throws(
    () =>
      normalizeWrapSnapshot({
        ...snapshot,
        participants: [{ userId: 0, name: "", role: "MEMBER" }],
      }),
    /参与者字段非法/,
  );
});

test("builds group and personal copy from the frozen snapshot", () => {
  const group = buildGroupWrapText(snapshot);
  assert.match(group, /叮——最后一盏灯灭了。/);
  assert.match(group, /商城系统/);
  const personal = buildPersonalWrapText(snapshot);
  assert.match(personal, /这一箱，有你的名字。/);
  assert.match(personal, /42 个任务/);
  assert.match(personal, /96 天/);
});

test("renders a JPEG poster with stable base64 and md5 metadata", async () => {
  const poster = await renderWrapPoster({ snapshot, recipientName: "林雨研" });
  assert.equal(poster.mimeType, "image/jpeg");
  assert.equal(poster.width, 1080);
  assert.equal(poster.height, 1350);
  assert.ok(poster.buffer.length > 20000);
  assert.equal(poster.buffer[0], 0xff);
  assert.equal(poster.buffer[1], 0xd8);
  assert.equal(poster.buffer.at(-2), 0xff);
  assert.equal(poster.buffer.at(-1), 0xd9);
  const info = posterBufferInfo(poster.buffer);
  assert.equal(info.md5, poster.md5);
  assert.equal(info.base64, poster.base64);
  assert.equal(Buffer.from(info.base64, "base64").length, poster.buffer.length);
  assert.deepEqual(imageMessageFromPoster(poster), {
    msgtype: "image",
    image: { base64: poster.base64, md5: poster.md5 },
  });
});
