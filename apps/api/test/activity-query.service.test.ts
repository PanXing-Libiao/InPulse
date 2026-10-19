import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import type {
  ActivityDayTotal,
  ActivityProjectionDayTotalsInput,
  ActivityProjectionItem,
  ActivityProjectionPage,
  ActivityProjectionReadInput,
  ActivityProjectionReader,
} from "../src/modules/activity/activity-projection.reader.js";
import {
  ACTIVITY_PAGE_LIMIT_MAX,
  ActivityAuthorizationError,
  ActivityQueryService,
  ActivityQueryValidationError,
  type ActivityFeedCommand,
} from "../src/modules/activity/activity-query.service.js";
import type {
  AuthorizedProjectScope,
  ProjectAccessQueryPort,
} from "../src/modules/projects/project-access.port.js";
import type { TransactionContext } from "../src/database/transaction-context.js";

class FakeProjectAccess implements ProjectAccessQueryPort {
  scope: AuthorizedProjectScope;
  /** 配置后模拟端口返回了别人的范围，用于覆盖操作者一致性校验。 */
  readonly scopeActorUserId?: number | undefined;

  constructor(scope: AuthorizedProjectScope, scopeActorUserId?: number) {
    this.scope = scope;
    this.scopeActorUserId = scopeActorUserId;
  }

  getAuthorizedSearchScope(
    actorUserId: number,
  ): Promise<AuthorizedProjectScope> {
    // 真实适配器总是按请求者返回范围，因此默认回显请求者。
    return Promise.resolve({
      ...this.scope,
      actorUserId: this.scopeActorUserId ?? actorUserId,
    });
  }

  checkProjectForWrite(
    _tx: TransactionContext,
    _input: { readonly actorUserId: number; readonly projectId: number },
  ): Promise<never> {
    throw new Error("checkProjectForWrite is not used by activity queries");
  }
}

class FakeReader implements ActivityProjectionReader {
  readonly reads: ActivityProjectionReadInput[] = [];
  readonly dayTotalReads: ActivityProjectionDayTotalsInput[] = [];
  items: readonly ActivityProjectionItem[] = [];
  last: ActivityProjectionPage["last"] = null;
  dayTotals: readonly ActivityDayTotal[] = [];

  read(input: ActivityProjectionReadInput): Promise<ActivityProjectionPage> {
    this.reads.push(input);
    return Promise.resolve({ items: this.items, last: this.last });
  }

  readDayTotals(
    input: ActivityProjectionDayTotalsInput,
  ): Promise<readonly ActivityDayTotal[]> {
    this.dayTotalReads.push(input);
    return Promise.resolve(this.dayTotals);
  }
}

function createCursorService(): TimeCursorService {
  return new TimeCursorService(
    VersionedHmacKeyring.fromEntries([{ version: 1, key: randomBytes(32) }], 1),
    "ACTIVITY",
  );
}

function createService(
  options: {
    readonly projectIds?: readonly number[];
    readonly isSystemAdmin?: boolean;
    readonly actorUserId?: number;
    readonly scopeActorUserId?: number;
  } = {},
): {
  readonly service: ActivityQueryService;
  readonly reader: FakeReader;
  readonly projectAccess: FakeProjectAccess;
} {
  const reader = new FakeReader();
  const projectAccess = new FakeProjectAccess(
    {
      actorUserId: options.actorUserId ?? 7,
      projectIds: options.projectIds ?? [1, 2],
      isSystemAdmin: options.isSystemAdmin ?? false,
    },
    options.scopeActorUserId,
  );
  const service = new ActivityQueryService(
    projectAccess,
    reader,
    createCursorService(),
  );
  return { service, reader, projectAccess };
}

function projectionItem(id: number, projectId: number): ActivityProjectionItem {
  return {
    id: String(id),
    projectId,
    sourceEntityType: "TASK",
    sourceEntityId: id,
    activityType: "TASK_COMPLETED",
    actorId: 7,
    actorName: "成员",
    summary: `动态 ${String(id)}`,
    occurredAt: "2026-09-08T00:00:01.000Z",
  };
}

/** 让读取结果带上「还有下一页」的游标锚点。 */
function withNextPage(
  reader: FakeReader,
  items: readonly ActivityProjectionItem[],
): void {
  reader.items = items;
  const last = items.at(-1);
  reader.last =
    last === undefined ? null : { at: last.occurredAt, id: last.id };
}

describe("ActivityQueryService 聚合动态（单元）", () => {
  test("聚合动态在实时授权范围为空时短路，不发起读取", async () => {
    const { service, reader } = createService({ projectIds: [] });
    const page = await service.listFeed({ actorUserId: 7, limit: 20 });

    expect(page).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
      dayTotals: [],
      dayTotalsTruncated: false,
    });
    expect(reader.reads).toHaveLength(0);
    expect(reader.dayTotalReads).toHaveLength(0);
  });

  test("聚合动态把 ADMIN_ONLY 限制在本人活跃项目内", async () => {
    const { service, reader } = createService({
      projectIds: [1, 2],
      isSystemAdmin: true,
    });
    await service.listFeed({
      actorUserId: 7,
      includeAdminOnly: true,
      limit: 20,
    });

    // 读取范围就是实时授权范围，ADMIN_ONLY 只对系统管理员开放。
    expect(reader.reads[0]!.projectIds).toEqual([1, 2]);
    expect(reader.reads[0]!.adminOnlyProjectIds).toEqual([1, 2]);
    expect(reader.dayTotalReads[0]!.projectIds).toEqual([1, 2]);
    expect(reader.dayTotalReads[0]!.adminOnlyProjectIds).toEqual([1, 2]);
  });

  test("非管理员聚合动态不开放任何 ADMIN_ONLY 项目", async () => {
    const { service, reader } = createService({ projectIds: [5, 6] });
    await service.listFeed({ actorUserId: 7, limit: 20 });

    expect(reader.reads[0]!.projectIds).toEqual([5, 6]);
    expect(reader.reads[0]!.adminOnlyProjectIds).toEqual([]);
  });

  test("projectIds 只收窄且静默排除越权与未知项目", async () => {
    const { service, reader } = createService({ projectIds: [1] });
    await service.listFeed({
      actorUserId: 7,
      projectIds: [3, 2, 1],
      limit: 20,
    });

    expect(reader.reads[0]!.projectIds).toEqual([1]);
  });

  test("projectIds 全部越权时返回空页并不发起读取", async () => {
    const { service, reader } = createService({ projectIds: [1] });
    const page = await service.listFeed({
      actorUserId: 7,
      projectIds: [9, 10],
      limit: 20,
    });

    expect(page.items).toEqual([]);
    expect(page.dayTotals).toEqual([]);
    expect(reader.reads).toHaveLength(0);
  });

  test("projectIds 非法取值抛出 invalid-project-ids", async () => {
    const { service } = createService();
    const invalid: readonly (readonly number[])[] = [
      [],
      [0],
      [-1],
      [1, 1],
      Array.from({ length: 101 }, (_, index) => index + 1),
    ];
    for (const projectIds of invalid) {
      await expect(
        service.listFeed({ actorUserId: 7, projectIds, limit: 20 }),
      ).rejects.toMatchObject({
        name: "ActivityQueryValidationError",
        status: "invalid-project-ids",
      });
    }
  });

  test("非法 category 与 limit 被拒绝，limit 超上限时按上限截断", async () => {
    const { service, reader } = createService();
    const bogusCategory = "bogus" as unknown as NonNullable<
      ActivityFeedCommand["category"]
    >;
    await expect(
      service.listFeed({ actorUserId: 7, category: bogusCategory }),
    ).rejects.toBeInstanceOf(ActivityQueryValidationError);
    await expect(
      service.listFeed({ actorUserId: 7, limit: 0 }),
    ).rejects.toMatchObject({ status: "invalid-limit" });

    await service.listFeed({ actorUserId: 7, limit: 999 });
    expect(reader.reads[0]!.limit).toBe(ACTIVITY_PAGE_LIMIT_MAX);
  });

  test("dayTotals 为过滤条件下的全量并按上限截断", async () => {
    const { service, reader } = createService();
    reader.dayTotals = Array.from({ length: 401 }, (_, index) => ({
      // 日期倒序：截断保留最近的 400 个自然日。
      day: `2026-01-${String(400 - index).padStart(3, "0")}`,
      count: 1,
    }));
    const page = await service.listFeed({ actorUserId: 7, limit: 1 });

    expect(page.dayTotals).toHaveLength(400);
    expect(page.dayTotalsTruncated).toBe(true);
    // 多取一行用于判断截断。
    expect(reader.dayTotalReads[0]!.limit).toBe(401);

    reader.dayTotals = reader.dayTotals.slice(0, 400);
    const exact = await service.listFeed({ actorUserId: 7, limit: 1 });
    expect(exact.dayTotals).toHaveLength(400);
    expect(exact.dayTotalsTruncated).toBe(false);
  });

  test("授权范围的操作者与请求者不一致时拒绝", async () => {
    const { service } = createService({
      actorUserId: 7,
      scopeActorUserId: 999,
    });
    await expect(
      service.listFeed({ actorUserId: 7, limit: 20 }),
    ).rejects.toBeInstanceOf(ActivityAuthorizationError);
    await expect(
      service.query({ actorUserId: 7, projectId: 1, limit: 20 }),
    ).rejects.toBeInstanceOf(ActivityAuthorizationError);
  });

  test("非管理员传 includeAdminOnly 不改变游标指纹", async () => {
    const { service, reader } = createService({ isSystemAdmin: false });
    withNextPage(reader, [projectionItem(100, 1)]);
    const first = await service.listFeed({
      actorUserId: 7,
      includeAdminOnly: true,
      limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    expect(reader.reads[0]!.adminOnlyProjectIds).toEqual([]);

    // 非管理员的 includeAdminOnly 会被折叠为 false，因此游标仍可复用。
    const second = await service.listFeed({
      actorUserId: 7,
      limit: 1,
      ...(first.nextCursor === null ? {} : { after: first.nextCursor }),
    });
    expect(second.items).toHaveLength(1);
  });

  test("管理员切换 includeAdminOnly 后旧游标失效", async () => {
    const { service, reader } = createService({ isSystemAdmin: true });
    withNextPage(reader, [projectionItem(100, 1)]);
    const first = await service.listFeed({
      actorUserId: 7,
      includeAdminOnly: true,
      limit: 1,
    });

    await expect(
      service.listFeed({
        actorUserId: 7,
        includeAdminOnly: false,
        limit: 1,
        ...(first.nextCursor === null ? {} : { after: first.nextCursor }),
      }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });
  });

  test("收窄或更换分类后旧游标失效，伪造游标被拒绝", async () => {
    const { service, reader } = createService();
    withNextPage(reader, [projectionItem(100, 1)]);
    const first = await service.listFeed({ actorUserId: 7, limit: 1 });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();

    await expect(
      service.listFeed({
        actorUserId: 7,
        projectIds: [1],
        limit: 1,
        after: cursor!,
      }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });
    await expect(
      service.listFeed({
        actorUserId: 7,
        category: "task",
        limit: 1,
        after: cursor!,
      }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });
    await expect(
      service.listFeed({ actorUserId: 8, limit: 1, after: cursor! }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });
    await expect(
      service.listFeed({ actorUserId: 7, limit: 1, after: "not-a-cursor" }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });
  });

  test("聚合游标不能用于单项目路由，反之亦然", async () => {
    const { service, reader } = createService();
    withNextPage(reader, [projectionItem(100, 1)]);
    const feedCursor = (await service.listFeed({ actorUserId: 7, limit: 1 }))
      .nextCursor;
    expect(feedCursor).not.toBeNull();

    await expect(
      service.query({
        actorUserId: 7,
        projectId: 1,
        limit: 1,
        after: feedCursor!,
      }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });

    const projectCursor = (
      await service.query({ actorUserId: 7, projectId: 1, limit: 1 })
    ).nextCursor;
    expect(projectCursor).not.toBeNull();
    await expect(
      service.listFeed({ actorUserId: 7, limit: 1, after: projectCursor! }),
    ).rejects.toMatchObject({ status: "invalid-cursor" });
  });

  test("单项目路由同样返回同口径按日全量", async () => {
    const { service, reader } = createService({ projectIds: [1] });
    reader.dayTotals = [{ day: "2026-09-08", count: 3 }];
    const page = await service.query({
      actorUserId: 7,
      projectId: 1,
      limit: 1,
    });

    expect(page.dayTotals).toEqual([{ day: "2026-09-08", count: 3 }]);
    expect(page.dayTotalsTruncated).toBe(false);
    expect(reader.dayTotalReads[0]!.projectIds).toEqual([1]);
  });
});
