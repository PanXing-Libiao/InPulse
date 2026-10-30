import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../src/migrate.js";
import {
  connect,
  createProject,
  createTask,
  expectPostgresError,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./helpers.js";

/**
 * SEC-004 / ADR-022：ExternalLinks 的数据库最终防线。
 * 规范化 URL 的格式约束、同项目唯一去重、类型化关联的复合外键都必须由数据库
 * 保证，而不是只靠应用层校验。这里直接验证约束与并发去重。
 */
describe("ExternalLinks invariants", () => {
  let urls: TestUrls;
  let runtime: Sql;
  let member: ProjectFixture;
  let other: ProjectFixture;
  let taskId: number;
  let otherTaskId: number;
  let recordId: number;
  let otherRecordId: number;

  beforeAll(async () => {
    urls = testUrls();
    runtime = connect(urls.runtime, 10);
    await migrate(urls.migrator);
    member = await createProject(runtime);
    other = await createProject(runtime);
    taskId = await createTask(runtime, member, 1);
    otherTaskId = await createTask(runtime, other, 1);
    recordId = await createChangeRecord(runtime, member, 1);
    otherRecordId = await createChangeRecord(runtime, other, 1);
  });

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
  });

  function uniqueUrl(prefix: string): string {
    return `https://github.com/inpulse/${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  async function insertLink(
    projectId: number,
    createdBy: number,
    normalizedUrl: string,
    overrides: { readonly displayUrl?: string; readonly kind?: string } = {},
  ): Promise<number> {
    const [row] = await runtime<Array<{ id: number }>>`
      INSERT INTO app.external_links (
        project_id,
        display_url,
        normalized_url,
        provider,
        kind,
        created_by
      )
      VALUES (
        ${projectId},
        ${overrides.displayUrl ?? normalizedUrl},
        ${normalizedUrl},
        'GITHUB',
        ${overrides.kind ?? "OTHER"},
        ${createdBy}
      )
      RETURNING id
    `;
    if (!row) {
      throw new Error("external_links insert returned no row");
    }
    return row.id;
  }

  async function createChangeRecord(
    sql: Sql,
    fixture: ProjectFixture,
    ordinal: number,
  ): Promise<number> {
    const [row] = await sql<Array<{ id: number }>>`
      INSERT INTO app.change_records (
        project_id,
        module_id,
        title,
        handler_id,
        author_id
      )
      VALUES (
        ${fixture.projectId},
        ${fixture.moduleId},
        ${`变更记录 ${ordinal}`},
        ${fixture.userId},
        ${fixture.userId}
      )
      RETURNING id
    `;
    if (!row) {
      throw new Error("Change-record fixture insert returned no row");
    }
    return row.id;
  }

  test("同一项目内规范化 URL 唯一，重复写入返回 23505", async () => {
    const url = uniqueUrl("dup");
    await insertLink(member.projectId, member.userId, url);

    await expectPostgresError(
      insertLink(member.projectId, member.userId, url),
      "23505",
    );
  });

  test("并发写入同一规范化 URL 只产生一条链接", async () => {
    const url = uniqueUrl("race");
    const results = await Promise.allSettled([
      insertLink(member.projectId, member.userId, url),
      insertLink(member.projectId, member.userId, url),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    ).length;
    expect(fulfilled).toBe(1);

    const rows = await runtime<Array<{ count: string }>>`
      SELECT count(*)::text AS count
        FROM app.external_links
       WHERE project_id = ${member.projectId}
         AND normalized_url = ${url}
    `;
    expect(rows[0]?.count).toBe("1");
  });

  test("非 https 或畸形 GitHub URL 被 CHECK 约束拒绝", async () => {
    await expectPostgresError(
      insertLink(
        member.projectId,
        member.userId,
        "http://github.com/inpulse/core",
      ),
      "23514",
    );
    await expectPostgresError(
      insertLink(
        member.projectId,
        member.userId,
        "https://github.com.evil.example/inpulse/core",
      ),
      "23514",
    );
    await expectPostgresError(
      insertLink(
        member.projectId,
        member.userId,
        `${uniqueUrl("fragment")}#readme`,
      ),
      "23514",
    );
  });

  test("类型化关联拒绝跨项目串联", async () => {
    const url = uniqueUrl("cross");
    const linkId = await insertLink(member.projectId, member.userId, url);

    await expectPostgresError(
      runtime`
        INSERT INTO app.task_external_links (project_id, task_id, link_id)
        VALUES (${other.projectId}, ${otherTaskId}, ${linkId})
      `,
      "23503",
    );
  });

  test("同一链接不能以其他项目归属关联到任务", async () => {
    const url = uniqueUrl("mismatch");
    const linkId = await insertLink(member.projectId, member.userId, url);

    await expectPostgresError(
      runtime`
        INSERT INTO app.task_external_links (project_id, task_id, link_id)
        VALUES (${other.projectId}, ${taskId}, ${linkId})
      `,
      "23503",
    );
  });

  test("同一任务重复关联同一链接返回 23505", async () => {
    const url = uniqueUrl("assoc");
    const linkId = await insertLink(member.projectId, member.userId, url);
    await runtime`
      INSERT INTO app.task_external_links (project_id, task_id, link_id)
      VALUES (${member.projectId}, ${taskId}, ${linkId})
    `;

    await expectPostgresError(
      runtime`
        INSERT INTO app.task_external_links (project_id, task_id, link_id)
        VALUES (${member.projectId}, ${taskId}, ${linkId})
      `,
      "23505",
    );
  });

  test("记录级关联拒绝跨项目串联与归属错配", async () => {
    const url = uniqueUrl("record");
    const linkId = await insertLink(member.projectId, member.userId, url);
    await runtime`
      INSERT INTO app.change_record_external_links (
        project_id,
        change_record_id,
        link_id
      )
      VALUES (${member.projectId}, ${recordId}, ${linkId})
    `;

    await expectPostgresError(
      runtime`
        INSERT INTO app.change_record_external_links (
          project_id,
          change_record_id,
          link_id
        )
        VALUES (${other.projectId}, ${otherRecordId}, ${linkId})
      `,
      "23503",
    );

    const otherUrl = uniqueUrl("record-other");
    const otherLinkId = await insertLink(
      other.projectId,
      other.userId,
      otherUrl,
    );

    await expectPostgresError(
      runtime`
        INSERT INTO app.change_record_external_links (
          project_id,
          change_record_id,
          link_id
        )
        VALUES (${member.projectId}, ${recordId}, ${otherLinkId})
      `,
      "23503",
    );
    await expectPostgresError(
      runtime`
        INSERT INTO app.change_record_external_links (
          project_id,
          change_record_id,
          link_id
        )
        VALUES (${other.projectId}, ${recordId}, ${otherLinkId})
      `,
      "23503",
    );
  });

  test("同一记录重复关联同一链接返回 23505", async () => {
    const url = uniqueUrl("record-dup");
    const linkId = await insertLink(member.projectId, member.userId, url);
    await runtime`
      INSERT INTO app.change_record_external_links (
        project_id,
        change_record_id,
        link_id
      )
      VALUES (${member.projectId}, ${recordId}, ${linkId})
    `;

    await expectPostgresError(
      runtime`
        INSERT INTO app.change_record_external_links (
          project_id,
          change_record_id,
          link_id
        )
        VALUES (${member.projectId}, ${recordId}, ${linkId})
      `,
      "23505",
    );
  });

  test("项目级关联拒绝其他项目的链接", async () => {
    const url = uniqueUrl("project");
    const linkId = await insertLink(member.projectId, member.userId, url);
    await runtime`
      INSERT INTO app.project_external_links (project_id, link_id)
      VALUES (${member.projectId}, ${linkId})
    `;

    const otherUrl = uniqueUrl("project-other");
    const otherLinkId = await insertLink(
      other.projectId,
      other.userId,
      otherUrl,
    );

    await expectPostgresError(
      runtime`
        INSERT INTO app.project_external_links (project_id, link_id)
        VALUES (${member.projectId}, ${otherLinkId})
      `,
      "23503",
    );
    await expectPostgresError(
      runtime`
        INSERT INTO app.project_external_links (project_id, link_id)
        VALUES (${other.projectId}, ${linkId})
      `,
      "23503",
    );
  });

  test("同一项目重复关联同一链接返回 23505", async () => {
    const url = uniqueUrl("project-dup");
    const linkId = await insertLink(member.projectId, member.userId, url);
    await runtime`
      INSERT INTO app.project_external_links (project_id, link_id)
      VALUES (${member.projectId}, ${linkId})
    `;

    await expectPostgresError(
      runtime`
        INSERT INTO app.project_external_links (project_id, link_id)
        VALUES (${member.projectId}, ${linkId})
      `,
      "23505",
    );
  });

  test("链接实体列不可变", async () => {
    const url = uniqueUrl("immutable");
    const linkId = await insertLink(member.projectId, member.userId, url);

    await expectPostgresError(
      runtime`
        UPDATE app.external_links
           SET normalized_url = ${uniqueUrl("mutated")}
         WHERE id = ${linkId}
      `,
      "23514",
    );
  });
});
