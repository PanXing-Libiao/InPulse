import type { Sql } from "postgres";
import type { ProjectKey } from "../../../database/poc/search/golden-queries.ts";
import { goldenQueries } from "../../../database/poc/search/golden-queries.ts";
import { buildSearchSeed } from "../../../database/poc/search/seed.ts";
import { migrate } from "../../../database/src/migrate.ts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { VersionedHmacKeyring } from "../src/auth/keyring";
import type {
  AuthorizedProjectScope,
  ProjectAccessQueryPort,
  ProjectWriteCheckResult,
} from "../src/modules/projects/project-access.port";
import type { TransactionContext } from "../src/database/transaction-context.js";
import { SearchCursorService } from "../src/modules/search/search-cursor";
import { PostgresSearchProjectionReader } from "../src/modules/search/search-projection.reader";
import {
  SearchQueryService,
  SearchQueryValidationError,
} from "../src/modules/search/search-query.service";
import { normalizeSearchText } from "../src/modules/search/search-text";
import {
  connect,
  createProject,
  createUser,
  removeMember,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./database.helpers";

class FixtureScopedProjectAccessQueryPort implements ProjectAccessQueryPort {
  readonly #sql: Sql;
  readonly #fixtureProjectIds: ReadonlySet<number>;

  constructor(sql: Sql, fixtureProjectIds: ReadonlySet<number>) {
    this.#sql = sql;
    this.#fixtureProjectIds = fixtureProjectIds;
  }

  async getAuthorizedSearchScope(
    actorUserId: number,
  ): Promise<AuthorizedProjectScope> {
    const [user] = await this.#sql<
      Array<{
        readonly is_admin: boolean;
        readonly status: string;
      }>
    >`
      SELECT is_admin, status
        FROM app.users
       WHERE id = ${actorUserId}
    `;
    if (!user || user.status !== "ACTIVE") {
      return {
        actorUserId,
        projectIds: [],
        isSystemAdmin: false,
      };
    }

    if (user.is_admin) {
      return {
        actorUserId,
        projectIds: [...this.#fixtureProjectIds].sort(
          (left, right) => left - right,
        ),
        isSystemAdmin: true,
      };
    }

    const memberships = await this.#sql<
      Array<{
        readonly project_id: number;
      }>
    >`
      SELECT DISTINCT project_id
        FROM app.project_members
       WHERE user_id = ${actorUserId}
         AND status = 'ACTIVE'
       ORDER BY project_id ASC
    `;
    return {
      actorUserId,
      projectIds: memberships.map((membership) => membership.project_id),
      isSystemAdmin: false,
    };
  }

  async checkProjectForWrite(
    _tx: TransactionContext,
    _input: { readonly actorUserId: number; readonly projectId: number },
  ): Promise<ProjectWriteCheckResult> {
    throw new Error(
      "FixtureScopedProjectAccessQueryPort does not support write checks",
    );
  }
}

function expectedProjectId(
  key: ProjectKey,
  projectIds: ReadonlyMap<ProjectKey, number>,
): number {
  const value = projectIds.get(key);
  if (value === undefined) {
    throw new Error(`Missing project fixture for ${key}`);
  }
  return value;
}

describe("SearchQueryService with real PostgreSQL", () => {
  let urls: TestUrls;
  let runtime: Sql;
  let bootstrap: Sql;
  let projectIds: Map<ProjectKey, number>;
  let projectFixtures: Map<ProjectKey, ProjectFixture>;
  let memberA: number;
  let removedUser: number;
  let disabledUser: number;
  let adminUserId: number;
  let seedOffset: number;
  let adminOnlyEntityId: number;
  let hiddenEntityId: number;
  let navTaskEntityId: number;
  let service: SearchQueryService;

  beforeAll(async () => {
    urls = testUrls();
    runtime = connect(urls.runtime, 20);
    bootstrap = connect(urls.bootstrap, 2);
    await migrate(urls.migrator);

    memberA = await createUser(runtime);
    const memberB = await createUser(runtime);
    adminUserId = await createUser(runtime, { admin: true });
    removedUser = await createUser(runtime);
    disabledUser = await createUser(runtime, { disabled: true });

    const p1 = await createProject(runtime, memberA);
    const p2 = await createProject(runtime, memberB);
    const p3 = await createProject(runtime, memberB);
    const p4 = await createProject(runtime, memberB);
    const p5 = await createProject(runtime, memberB);
    const p6 = await createProject(runtime, memberB);

    projectFixtures = new Map<ProjectKey, ProjectFixture>([
      ["p1", p1],
      ["p2", p2],
      ["p3", p3],
      ["p4", p4],
      ["p5", p5],
      ["p6", p6],
    ]);
    projectIds = new Map<ProjectKey, number>(
      [...projectFixtures].map(([key, fixture]) => [key, fixture.projectId]),
    );

    await runtime`
      INSERT INTO app.project_members (project_id, user_id)
      VALUES (${p1.projectId}, ${removedUser})
    `;
    await removeMember(runtime, p1.projectId, removedUser);

    const seed = buildSearchSeed();
    expect(seed.rows.length).toBeGreaterThanOrEqual(1_000);
    seedOffset = 500_000_000 + (Date.now() % 500_000_000);
    adminOnlyEntityId = seedOffset + 2_000_000;
    hiddenEntityId = seedOffset + 2_000_001;

    await runtime.begin(async (transaction) => {
      for (const row of seed.rows) {
        const projectId = expectedProjectId(row.projectKey, projectIds);
        await transaction`
          INSERT INTO app.search_projection (
            project_id,
            entity_type,
            entity_id,
            title,
            summary,
            raw_text,
            normalized_search_text,
            visibility_scope,
            source_status,
            source_row_version
          )
          VALUES (
            ${projectId},
            ${row.entityType},
            ${seedOffset + row.entityId},
            ${row.title},
            ${row.summary},
            ${row.rawText},
            ${row.normalizedSearchText},
            'MEMBER',
            'ACTIVE',
            1
          )
        `;
      }

      await transaction`
        INSERT INTO app.search_projection (
          project_id,
          entity_type,
          entity_id,
          title,
          summary,
          raw_text,
          normalized_search_text,
          visibility_scope,
          source_status,
          source_row_version
        )
        VALUES (
          ${projectIds.get("p1") as number},
          'CHANGE_RECORD',
          ${adminOnlyEntityId},
          '管理员归档搜索',
          '仅管理员显式 VOID 搜索可见',
          '登录归档，管理员可见',
          '登录归档 管理员可见',
          'ADMIN_ONLY',
          'VOID',
          1
        )
      `;
      await transaction`
        INSERT INTO app.search_projection (
          project_id,
          entity_type,
          entity_id,
          title,
          summary,
          raw_text,
          normalized_search_text,
          visibility_scope,
          source_status,
          source_row_version
        )
        VALUES (
          ${projectIds.get("p1") as number},
          'TASK',
          ${hiddenEntityId},
          '隐藏搜索记录',
          'HIDDEN 投影',
          '登录隐藏，任何人不可见',
          '登录隐藏 任何人不可见',
          'HIDDEN',
          'VOID',
          1
        )
      `;

      const navTaskEntityIdValue = seedOffset + 2_000_002;
      navTaskEntityId = navTaskEntityIdValue;
      await transaction`
        INSERT INTO app.search_projection (
          project_id,
          entity_type,
          entity_id,
          module_id,
          title,
          summary,
          raw_text,
          normalized_search_text,
          visibility_scope,
          source_status,
          source_row_version
        )
        VALUES (
          ${p1.projectId},
          'TASK',
          ${navTaskEntityIdValue},
          ${p1.moduleId},
          'zznavparentprobe 任务',
          '导航父级探针',
          'zznavparentprobe。导航父级探针',
          'zznavparentprobe.导航父级探针',
          'MEMBER',
          'ACTIVE',
          1
        )
      `;
    });

    const port = new FixtureScopedProjectAccessQueryPort(
      runtime,
      new Set(projectIds.values()),
    );
    const cursor = new SearchCursorService(
      VersionedHmacKeyring.fromEntries(
        [{ version: 1, key: Buffer.alloc(32, 0x5a) }],
        1,
      ),
    );
    service = new SearchQueryService(
      port,
      new PostgresSearchProjectionReader(runtime),
      cursor,
    );
  });

  afterAll(async () => {
    await Promise.all([
      runtime.end({ timeout: 5 }),
      bootstrap.end({ timeout: 5 }),
    ]);
  });

  test("active member only searches their own project", async () => {
    const result = await service.search({
      actorUserId: memberA,
      query: "登录",
      limit: 50,
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(
      result.items.every((item) => item.projectId === projectIds.get("p1")),
    ).toBe(true);
    expect(
      result.items.some((item) => item.entityId === adminOnlyEntityId),
    ).toBe(false);
    expect(result.items.some((item) => item.entityId === hiddenEntityId)).toBe(
      false,
    );
  });

  test("cross-project query does not return the target project", async () => {
    const result = await service.search({
      actorUserId: memberA,
      query: "API-V1-SEARCH",
      limit: 20,
    });

    expect(result.items).toEqual([]);
  });

  test("results keep the parent ids needed to open their own page", async () => {
    const result = await service.search({
      actorUserId: memberA,
      query: "zznavparentprobe",
      limit: 20,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      projectId: projectIds.get("p1"),
      entityType: "TASK",
      entityId: navTaskEntityId,
      moduleId: projectFixtures.get("p1")?.moduleId,
      recordId: null,
    });
  });

  test("removed and disabled users fail closed", async () => {
    const removed = await service.search({
      actorUserId: removedUser,
      query: "登录",
      limit: 20,
    });
    const disabled = await service.search({
      actorUserId: disabledUser,
      query: "登录",
      limit: 20,
    });

    expect(removed.items).toEqual([]);
    expect(disabled.items).toEqual([]);
  });

  test("system admin excludes ADMIN_ONLY by default and includes it on explicit VOID filter", async () => {
    const defaultResult = await service.search({
      actorUserId: adminUserId,
      query: "登录",
      limit: 50,
    });
    const voidResult = await service.search({
      actorUserId: adminUserId,
      query: "登录",
      includeVoid: true,
      limit: 50,
    });

    expect(
      defaultResult.items.some((item) => item.entityId === adminOnlyEntityId),
    ).toBe(false);
    expect(
      voidResult.items.some((item) => item.entityId === adminOnlyEntityId),
    ).toBe(true);
    expect(
      voidResult.items.some((item) => item.entityId === hiddenEntityId),
    ).toBe(false);
  });

  test("pagination returns disjoint ordered pages", async () => {
    const first = await service.search({
      actorUserId: memberA,
      query: "登录",
      limit: 2,
    });
    const after = first.nextCursor;
    const second = await service.search({
      actorUserId: memberA,
      query: "登录",
      limit: 2,
      ...(after === null ? {} : { after }),
    });

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first.hasMore).toBe(first.nextCursor !== null);
    expect(second.items).toHaveLength(2);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.hasMore).toBe(second.nextCursor !== null);
  });

  test("cursor pagination orders numeric ids across digit widths", async () => {
    const query = "cursorregression20261023";
    const projectId = projectIds.get("p1") as number;
    const base = 10n ** 15n - 5n;
    const expectedIds = Array.from(
      { length: 25 },
      (_, index) => base + BigInt(index),
    );
    await runtime.begin(async (transaction) => {
      for (const [index, id] of expectedIds.entries()) {
        const entityId = seedOffset + 4_000_000 + index;
        const title = `游标排序回归 ${String(index + 1).padStart(2, "0")}`;
        await transaction`
          INSERT INTO app.search_projection (
            id, project_id, entity_type, entity_id, title, summary, raw_text,
            normalized_search_text, visibility_scope, source_status, source_row_version
          ) OVERRIDING SYSTEM VALUE
          VALUES (
            ${id.toString()}, ${projectId}, ${"TASK"}, ${entityId}, ${title}, ${"游标排序回归"},
            ${title + " " + query}, ${normalizeSearchText(query)}, ${"MEMBER"},
            ${"ACTIVE"}, 1
          )
        `;
      }
    });
    try {
      const ids: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await service.search({
          actorUserId: memberA,
          query,
          limit: 5,
          ...(after === undefined ? {} : { after }),
        });
        ids.push(...result.items.map((item) => item.id));
        if (!result.hasMore) break;
        after = result.nextCursor ?? undefined;
      }
      expect(ids).toEqual(expectedIds.map((id) => id.toString()));
    } finally {
      await runtime`
        DELETE FROM app.search_projection
         WHERE project_id = ${projectId}
           AND normalized_search_text = ${normalizeSearchText(query)}
      `;
    }
  });

  test("golden query recall at top-20 remains at least 90%", async () => {
    const seed = buildSearchSeed();
    expect(goldenQueries).toHaveLength(200);
    const normalCases = goldenQueries.filter(
      (spec) => spec.policy === "normal",
    );
    expect(normalCases.length).toBeGreaterThanOrEqual(180);
    const expectedIds = new Map(
      [...seed.expectedEntityIdsByGoldenId].map(([id, entityId]) => [
        id,
        seedOffset + entityId,
      ]),
    );

    let hits = 0;
    for (const spec of normalCases) {
      const result = await service.search({
        actorUserId: adminUserId,
        query: spec.query,
        limit: 20,
      });
      const expectedEntityId = expectedIds.get(spec.id);
      const expectedProjectId =
        spec.expectedProjectKey === null
          ? undefined
          : projectIds.get(spec.expectedProjectKey);
      const found =
        expectedEntityId !== undefined &&
        expectedProjectId !== undefined &&
        result.items.some(
          (item) =>
            item.entityId === expectedEntityId &&
            item.projectId === expectedProjectId &&
            item.entityType === spec.expectedEntityType,
        );
      if (found) {
        hits += 1;
      }
    }

    expect(hits / normalCases.length).toBeGreaterThanOrEqual(0.9);
  });

  test("no-result and invalid edge queries stay bounded", async () => {
    const noResultCases = goldenQueries.filter(
      (spec) => spec.policy === "no-result",
    );
    for (const spec of noResultCases) {
      const result = await service.search({
        actorUserId: adminUserId,
        query: spec.query,
        limit: 20,
      });
      expect(result.items).toEqual([]);
    }

    await expect(
      service.search({
        actorUserId: adminUserId,
        query: "",
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(SearchQueryValidationError);
    await expect(
      service.search({
        actorUserId: adminUserId,
        query: "   ",
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(SearchQueryValidationError);
    await expect(
      service.search({
        actorUserId: adminUserId,
        query: "x".repeat(201),
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(SearchQueryValidationError);
    await expect(
      service.search({
        actorUserId: adminUserId,
        query: "登录",
        limit: 0,
      }),
    ).rejects.toBeInstanceOf(SearchQueryValidationError);
    await expect(
      service.search({
        actorUserId: adminUserId,
        query: "登录",
        after: "not-a-cursor",
      }),
    ).rejects.toBeInstanceOf(SearchQueryValidationError);
  });

  test("default query plan uses the PGroonga index", async () => {
    const allProjectIds = [...projectIds.values()];
    const planRows = await runtime.begin(async (transaction) => {
      await transaction.unsafe("SET LOCAL search_path = app, pg_catalog");
      await transaction.unsafe("SET LOCAL enable_seqscan = on");
      return transaction.unsafe<Array<Record<string, string>>>(
        "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) " +
          "WITH candidates AS MATERIALIZED (" +
          "  SELECT id, project_id, entity_type, entity_id, title, summary, " +
          "         visibility_scope " +
          "    FROM app.search_projection " +
          "   WHERE normalized_search_text &@~ " +
          "         app.pgroonga_query_escape($1)" +
          ") " +
          "SELECT id::text, project_id, entity_type, entity_id, title, summary " +
          "  FROM candidates " +
          " WHERE project_id = ANY($2::int[]) " +
          "   AND visibility_scope = ANY($3::text[]) " +
          " ORDER BY id ASC " +
          " LIMIT 21",
        [normalizeSearchText("登录"), allProjectIds, ["MEMBER"]],
      );
    });
    const plan = planRows
      .map((row) => row["QUERY PLAN"] ?? row.query_plan ?? JSON.stringify(row))
      .join("\n");

    expect(plan).toContain("idx_search_projection_pgroonga");
    expect(plan).toMatch(/Index Scan|Bitmap Heap Scan/);
  });
});
