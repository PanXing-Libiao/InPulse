import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import type { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import type { ProjectAccessQueryPort } from "../src/modules/projects/index.js";
import { PublishedRecordReadService } from "../src/modules/change-records/published-record-read.service.js";
import { RecordDraftsService } from "../src/modules/change-records/record-drafts.service.js";
import type { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import type { PublishedRecordRepository } from "../src/modules/change-records/published-record.repository.js";
import { allowProjectMemberPermissions } from "./project-member-permission.helpers.js";

const ring = VersionedHmacKeyring.fromEntries(
  [{ version: 1, key: randomBytes(32) }],
  1,
);
const position = { at: "2026-09-11T06:16:15.123456Z", id: "7" };

function accessStub(
  projectIds: readonly number[] = [5],
): ProjectAccessQueryPort {
  return {
    getAuthorizedSearchScope: vi
      .fn()
      .mockResolvedValue({ projectIds, isSystemAdmin: false }),
    checkProjectForWrite: vi.fn(),
  } as unknown as ProjectAccessQueryPort;
}

function uowStub(): PostgresUnitOfWork {
  return {
    run: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  } as unknown as PostgresUnitOfWork;
}

function publishedService(
  repository: PublishedRecordRepository,
  projectIds: readonly number[] = [5],
) {
  return new PublishedRecordReadService(
    accessStub(projectIds),
    uowStub(),
    repository,
    new TimeCursorService(ring, "CHANGE_RECORDS"),
  );
}

function draftsService(repository: RecordDraftRepository) {
  return new RecordDraftsService(
    accessStub(),
    { listNames: async () => [] } as never,
    { listNames: async () => [] } as never,
    { listNames: async () => [] } as never,
    { listNames: async () => [] } as never,
    repository,
    uowStub(),
    { listNames: async () => [] } as never,
    new TimeCursorService(ring, "RECORD_DRAFTS"),
    allowProjectMemberPermissions(),
  );
}

describe("B-1 record list pagination", () => {
  it("encodes the last returned position and replays it as an exclusive keyset bound", async () => {
    const listPublishedPage = vi.fn().mockResolvedValue({
      items: [{ id: 7 }],
      last: position,
      hasMore: true,
    });
    const service = publishedService({
      listPublishedPage,
      listVoidedPage: vi.fn(),
    } as unknown as PublishedRecordRepository);
    const page = await service.list(9, 5, {});
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    expect(listPublishedPage).toHaveBeenCalledWith(expect.anything(), {
      projectId: 5,
      limit: 20,
      after: null,
    });
    listPublishedPage.mockResolvedValue({
      items: [],
      last: null,
      hasMore: false,
    });
    const second = await service.list(9, 5, { cursor: page.nextCursor! });
    expect(second.nextCursor).toBeNull();
    expect(listPublishedPage).toHaveBeenLastCalledWith(expect.anything(), {
      projectId: 5,
      limit: 20,
      after: position,
    });
  });
  it("rejects tampered, cross-actor and cross-project cursors with 422, and hides inaccessible projects behind 404", async () => {
    const service = publishedService({
      listPublishedPage: vi.fn(),
      listVoidedPage: vi.fn(),
    } as unknown as PublishedRecordRepository);
    const issued = new TimeCursorService(ring, "CHANGE_RECORDS").encode({
      actorUserId: 9,
      namespace: "CHANGE_RECORDS",
      projectId: 5,
      afterAt: position.at,
      afterId: position.id,
    });
    await expect(
      service.list(9, 5, { cursor: issued.slice(0, -2) + "xy" }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
    await expect(service.list(10, 5, { cursor: issued })).rejects.toMatchObject(
      { status: 422, code: "INVALID_CURSOR" },
    );
    const wide = publishedService(
      {
        listPublishedPage: vi.fn(),
        listVoidedPage: vi.fn(),
      } as unknown as PublishedRecordRepository,
      [5, 6],
    );
    await expect(wide.list(9, 6, { cursor: issued })).rejects.toMatchObject({
      status: 422,
      code: "INVALID_CURSOR",
    });
    await expect(service.list(9, 6, { cursor: issued })).rejects.toMatchObject({
      status: 404,
      code: "CHANGE_RECORD_NOT_FOUND",
    });
  });
  it("hides the voided bucket from members and drafts reuse of the other namespace", async () => {
    const service = publishedService({
      listPublishedPage: vi.fn(),
      listVoidedPage: vi.fn(),
    } as unknown as PublishedRecordRepository);
    await expect(service.list(9, 5, { status: "VOID" })).rejects.toMatchObject({
      status: 404,
    });
    const drafts = draftsService({
      listPage: vi.fn(),
      find: vi.fn(),
    } as unknown as RecordDraftRepository);
    const recordsCursor = new TimeCursorService(ring, "CHANGE_RECORDS").encode({
      actorUserId: 9,
      namespace: "CHANGE_RECORDS",
      projectId: 5,
      afterAt: position.at,
      afterId: position.id,
    });
    await expect(
      drafts.read(9, 5, undefined, { cursor: recordsCursor }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
  });
  it("returns the draft page envelope with limit 1..100 default 20", async () => {
    const listPage = vi.fn().mockResolvedValue({
      items: [
        {
          id: 8,
          projectId: 5,
          moduleId: 2,
          featureId: null,
          impactFeatureIds: [],
          authorId: 9,
          handlerId: 9,
        },
      ],
      last: position,
      hasMore: true,
    });
    const drafts = draftsService({
      listPage,
      find: vi.fn(),
    } as unknown as RecordDraftRepository);
    const page = await drafts.read(9, 5, undefined, { limit: 50 });
    expect(page).toMatchObject({ hasMore: true });
    expect(listPage).toHaveBeenCalledWith(expect.anything(), {
      projectId: 5,
      limit: 50,
      after: null,
    });
    expect(
      page && typeof page === "object" && "nextCursor" in page
        ? page.nextCursor
        : null,
    ).not.toBeNull();
  });
});
