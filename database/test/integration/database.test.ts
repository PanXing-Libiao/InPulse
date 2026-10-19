import { createHmac } from "node:crypto";

import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../src/migrate.js";
import {
  connect,
  createProject,
  createTask,
  createUser,
  expectPostgresError,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./helpers.js";

describe("PostgreSQL schema, invariants, and roles", () => {
  let urls: TestUrls;
  let runtime: Sql;
  let bootstrap: Sql;
  let backup: Sql;
  let auditReader: Sql;
  let archive: Sql;

  beforeAll(() => {
    urls = testUrls();
    runtime = connect(urls.runtime, 20);
    bootstrap = connect(urls.bootstrap, 2);
    backup = connect(urls.backup, 2);
    auditReader = connect(urls.auditReader, 4);
    archive = connect(urls.archive, 2);
  });

  afterAll(async () => {
    await Promise.all([
      runtime.end({ timeout: 5 }),
      bootstrap.end({ timeout: 5 }),
      backup.end({ timeout: 5 }),
      auditReader.end({ timeout: 5 }),
      archive.end({ timeout: 5 }),
    ]);
  });

  test("migrations are immutable and idempotent", async () => {
    const result = await migrate(urls.migrator);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual([
      "0000_initial.sql",
      "0001_invariants_and_permissions.sql",
      "0002_security_hardening.sql",
      "0003_search_pgroonga.sql",
      "0004_search_projection_contract_pg_trgm_index.sql",
      "0005_search_projection_contract_pg_trgm_extension.sql",
      "0006_leftover_search_entity.sql",
      "0007_backup_role_pg_dump_grants.sql",
      "0008_records_cross_project_indexes.sql",
      "0009_tasks_creator_index.sql",
      "0010_project_module_codes.sql",
      "0011_feature_acceptance.sql",
      "0012_project_root_repository.sql",
      "0013_sso_login.sql",
      "0014_sso_backup_grants.sql",
      "0015_project_member_roles.sql",
      "0016_project_archive_requests.sql",
      "0017_project_status_lifecycle.sql",
      "0018_project_archive_backup_grants.sql",
      "0019_drop_project_admin_role.sql",
      "0020_task_assignees.sql",
      "0021_contract_task_assignees.sql",
      "0022_drop_low_priority.sql",
      "0023_project_three_state.sql",
      "0024_module_archive_removal.sql",
      "0025_feature_archive_removal.sql",
      "0026_record_draft_delete.sql",
      "0029_project_leader_invariant.sql",
      "0030_project_soft_delete.sql",
      "0031_project_purge.sql",
      "0032_task_archive_removal.sql",
      "0033_search_navigation_parents.sql",
      "0034_task_soft_delete.sql",
      "0035_search_projection_delete_grant.sql",
      "0036_module_feature_soft_delete.sql",
      "0037_audit_logs_cross_chain_idx.sql",
      "0038_project_delete_contract_soft_delete_removal.sql",
      "0039_document_import_runs.sql",
      "0040_ai_assist_settings.sql",
      "0041_wecom_binding.sql",
      "0042_wecom_robot_config.sql",
      "0043_wecom_robot_profile_url.sql",
      "0044_project_wecom_groups.sql",
      "0045_revoke_bindings_on_robot_change.sql",
      "0046_organizations.sql",
      "0047_user_deletion_tombstone.sql",
      "0048_organizations_backup_sequence_grant.sql",
    ]);
  });

  test("user tombstones are irreversible and schema-enforced", async () => {
    const userId = await createUser(runtime);
    await runtime`
      UPDATE app.users
         SET status = 'DISABLED',
             disabled_at = now(),
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${userId}
    `;
    await runtime`
      UPDATE app.users
         SET login_name = 'deleted-user-' || id::text,
             name = '删除用户',
             email = NULL,
             avatar_url = NULL,
             password_hash = NULL,
             organization_id = NULL,
             is_admin = false,
             status = 'DISABLED',
             disabled_at = COALESCE(disabled_at, now()),
             deleted_at = COALESCE(deleted_at, now()),
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${userId}
         AND deleted_at IS NULL
    `;

    const [tombstone] = (await runtime`
      SELECT login_name AS "loginName",
             name,
             email,
             password_hash IS NULL AS "passwordCleared",
             is_admin AS "isAdmin",
             organization_id AS "organizationId",
             status,
             disabled_at IS NOT NULL AS "disabled",
             deleted_at IS NOT NULL AS "deleted"
        FROM app.users
       WHERE id = ${userId}
    `) as unknown as readonly {
      readonly loginName: string;
      readonly name: string;
      readonly email: string | null;
      readonly passwordCleared: boolean;
      readonly isAdmin: boolean;
      readonly organizationId: number | null;
      readonly status: string;
      readonly disabled: boolean;
      readonly deleted: boolean;
    }[];
    expect(tombstone).toEqual({
      loginName: `deleted-user-${userId}`,
      name: "删除用户",
      email: null,
      passwordCleared: true,
      isAdmin: false,
      organizationId: null,
      status: "DISABLED",
      disabled: true,
      deleted: true,
    });

    await expectPostgresError(
      runtime`
        UPDATE app.users
           SET name = '仍可修改',
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${userId}
      `,
      "23514",
    );
    await expectPostgresError(
      runtime`
        UPDATE app.users
           SET deleted_at = NULL,
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${userId}
      `,
      "23514",
    );
    await expectPostgresError(
      runtime`
        UPDATE app.users
           SET login_name = 'another-name',
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${userId}
      `,
      "23514",
    );

    const [schema] = (await bootstrap`
      SELECT
        EXISTS (
          SELECT 1
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'app'
             AND c.relname = 'users'
             AND a.attname = 'deleted_at'
             AND a.attnum > 0
             AND NOT a.attisdropped
        ) AS "columnExists",
        EXISTS (
          SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = 'app'
             AND t.relname = 'users'
             AND c.conname = 'users_deleted_state_check'
             AND c.contype = 'c'
             AND c.convalidated
        ) AS "constraintValidated",
        EXISTS (
          SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app'
             AND p.proname = 'enforce_users_immutable_columns'
        ) AS "functionExists",
        EXISTS (
          SELECT 1
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'app'
             AND c.relname = 'users'
             AND t.tgname = 'users_immutable_columns'
             AND t.tgfoid = 'app.enforce_users_immutable_columns()'::regprocedure
        ) AS "triggerBound"
    `) as unknown as readonly {
      readonly columnExists: boolean;
      readonly constraintValidated: boolean;
      readonly functionExists: boolean;
      readonly triggerBound: boolean;
    }[];
    expect(schema).toEqual({
      columnExists: true,
      constraintValidated: true,
      functionExists: true,
      triggerBound: true,
    });
  });

  test("project bootstrap requires creator history and allows an empty module list", async () => {
    const userId = await createUser(runtime);
    const invalidCode = `P${Date.now().toString(36)}X`.toUpperCase();

    await expectPostgresError(
      runtime.begin(async (transaction) => {
        await transaction`
          INSERT INTO app.projects (code, name, created_by)
          VALUES (${invalidCode}, 'Incomplete project', ${userId})
        `;
      }),
      "23514",
    );

    const emptyProjectId = await runtime.begin(async (tx) => {
      const [project] = await tx<Array<{ id: number }>>`
        INSERT INTO app.projects (code, name, created_by)
        VALUES (${invalidCode + "E"}, 'Empty project', ${userId}) RETURNING id
      `;
      if (!project) throw new Error("Project insert returned no row");
      await tx`INSERT INTO app.project_members (project_id, user_id, role) VALUES (${project.id}, ${userId}, 'LEADER')`;
      return project.id;
    });
    const [emptyCounts] = await runtime<Array<{ modules: number }>>`
      SELECT count(*)::integer AS modules FROM app.modules WHERE project_id=${emptyProjectId}
    `;
    expect(emptyCounts).toEqual({ modules: 0 });

    const fixture = await createProject(runtime, userId);
    const [counts] = await runtime<Array<{ members: number; modules: number }>>`
      SELECT
        (SELECT count(*)::INTEGER
           FROM app.project_members
          WHERE project_id = ${fixture.projectId}) AS members,
        (SELECT count(*)::INTEGER
           FROM app.modules
          WHERE project_id = ${fixture.projectId}
            AND kind = 'UNCLASSIFIED') AS modules
    `;
    expect(counts).toEqual({ members: 1, modules: 1 });
  });

  test("project with active members keeps exactly one leader", async () => {
    const userId = await createUser(runtime);
    const fixture = await createProject(runtime, userId);
    const secondUserId = await createUser(runtime);

    // 新增成员默认是普通成员：创建者仍是唯一组长，提交不受影响。
    await runtime.begin(async (transaction) => {
      await transaction`
        INSERT INTO app.project_members (project_id, user_id)
        VALUES (${fixture.projectId}, ${secondUserId})
      `;
    });

    // 把唯一组长降级为普通成员 → 延迟约束在提交时报 23514。
    await expectPostgresError(
      runtime.begin(async (transaction) => {
        await transaction`
          UPDATE app.project_members
             SET role = 'MEMBER'
           WHERE project_id = ${fixture.projectId}
             AND user_id = ${userId}
        `;
      }),
      "23514",
    );

    // 移除唯一组长、只留下普通成员同样违反不变量。
    await expectPostgresError(
      runtime.begin(async (transaction) => {
        await transaction`
          UPDATE app.project_members
             SET status = 'REMOVED', removed_at = now(), role = 'MEMBER'
           WHERE project_id = ${fixture.projectId}
             AND user_id = ${userId}
        `;
      }),
      "23514",
    );

    // 先转移组长再移除原组长是合法路径（与服务端 setRole 的降级→提升顺序一致）。
    await runtime.begin(async (transaction) => {
      await transaction`
        UPDATE app.project_members SET role = 'MEMBER'
         WHERE project_id = ${fixture.projectId} AND user_id = ${userId}
      `;
      await transaction`
        UPDATE app.project_members SET role = 'LEADER'
         WHERE project_id = ${fixture.projectId} AND user_id = ${secondUserId}
      `;
    });

    // 零活跃成员的项目保持合法：不变量只约束「有成员时必须有且只有一名组长」。
    await runtime.begin(async (transaction) => {
      await transaction`
        UPDATE app.project_members
           SET status = 'REMOVED', removed_at = now(), role = 'MEMBER'
         WHERE project_id = ${fixture.projectId}
      `;
    });
    const [remaining] = await runtime<Array<{ active: number }>>`
      SELECT count(*)::integer AS active
        FROM app.project_members
       WHERE project_id = ${fixture.projectId}
         AND status = 'ACTIVE'
    `;
    expect(remaining).toEqual({ active: 0 });

    // 全员已移除的项目重新加人时必须直接指定组长，否则提交违反不变量。
    await expectPostgresError(
      runtime.begin(async (transaction) => {
        await transaction`
          INSERT INTO app.project_members (project_id, user_id)
          VALUES (${fixture.projectId}, ${secondUserId})
        `;
      }),
      "23514",
    );
    await runtime.begin(async (transaction) => {
      await transaction`
        INSERT INTO app.project_members (project_id, user_id, role)
        VALUES (${fixture.projectId}, ${secondUserId}, 'LEADER')
      `;
    });
  });

  test("composite foreign keys reject cross-project scope and links", async () => {
    const userId = await createUser(runtime);
    const left = await createProject(runtime, userId);
    const right = await createProject(runtime, userId);

    const [feature] = await runtime<Array<{ id: number }>>`
      INSERT INTO app.features (
        project_id,
        module_id,
        code,
        name,
        created_by
      )
      VALUES (
        ${left.projectId},
        ${left.moduleId},
        ${`${left.code}-F-1`},
        'Left feature',
        ${userId}
      )
      RETURNING id
    `;
    if (!feature) {
      throw new Error("Feature fixture insert returned no row");
    }

    await expectPostgresError(
      runtime`
        INSERT INTO app.tasks (
          project_id,
          module_id,
          feature_id,
          scope_type,
          code,
          title,
          creator_id
        )
        VALUES (
          ${right.projectId},
          ${right.moduleId},
          ${feature.id},
          'FEATURE',
          ${`${right.code}-T-1`},
          'Cross-project task',
          ${userId}
        )
      `,
      "23503",
    );

    const taskId = await createTask(runtime, right, 2);
    const [link] = await runtime<Array<{ id: number }>>`
      INSERT INTO app.external_links (
        project_id,
        display_url,
        normalized_url,
        provider,
        kind,
        created_by
      )
      VALUES (
        ${left.projectId},
        'https://github.com/example/repo/issues/1',
        'https://github.com/example/repo/issues/1',
        'GITHUB',
        'ISSUE',
        ${userId}
      )
      RETURNING id
    `;
    if (!link) {
      throw new Error("External-link fixture insert returned no row");
    }

    await expectPostgresError(
      runtime`
        INSERT INTO app.task_external_links (project_id, task_id, link_id)
        VALUES (${right.projectId}, ${taskId}, ${link.id})
      `,
      "23503",
    );
  });

  test("task transitions require a contiguous immutable history and preserve completion snapshots", async () => {
    const fixture = await createProject(runtime);
    const taskId = await createTask(runtime, fixture, 1);
    const completedAt = new Date();
    const completionNote = "测试验证完成，不涉及功能变化";

    await expectPostgresError(
      runtime.begin(async (transaction) => {
        await transaction`
          UPDATE app.tasks
             SET work_status = 'DONE',
                 completed_at = ${completedAt},
                 completion_note = ${completionNote},
                 row_version = row_version + 1,
                 updated_at = now()
           WHERE id = ${taskId}
        `;
      }),
      "23514",
    );

    await runtime.begin(async (transaction) => {
      await transaction`
        UPDATE app.tasks
           SET work_status = 'DONE',
               completed_at = ${completedAt},
               completion_note = ${completionNote},
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${taskId}
      `;
      await transaction`
        INSERT INTO app.task_status_history (
          task_id,
          project_id,
          from_work_status,
          to_work_status,
          completed_at_snapshot,
          completion_note_snapshot,
          changed_by
        )
        VALUES (
          ${taskId},
          ${fixture.projectId},
          'TODO',
          'DONE',
          ${completedAt},
          ${completionNote},
          ${fixture.userId}
        )
      `;
    });

    await runtime.begin(async (transaction) => {
      await transaction`
        UPDATE app.tasks
           SET work_status = 'TODO',
               completed_at = NULL,
               completion_note = NULL,
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${taskId}
      `;
      await transaction`
        INSERT INTO app.task_status_history (
          task_id,
          project_id,
          from_work_status,
          to_work_status,
          completed_at_snapshot,
          completion_note_snapshot,
          reason,
          changed_by
        )
        VALUES (
          ${taskId},
          ${fixture.projectId},
          'DONE',
          'TODO',
          ${completedAt},
          ${completionNote},
          '需要补充回归验证',
          ${fixture.userId}
        )
      `;
    });

    const history = await runtime<
      Array<{
        completed_at_snapshot: Date | null;
        from_work_status: string | null;
        to_work_status: string;
      }>
    >`
      SELECT from_work_status, to_work_status, completed_at_snapshot
        FROM app.task_status_history
       WHERE task_id = ${taskId}
       ORDER BY id
    `;
    expect(history).toHaveLength(3);
    expect(history[2]).toMatchObject({
      from_work_status: "DONE",
      to_work_status: "TODO",
    });
    expect(history[2]?.completed_at_snapshot?.getTime()).toBe(
      completedAt.getTime(),
    );
  });

  test("published records require contiguous immutable versions matching the current projection", async () => {
    const fixture = await createProject(runtime);
    const payload = {
      changeSolution: "增加事务约束",
      contextProblem: "防止不完整发布",
      resultVerification: "集成测试通过",
    };
    const [record] = await runtime<Array<{ id: number }>>`
      INSERT INTO app.change_records (
        project_id,
        module_id,
        scope_type,
        title,
        handler_id,
        author_id
      )
      VALUES (
        ${fixture.projectId},
        ${fixture.moduleId},
        'MODULE',
        '数据库不变量',
        ${fixture.userId},
        ${fixture.userId}
      )
      RETURNING id
    `;
    if (!record) {
      throw new Error("Change-record fixture insert returned no row");
    }

    await expectPostgresError(
      runtime.begin(async (transaction) => {
        await transaction`
          UPDATE app.change_records
             SET code = ${`${fixture.code}-CR-1`},
                 status = 'PUBLISHED',
                 current_version = 1,
                 current_payload = ${transaction.json(payload)},
                 published_at = now(),
                 row_version = row_version + 1,
                 updated_at = now()
           WHERE id = ${record.id}
        `;
      }),
      "23514",
    );

    await runtime.begin(async (transaction) => {
      await transaction`
        INSERT INTO app.change_record_versions (
          record_id,
          project_id,
          version_no,
          title_snapshot,
          payload,
          created_by
        )
        VALUES (
          ${record.id},
          ${fixture.projectId},
          1,
          '数据库不变量',
          ${transaction.json(payload)},
          ${fixture.userId}
        )
      `;
      await transaction`
        UPDATE app.change_records
           SET code = ${`${fixture.code}-CR-1`},
               status = 'PUBLISHED',
               current_version = 1,
               current_payload = ${transaction.json(payload)},
               published_at = now(),
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${record.id}
      `;
    });

    await expectPostgresError(
      runtime`
        UPDATE app.change_record_versions
           SET title_snapshot = 'rewritten'
         WHERE record_id = ${record.id}
           AND version_no = 1
      `,
      "42501",
    );

    await runtime`
      UPDATE app.change_records
         SET status = 'VOID',
             voided_at = now(),
             void_reason = '验证作废与恢复状态机',
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${record.id}
    `;
    await expectPostgresError(
      runtime`
        UPDATE app.change_records
           SET status = 'PUBLISHED',
               title = 'restore must not rewrite content',
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${record.id}
      `,
      "23514",
    );
    await runtime`
      UPDATE app.change_records
         SET status = 'PUBLISHED',
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${record.id}
    `;
    const [restored] = await runtime<
      Array<{ status: string; void_reason: string | null }>
    >`
      SELECT status, void_reason
        FROM app.change_records
       WHERE id = ${record.id}
    `;
    expect(restored).toMatchObject({
      status: "PUBLISHED",
      void_reason: "验证作废与恢复状态机",
    });
  });

  test("idempotency rows enforce request uniqueness, safe response shape, and the 30-day window", async () => {
    const userId = await createUser(runtime);
    const key = `idem-${Date.now().toString(36)}-0123456789`;
    const requestHash = Buffer.alloc(32, 7);

    await runtime`
      INSERT INTO app.idempotency_records (
        actor_id,
        operation_id,
        idempotency_key,
        idempotency_contract_version,
        request_hash,
        request_hash_key_version,
        expires_at
      )
      VALUES (
        ${userId},
        'createTask',
        ${key},
        'createTask:v1',
        ${requestHash},
        1,
        now() + INTERVAL '30 days'
      )
    `;
    await expectPostgresError(
      runtime`
        INSERT INTO app.idempotency_records (
          actor_id,
          operation_id,
          idempotency_key,
          idempotency_contract_version,
          request_hash,
          request_hash_key_version,
          expires_at
        )
        VALUES (
          ${userId},
          'createTask',
          ${key},
          'createTask:v1',
          ${requestHash},
          1,
          now() + INTERVAL '30 days'
        )
      `,
      "23505",
    );
    await expectPostgresError(
      runtime`
        INSERT INTO app.idempotency_records (
          actor_id,
          operation_id,
          idempotency_key,
          idempotency_contract_version,
          request_hash,
          request_hash_key_version,
          expires_at
        )
        VALUES (
          ${userId},
          'archiveProject',
          ${`${key}-other`},
          'archiveProject:v1',
          ${requestHash},
          1,
          now() + INTERVAL '30 days 1 second'
        )
      `,
      "23514",
    );
    await expectPostgresError(
      runtime`
        UPDATE app.idempotency_records
           SET state = 'SUCCEEDED',
               response_status = 204,
               replay_policy_version = 'v1',
               replay_auth_policy_version = 'v1',
               replay_auth_context = '{}'::JSONB,
               response_has_body = FALSE,
               response_body = '{}'::JSONB
         WHERE actor_id = ${userId}
           AND operation_id = 'createTask'
           AND idempotency_key = ${key}
      `,
      "23514",
    );
  });

  test("code allocation is atomic and cannot be rewound or jumped", async () => {
    const fixture = await createProject(runtime);
    const allocations = await Promise.all(
      Array.from({ length: 40 }, () =>
        runtime<Array<{ last_number: number }>>`
          INSERT INTO app.code_sequences (
            project_id,
            entity_type,
            last_number
          )
          VALUES (${fixture.projectId}, 'TASK', 1)
          ON CONFLICT (project_id, entity_type)
          DO UPDATE
             SET last_number = app.code_sequences.last_number + 1
          RETURNING last_number
        `.then(([row]) => row?.last_number),
      ),
    );
    expect(
      allocations.sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));

    await expectPostgresError(
      runtime`
        UPDATE app.code_sequences
           SET last_number = last_number + 2
         WHERE project_id = ${fixture.projectId}
           AND entity_type = 'TASK'
      `,
      "23514",
    );
  });

  test("invalid task state jumps and FEATURE-scoped impact rows are rejected", async () => {
    const fixture = await createProject(runtime);
    const [feature] = await runtime<Array<{ id: number }>>`
      INSERT INTO app.features (
        project_id,
        module_id,
        code,
        name,
        created_by
      )
      VALUES (
        ${fixture.projectId},
        ${fixture.moduleId},
        ${`${fixture.code}-F-1`},
        'Scoped feature',
        ${fixture.userId}
      )
      RETURNING id
    `;
    if (!feature) {
      throw new Error("Feature fixture insert returned no row");
    }
    const featureTaskId = await runtime.begin(async (transaction) => {
      const [task] = await transaction<Array<{ id: number }>>`
        INSERT INTO app.tasks (
          project_id,
          module_id,
          feature_id,
          scope_type,
          code,
          title,
          creator_id
        )
        VALUES (
          ${fixture.projectId},
          ${fixture.moduleId},
          ${feature.id},
          'FEATURE',
          ${`${fixture.code}-T-1`},
          'Feature task',
          ${fixture.userId}
        )
        RETURNING id
      `;
      if (!task) {
        throw new Error("Task fixture insert returned no row");
      }
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

    await expectPostgresError(
      runtime`
        INSERT INTO app.task_feature_impacts (
          task_id,
          feature_id,
          module_id,
          project_id
        )
        VALUES (
          ${featureTaskId},
          ${feature.id},
          ${fixture.moduleId},
          ${fixture.projectId}
        )
      `,
      "23514",
    );

    await runtime.begin(async (transaction) => {
      await transaction`
        UPDATE app.tasks
           SET work_status = 'CANCELED',
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${featureTaskId}
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
          ${featureTaskId},
          ${fixture.projectId},
          'TODO',
          'CANCELED',
          ${fixture.userId}
        )
      `;
    });
    await expectPostgresError(
      runtime`
        UPDATE app.tasks
           SET work_status = 'DONE',
               completed_at = now(),
               row_version = row_version + 1,
               updated_at = now()
         WHERE id = ${featureTaskId}
      `,
      "23514",
    );
  });

  test("search projection no longer depends on pg_trgm after contract cleanup", async () => {
    const [oldIndex] = await bootstrap<Array<{ regclass: string | null }>>`
      SELECT to_regclass(
        'app.search_projection_normalized_text_trgm_idx'
      )::TEXT AS regclass
    `;
    expect(oldIndex?.regclass).toBeNull();

    const [extension] = await bootstrap<Array<{ extensionCount: number }>>`
      SELECT count(*)::INTEGER AS "extensionCount"
        FROM pg_extension
       WHERE extname = 'pg_trgm'
    `;
    expect(extension?.extensionCount).toBe(0);
  });

  test("search projection uses PGroonga with least runtime privileges", async () => {
    const [extension] = await bootstrap<
      Array<{ extname: string; schemaName: string }>
    >`
      SELECT e.extname, n.nspname AS "schemaName"
        FROM pg_extension AS e
        JOIN pg_namespace AS n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgroonga'
    `;
    expect(extension).toEqual({ extname: "pgroonga", schemaName: "app" });

    const [index] = await bootstrap<Array<{ definition: string }>>`
      SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index
       WHERE indexrelid =
         'app.idx_search_projection_pgroonga'::REGCLASS
    `;
    expect(index?.definition).toContain("USING pgroonga");
    expect(index?.definition).toContain("app.search_projection");
    const [opclass] = await bootstrap<
      Array<{ opclassName: string; schemaName: string }>
    >`
      SELECT opc.opcname AS "opclassName", n.nspname AS "schemaName"
        FROM pg_index AS i
        JOIN pg_opclass AS opc ON opc.oid = i.indclass[0]
        JOIN pg_namespace AS n ON n.oid = opc.opcnamespace
       WHERE i.indexrelid =
         'app.idx_search_projection_pgroonga'::REGCLASS
    `;
    expect(opclass).toEqual({
      opclassName: "pgroonga_text_full_text_search_ops_v2",
      schemaName: "app",
    });

    const fixture = await createProject(runtime);
    const entityId = fixture.projectId * 1_000_000 + 1;
    await runtime`
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
        ${fixture.projectId},
        'PROJECT',
        ${entityId},
        ${"登录模块"},
        '',
        ${"登录模块"},
        ${"登录模块"},
        'MEMBER',
        'ACTIVE',
        1
      )
    `;

    const [found] = await runtime<Array<{ id: bigint }>>`
      SELECT id
        FROM app.search_projection
       WHERE project_id = ${fixture.projectId}
         AND entity_id = ${entityId}
         AND normalized_search_text &@~
             app.pgroonga_query_escape(${"登录"})
       LIMIT 1
    `;
    expect(found).toBeDefined();

    const [privilege] = await bootstrap<
      Array<{ runtimeCommandExecute: boolean }>
    >`
      SELECT has_function_privilege(
        'app_runtime',
        'app.pgroonga_command(text)'::REGPROCEDURE,
        'EXECUTE'
      ) AS "runtimeCommandExecute"
    `;
    expect(privilege?.runtimeCommandExecute).toBe(false);
    await expectPostgresError(
      runtime.unsafe("SELECT app.pgroonga_command('status')"),
      "42501",
    );

    const [regexpPrivilege] = await bootstrap<
      Array<{ runtimeRegexpExecute: boolean }>
    >`
      SELECT has_function_privilege(
        'app_runtime',
        'app.pgroonga_regexp_text(text,text)'::REGPROCEDURE,
        'EXECUTE'
      ) AS "runtimeRegexpExecute"
    `;
    expect(regexpPrivilege?.runtimeRegexpExecute).toBe(false);
    await expectPostgresError(
      runtime`
        SELECT count(*)::INTEGER AS count
          FROM app.search_projection
         WHERE normalized_search_text &~ ${"登录"}
      `,
      "42501",
    );

    const [schemaPrivilege] = await bootstrap<
      Array<{ runtimeSchemaCreate: boolean; runtimeDatabaseCreate: boolean }>
    >`
      SELECT
        has_schema_privilege('app_runtime', 'app', 'CREATE')
          AS "runtimeSchemaCreate",
        has_database_privilege(
          'app_runtime',
          current_database(),
          'CREATE'
        ) AS "runtimeDatabaseCreate"
    `;
    expect(schemaPrivilege).toEqual({
      runtimeSchemaCreate: false,
      runtimeDatabaseCreate: false,
    });
    await expectPostgresError(
      runtime.unsafe(
        "CREATE INDEX runtime_forbidden_idx ON app.search_projection (id)",
      ),
      "42501",
    );
  });

  test("task groups enforce exactly one active MAIN and at least one active SOURCE at commit", async () => {
    const fixture = await createProject(runtime);
    const mainTaskId = await createTask(runtime, fixture, 1);
    const sourceTaskId = await createTask(runtime, fixture, 2);

    await runtime.begin(async (transaction) => {
      const [group] = await transaction<Array<{ id: number }>>`
        INSERT INTO app.task_groups (
          project_id,
          code,
          name,
          created_by
        )
        VALUES (
          ${fixture.projectId},
          ${`${fixture.code}-TG-1`},
          'Valid merge',
          ${fixture.userId}
        )
        RETURNING id
      `;
      if (!group) {
        throw new Error("Task-group fixture insert returned no row");
      }
      await transaction`
        INSERT INTO app.task_group_members (
          group_id,
          task_id,
          project_id,
          role
        )
        VALUES (
          ${group.id},
          ${mainTaskId},
          ${fixture.projectId},
          'MAIN'
        )
      `;
      await transaction`
        INSERT INTO app.task_group_members (
          group_id,
          task_id,
          project_id,
          role,
          source_kind,
          original_work_status,
          original_assignee_id
        )
        VALUES (
          ${group.id},
          ${sourceTaskId},
          ${fixture.projectId},
          'SOURCE',
          'ACTIVE',
          'TODO',
          ${fixture.userId}
        )
      `;
    });

    const invalidMainTaskId = await createTask(runtime, fixture, 3);
    await expectPostgresError(
      runtime.begin(async (transaction) => {
        const [group] = await transaction<Array<{ id: number }>>`
          INSERT INTO app.task_groups (
            project_id,
            code,
            name,
            created_by
          )
          VALUES (
            ${fixture.projectId},
            ${`${fixture.code}-TG-2`},
            'Missing source',
            ${fixture.userId}
          )
          RETURNING id
        `;
        if (!group) {
          throw new Error("Task-group fixture insert returned no row");
        }
        await transaction`
          INSERT INTO app.task_group_members (
            group_id,
            task_id,
            project_id,
            role
          )
          VALUES (
            ${group.id},
            ${invalidMainTaskId},
            ${fixture.projectId},
            'MAIN'
          )
        `;
      }),
      "23514",
    );
  });

  test("database roles enforce DDL, audit, backup, and owner boundaries", async () => {
    await expectPostgresError(
      runtime.unsafe("CREATE TABLE app.runtime_must_not_create (id INTEGER)"),
      "42501",
    );
    await expectPostgresError(
      runtime.unsafe("SELECT * FROM app.audit_logs"),
      "42501",
    );
    // F-10.3（迁移 0007）：pg_dump 一致性快照要求 app_backup 对 dump 范围内
    // 全部表持有表级 SELECT（含会话表）；会话表数据仍由 --exclude-table-data
    // 排除在备份文件之外，且备份角色始终没有写权限。
    await expect(
      backup.unsafe("SELECT count(*) FROM app.user_sessions"),
    ).resolves.toHaveLength(1);
    await expectPostgresError(
      backup.unsafe("DELETE FROM app.user_sessions"),
      "42501",
    );
    // ADR-032 / 迁移 0014：一次性登录材料表同样必须有表级 SELECT，
    // 这是 pg_dump 加 ACCESS SHARE 锁的前置条件；备份角色没有任何写权限。
    await expect(
      backup.unsafe("SELECT count(*) FROM app.sso_login_attempts"),
    ).resolves.toHaveLength(1);
    await expectPostgresError(
      backup.unsafe("DELETE FROM app.sso_login_attempts"),
      "42501",
    );
    // ADR-064 / 迁移 0039：文档导入批次表同样必须有表级 SELECT，
    // 这是 pg_dump 加 ACCESS SHARE 锁与一致性快照的前置条件；
    // app_backup 对该表没有任何写权限。
    await expect(
      backup.unsafe("SELECT count(*) FROM app.document_import_runs"),
    ).resolves.toHaveLength(1);
    await expectPostgresError(
      backup.unsafe("DELETE FROM app.document_import_runs"),
      "42501",
    );
    // ADR-081 / 迁移 0046+0048：identity 序列同样需要只读权限，
    // 否则 pg_dump 读取序列 last_value 时会失败。
    await expect(
      backup.unsafe("SELECT last_value FROM app.organizations_id_seq"),
    ).resolves.toHaveLength(1);
    await expect(
      backup.unsafe("SELECT count(*) FROM app.projects"),
    ).resolves.toHaveLength(1);
    await expect(
      auditReader.unsafe("SELECT count(*) FROM app.audit_logs"),
    ).resolves.toHaveLength(1);
    await expectPostgresError(
      auditReader.unsafe(
        "INSERT INTO app.audit_chain_heads (chain_id, last_sequence, last_hash, key_version) VALUES ('SYSTEM', 0, decode(repeat('00', 32), 'hex'), 1)",
      ),
      "42501",
    );
    await expect(
      archive.unsafe("SELECT count(*) FROM app.audit_logs"),
    ).resolves.toHaveLength(1);
    await expectPostgresError(
      archive.unsafe("DELETE FROM app.audit_logs"),
      "42501",
    );
    await expectPostgresError(runtime.unsafe("SET ROLE app_owner"), "42501");

    const roles = await bootstrap<
      Array<{
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolname: string;
        rolsuper: boolean;
      }>
    >`
      SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole
        FROM pg_roles
       WHERE rolname IN (
         'app_owner',
         'audit_writer',
         'app_migrator',
         'app_runtime',
         'app_backup',
         'audit_reader',
         'audit_archive_writer'
       )
       ORDER BY rolname
    `;
    expect(roles).toHaveLength(7);
    for (const role of roles) {
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolcanlogin).toBe(
        role.rolname !== "app_owner" && role.rolname !== "audit_writer",
      );
    }
  });

  test("100 simultaneous transactions append one project audit chain without gaps or forks", async () => {
    const fixture: ProjectFixture = await createProject(runtime);
    const chainId = `PROJECT:${fixture.projectId}`;
    const auditRuntime = connect(urls.runtime, 105);
    const auditKey = Buffer.from(
      "integration-only-audit-key-not-a-production-secret",
      "utf8",
    );
    let ready = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    try {
      const appends = Array.from({ length: 100 }, (_, index) =>
        auditRuntime.begin(async (transaction) => {
          ready += 1;
          if (ready === 100) {
            releaseBarrier?.();
          }
          await barrier;

          const [head] = await transaction<
            Array<{
              locked_key_version: number;
              locked_last_hash: Buffer;
              locked_last_sequence: string;
            }>
          >`
            SELECT *
              FROM app.audit_lock_head(
                ${chainId}::TEXT,
                ${fixture.projectId}::INTEGER,
                ${1}::SMALLINT
              )
          `;
          if (!head) {
            throw new Error("Audit head lock returned no row");
          }
          const sequenceNo = Number(head.locked_last_sequence) + 1;
          const eventPayload = { concurrentIndex: index };
          const envelope = {
            chainScope: chainId,
            sequenceNo,
            keyVersion: head.locked_key_version,
            prevHash: Buffer.from(head.locked_last_hash).toString("base64url"),
            eventPayload,
          };
          const recordHash = createHmac("sha256", auditKey)
            .update(JSON.stringify(envelope), "utf8")
            .digest();

          await transaction`
            SELECT *
              FROM app.audit_append_locked(
                ${chainId}::TEXT,
                ${fixture.projectId}::INTEGER,
                ${sequenceNo}::BIGINT,
                ${head.locked_last_hash}::BYTEA,
                ${head.locked_key_version}::SMALLINT,
                ${head.locked_key_version}::SMALLINT,
                'USER'::TEXT,
                ${fixture.userId}::INTEGER,
                'CONCURRENT_TEST'::TEXT,
                'PROJECT'::TEXT,
                ${fixture.projectId.toString()}::TEXT,
                ${transaction.json(eventPayload)}::JSONB,
                ${`audit-test-${index}`}::TEXT,
                NULL::TEXT,
                '127.0.0.1'::INET,
                'vitest'::TEXT,
                ${new Date()}::TIMESTAMPTZ,
                ${recordHash}::BYTEA,
                'JCS-1'::TEXT
              )
          `;
        }),
      );
      await Promise.all(appends);
    } finally {
      await auditRuntime.end({ timeout: 5 });
    }

    const rows = await auditReader<
      Array<{
        prev_hash: Buffer;
        record_hash: Buffer;
        sequence_no: string;
      }>
    >`
      SELECT sequence_no, prev_hash, record_hash
        FROM app.audit_logs
       WHERE chain_id = ${chainId}
       ORDER BY sequence_no
    `;
    expect(rows).toHaveLength(100);

    let previousHash = Buffer.alloc(32);
    rows.forEach((row, index) => {
      expect(Number(row.sequence_no)).toBe(index + 1);
      expect(Buffer.from(row.prev_hash).equals(previousHash)).toBe(true);
      previousHash = Buffer.from(row.record_hash);
    });

    const [head] = await auditReader<
      Array<{ last_hash: Buffer; last_sequence: string }>
    >`
      SELECT last_sequence, last_hash
        FROM app.audit_chain_heads
       WHERE chain_id = ${chainId}
    `;
    expect(Number(head?.last_sequence)).toBe(100);
    expect(Buffer.from(head?.last_hash ?? []).equals(previousHash)).toBe(true);
  });
});
