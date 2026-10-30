import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { expect } from "vitest";

export interface TestUrls {
  readonly archive: string;
  readonly auditReader: string;
  readonly backup: string;
  readonly bootstrap: string;
  readonly migrator: string;
  readonly runtime: string;
}

export interface ProjectFixture {
  readonly code: string;
  readonly moduleId: number;
  readonly projectId: number;
  readonly userId: number;
}

let fixtureCounter = 0;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Set ${name}; database integration tests never silently skip`,
    );
  }
  return value;
}

function roleUrl(baseUrl: string, role: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

export function testUrls(): TestUrls {
  const baseUrl = required("TEST_DATABASE_URL");
  return {
    archive:
      process.env.TEST_AUDIT_ARCHIVE_DATABASE_URL?.trim() ||
      roleUrl(baseUrl, "audit_archive_writer"),
    auditReader:
      process.env.TEST_AUDIT_READER_DATABASE_URL?.trim() ||
      roleUrl(baseUrl, "audit_reader"),
    backup:
      process.env.TEST_BACKUP_DATABASE_URL?.trim() ||
      roleUrl(baseUrl, "app_backup"),
    bootstrap:
      process.env.TEST_BOOTSTRAP_DATABASE_URL?.trim() ||
      roleUrl(baseUrl, "cluster_bootstrap"),
    migrator:
      process.env.TEST_MIGRATOR_DATABASE_URL?.trim() ||
      roleUrl(baseUrl, "app_migrator"),
    runtime:
      process.env.TEST_RUNTIME_DATABASE_URL?.trim() ||
      roleUrl(baseUrl, "app_runtime"),
  };
}

export function connect(url: string, max = 10): Sql {
  return postgres(url, {
    connection: { application_name: "inpulse-database-test" },
    max,
    onnotice: () => undefined,
    prepare: false,
  });
}

function nextToken(prefix: string): string {
  fixtureCounter += 1;
  const randomSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return `${prefix}${Date.now().toString(36)}${fixtureCounter.toString(36)}${randomSuffix}`;
}

export async function createUser(sql: Sql): Promise<number> {
  const loginName = nextToken("user_").toLowerCase();
  const [row] = await sql<Array<{ id: number }>>`
    INSERT INTO app.users (login_name, name, password_hash)
    VALUES (
      ${loginName},
      ${`Test ${loginName}`},
      ${"$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture-hash"}
    )
    RETURNING id
  `;
  if (!row) {
    throw new Error("User fixture insert returned no row");
  }
  return row.id;
}

export async function createProject(
  sql: Sql,
  userId?: number,
): Promise<ProjectFixture> {
  const ownerId = userId ?? (await createUser(sql));
  const code = nextToken("P").toUpperCase().slice(0, 24);

  return sql.begin(async (transaction) => {
    const [project] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.projects (code, name, created_by)
      VALUES (${code}, ${`Project ${code}`}, ${ownerId})
      RETURNING id
    `;
    if (!project) {
      throw new Error("Project fixture insert returned no row");
    }

    await transaction`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${project.id}, ${ownerId}, 'LEADER')
    `;
    const [module] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.modules (
        project_id,
        name,
        kind,
        created_by
      )
      VALUES (
        ${project.id},
        '未分类',
        'UNCLASSIFIED',
        ${ownerId}
      )
      RETURNING id
    `;
    if (!module) {
      throw new Error("Module fixture insert returned no row");
    }

    return {
      code,
      moduleId: module.id,
      projectId: project.id,
      userId: ownerId,
    };
  });
}

export async function createTask(
  sql: Sql,
  fixture: ProjectFixture,
  ordinal: number,
): Promise<number> {
  return sql.begin(async (transaction) => {
    const [task] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.tasks (
        project_id,
        module_id,
        code,
        title,
        creator_id
      )
      VALUES (
        ${fixture.projectId},
        ${fixture.moduleId},
        ${`${fixture.code}-T-${ordinal}`},
        ${`Task ${ordinal}`},
        ${fixture.userId}
      )
      RETURNING id
    `;
    if (!task) {
      throw new Error("Task fixture insert returned no row");
    }
    // ADR-040：负责人集合的唯一真相是 app.task_assignees，tasks.assignee_id 已在
    // 0021_contract_task_assignees.sql 删除，因此负责人行与任务写在同一事务里。
    await transaction`
      INSERT INTO app.task_assignees (task_id, user_id, project_id)
      VALUES (${task.id}, ${fixture.userId}, ${fixture.projectId})
    `;
    await transaction`
      INSERT INTO app.task_status_history (
        task_id,
        project_id,
        from_work_status,
        to_work_status,
        changed_by
      )
      VALUES (
        ${task.id},
        ${fixture.projectId},
        NULL,
        'TODO',
        ${fixture.userId}
      )
    `;
    return task.id;
  });
}

export async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected PostgreSQL error ${code}, but operation succeeded`);
}
