import { pathToFileURL } from "node:url";

import postgres from "postgres";

/**
 * E2E 夹具数据物理清理。
 *
 * 夹具账号固定使用 `e2e_` / `f03_`（Playwright，`global-setup.ts`、
 * `admin-fixture.ts` 与各 spec 的既有命名）以及 `user_` / `sso_` / `login_` /
 * `invalidate_` / `csrf_`（API 集成测试 `database.helpers.createUser` 与各
 * 集成 spec 的既有命名）以及 `backup_` / `archive_`（`apps/ops` 备份与审计归档
 * 集成测试）前缀。本模块按前缀识别夹具用户，再按其 `created_by`
 * 识别夹具项目，然后按依赖顺序物理删除全部关联业务数据、PROJECT 审计链
 * 与夹具账号；ADR-085 后，被 API 删除的项目仍保留项目审计链，清理只按夹具
 * 账号写入的 `project.create` 识别并删除这些遗留链。供 `global-teardown.ts`
 * 与集成测试收尾后手动调用。
 *
 * 数据库不变量禁止物理删除任何项目的 UNCLASSIFIED 模块
 * （`app.protect_unclassified_module`），因此删除只在清理会话内以
 * `session_replication_role = replica` 关闭行级触发器与外键检查后执行；
 * 删除结束后立即用内置断言复核：夹具残留为 0、审计无悬空 actor、
 * 项目 bootstrap 成员关系完整、每个项目恰好一个 UNCLASSIFIED 模块。
 * 任一断言失败都会回滚整个事务。该入口只清理测试夹具，不得用于生产数据。
 *
 * SYSTEM 链中夹具账号产生的记录会一并删除，并把链头回退到剩余的最后一条
 * 记录；若夹具记录之后已写入真实用户记录，链上会留下一个可检测的断点
 * （`systemChainBroken` 报告并打印提示），因为删除链中段无法在保持哈希链
 * 完整的前提下完成。
 */
export interface FixtureCleanupReport {
  readonly fixtureUsers: number;
  readonly fixtureProjects: number;
  readonly deletedRows: number;
  readonly auditRowsDeleted: number;
  /** 兜底清掉的悬空引用行数（引用的项目 / 用户已不存在），已计入 `deletedRows`。 */
  readonly orphansRemoved: number;
  readonly systemChainRewound: boolean;
  readonly systemChainBroken: boolean;
}

/**
 * 夹具账号过滤条件（`\_` 匹配字面下划线）。
 * `e2e_` / `f03_` 来自 Playwright 夹具；`user_`（`database.helpers.createUser`）、
 * `sso_`、`login_`、`invalidate_`、`csrf_` 来自 API 集成测试的夹具命名；
 * `backup_` / `archive_` 来自 `apps/ops` 备份与审计归档集成测试。
 */
// 墓碑化会改写登录名，因此同时按 sso_subject 的 e2e_ 前缀识别夹具账号。
const FIXTURE_LOGIN_FILTER = [
  "sso_subject LIKE 'e2e\\_%'",
  "login_name LIKE 'e2e\\_%'",
  "login_name LIKE 'f03\\_%'",
  "login_name LIKE 'user\\_%'",
  "login_name LIKE 'sso\\_%'",
  "login_name LIKE 'login\\_%'",
  "login_name LIKE 'invalidate\\_%'",
  "login_name LIKE 'csrf\\_%'",
  "login_name LIKE 'backup\\_%'",
  "login_name LIKE 'archive\\_%'",
].join(" OR ");

export function formatFixtureCleanupReport(
  report: FixtureCleanupReport,
): string {
  if (report.fixtureUsers === 0) {
    const head = "[e2e] 夹具清理：未发现 E2E 夹具数据";
    return report.orphansRemoved > 0
      ? `${head}；兜底清除悬空引用 ${String(report.orphansRemoved)} 行`
      : head;
  }
  let message =
    `[e2e] 夹具清理：删除用户 ${report.fixtureUsers}、项目 ${report.fixtureProjects}` +
    `、业务行 ${report.deletedRows}（含兜底悬空引用 ${report.orphansRemoved}）` +
    `、审计行 ${report.auditRowsDeleted}`;
  if (report.systemChainRewound) {
    message += "；SYSTEM 链头已回退到剩余的最后一条记录";
  }
  if (report.systemChainBroken) {
    message +=
      "；注意 SYSTEM 链留下一个断点：夹具记录之后已有真实写入，删除中段无法保持哈希链完整";
  }
  return message;
}

export async function cleanupFixtures(
  databaseUrl: string,
): Promise<FixtureCleanupReport> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connection: { application_name: "inpulse-e2e-cleanup" },
    onnotice: () => undefined,
  });
  try {
    return await sql.begin(async (transaction) => {
      await transaction.unsafe("SET LOCAL session_replication_role = replica");
      await transaction.unsafe(
        `CREATE TEMP TABLE _cleanup_users ON COMMIT DROP AS
           SELECT id FROM app.users WHERE ${FIXTURE_LOGIN_FILTER}`,
      );
      await transaction.unsafe(
        `CREATE TEMP TABLE _cleanup_projects ON COMMIT DROP AS
           SELECT id FROM app.projects
            WHERE created_by IN (SELECT id FROM _cleanup_users)`,
      );

      // ADR-085：经 API 删除的夹具项目已不存在于 app.projects，项目链仍保留。
      // 只认由夹具账号写入 project.create、且目标就是该项目的链，避免误删其他历史。
      await transaction.unsafe(
        `CREATE TEMP TABLE _cleanup_orphan_projects ON COMMIT DROP AS
           SELECT DISTINCT l.project_id AS id
             FROM app.audit_logs l
            WHERE l.project_id IS NOT NULL
              AND l.chain_id = 'PROJECT:' || l.project_id::text
              AND l.action = 'project.create'
              AND l.target_type = 'PROJECT'
              AND l.target_id = l.project_id::text
              AND l.actor_id IN (SELECT id FROM _cleanup_users)
              AND NOT EXISTS (
                SELECT 1 FROM app.projects p WHERE p.id = l.project_id
              )`,
      );

      const userRows = await transaction.unsafe(
        "SELECT count(*)::int AS n FROM _cleanup_users",
      );
      const projectRows = await transaction.unsafe(
        "SELECT count(*)::int AS n FROM _cleanup_projects",
      );
      const fixtureUsers = Number(userRows[0]?.["n"] ?? 0);
      const fixtureProjects = Number(projectRows[0]?.["n"] ?? 0);

      let deletedRows = 0;
      const remove = async (statement: string): Promise<number> => {
        const result = await transaction.unsafe(statement);
        const affected = Number(result.count ?? 0);
        deletedRows += affected;
        return affected;
      };

      // 悬空引用兜底：这些行不依赖 `_cleanup_*` 临时表，只按「引用的项目 / 用户已不存在」
      // 判定，因此**没有夹具用户时也要跑**——上一次清理留下的孤儿行如果只能在下次清理
      // 夹具用户时才被修掉，逻辑备份恢复演练会一直红到下一次 E2E 为止。
      const sweepOrphanReferences = async (): Promise<number> => {
        const start = deletedRows;
        await remove(
          `DELETE FROM app.document_import_runs r
            WHERE NOT EXISTS (
              SELECT 1 FROM app.projects p WHERE p.id = r.project_id
            )
               OR NOT EXISTS (
                 SELECT 1 FROM app.users u WHERE u.id = r.actor_id
               )`,
        );
        await remove(
          `DELETE FROM app.user_wecom_bindings
            WHERE NOT EXISTS (
              SELECT 1 FROM app.users u WHERE u.id = app.user_wecom_bindings.user_id
            )`,
        );
        await remove(
          `DELETE FROM app.wecom_binding_codes
            WHERE NOT EXISTS (
              SELECT 1 FROM app.users u WHERE u.id = app.wecom_binding_codes.user_id
            )`,
        );
        await remove(
          `DELETE FROM app.wecom_robot_config
            WHERE NOT EXISTS (
              SELECT 1 FROM app.users u WHERE u.id = app.wecom_robot_config.updated_by
            )`,
        );
        await remove(
          `DELETE FROM app.ai_assist_settings
            WHERE NOT EXISTS (
              SELECT 1 FROM app.users u WHERE u.id = app.ai_assist_settings.updated_by
            )`,
        );
        // ADR-077 项目群三张表：投递表先删（它引用绑定表），再删绑定表与待用码。
        await remove(
          `DELETE FROM app.wecom_group_deliveries
            WHERE NOT EXISTS (
              SELECT 1 FROM app.project_wecom_groups g
               WHERE g.id = app.wecom_group_deliveries.group_binding_id
            )`,
        );
        await remove(
          `DELETE FROM app.project_wecom_groups
            WHERE NOT EXISTS (
              SELECT 1 FROM app.projects p
               WHERE p.id = app.project_wecom_groups.project_id
            )
               OR NOT EXISTS (
                 SELECT 1 FROM app.users u
                  WHERE u.id = app.project_wecom_groups.bound_by_user_id
               )`,
        );
        await remove(
          `DELETE FROM app.project_wecom_binding_codes
            WHERE NOT EXISTS (
              SELECT 1 FROM app.projects p
               WHERE p.id = app.project_wecom_binding_codes.project_id
            )
               OR (consumed_by_user_id IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM app.users u
                      WHERE u.id = app.project_wecom_binding_codes.consumed_by_user_id
                   ))`,
        );
        return deletedRows - start;
      };

      if (fixtureUsers === 0) {
        const orphansRemoved = await sweepOrphanReferences();
        return {
          fixtureUsers: 0,
          fixtureProjects: 0,
          deletedRows: orphansRemoved,
          auditRowsDeleted: 0,
          orphansRemoved,
          systemChainRewound: false,
          systemChainBroken: false,
        } satisfies FixtureCleanupReport;
      }

      // 非夹具项目在清理前的不变量计数：删除动作不得让它变差。
      const beforeInvariants = await transaction.unsafe(
        `SELECT
           (SELECT count(*)::int FROM app.projects p
             WHERE p.id NOT IN (SELECT id FROM _cleanup_projects)
               AND NOT EXISTS (
                 SELECT 1 FROM app.project_members m
                  WHERE m.project_id = p.id
                    AND m.user_id = p.created_by
                    AND m.joined_at = p.created_at
               )) AS broken_bootstrap,
           (SELECT count(*)::int FROM (
             SELECT p.id
               FROM app.projects p
               LEFT JOIN app.modules m
                 ON m.project_id = p.id AND m.kind = 'UNCLASSIFIED'
              WHERE p.id NOT IN (SELECT id FROM _cleanup_projects)
              GROUP BY p.id
             HAVING count(m.id) <> 1
           ) missing) AS missing_unclassified`,
      );
      // ADR-064 文档导入批次表：夹具用户/项目产生的导入记录必须一并物理删除，
      // replica 模式跳过外键检查，漏删会留下孤儿行并让逻辑备份恢复演练失败；
      // 历史遗留的孤儿行由 `sweepOrphanReferences()` 兜底修复。
      await remove(
        `DELETE FROM app.document_import_runs
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR actor_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.notifications
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR recipient_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.activity_projection
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR actor_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.search_projection
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.task_external_links
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.feature_external_links
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.change_record_external_links
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.project_external_links
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.leftover_task_links
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.external_links
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.change_record_version_leftovers
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.change_record_versions
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.change_record_leftover_items
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.change_record_feature_impacts
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.change_records
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR author_id IN (SELECT id FROM _cleanup_users)
             OR handler_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.task_feature_impacts
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.task_status_history
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR changed_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.task_group_members
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR original_assignee_id IN (SELECT id FROM _cleanup_users)
             OR detached_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.task_groups
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.task_assignees
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.tasks
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR creator_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.features
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.modules
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR created_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.project_archive_requests
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR requested_by IN (SELECT id FROM _cleanup_users)
             OR decided_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.project_members
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.projects
          WHERE id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.code_sequences
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );

      const projectChainRows = await remove(
        `DELETE FROM app.audit_logs
          WHERE chain_id LIKE 'PROJECT:%'
            AND project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      await remove(
        `DELETE FROM app.audit_chain_heads
          WHERE project_id IN (SELECT id FROM _cleanup_projects)`,
      );
      const systemRows = await remove(
        `DELETE FROM app.audit_logs
          WHERE chain_id = 'SYSTEM'
            AND actor_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.idempotency_records
          WHERE actor_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.session_csrf_tokens
          WHERE session_id IN (
            SELECT id FROM app.user_sessions
             WHERE user_id IN (SELECT id FROM _cleanup_users)
          )`,
      );
      await remove(
        `DELETE FROM app.user_sessions
          WHERE user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.user_totp_factors
          WHERE user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.mfa_recovery_codes
          WHERE user_id IN (SELECT id FROM _cleanup_users)`,
      );
      // 会话外的 RESTRICT 引用：夹具用户还会被企业微信绑定、绑定验证码以及两张全局单例
      // 配置表（企业微信机器人 / AI 辅助转换，`updated_by`）引用。事务跑在 replica 模式下
      // 不会拦这些外键，漏删就会在删除夹具用户后留下悬空引用，让逻辑备份恢复演练重建
      // RESTRICT 约束时报 FK 违反。这四张表按用户维度先删，孤儿行由下面的兜底一并清掉。
      await remove(
        `DELETE FROM app.user_wecom_bindings
          WHERE user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.wecom_binding_codes
          WHERE user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.wecom_robot_config
          WHERE updated_by IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.ai_assist_settings
          WHERE updated_by IN (SELECT id FROM _cleanup_users)`,
      );
      // ADR-077（迁移 `0044`）的企业微信**项目群**三张表同样引用夹具用户 / 项目：
      // `project_wecom_groups.bound_by_user_id` 与 `.project_id`、
      // `project_wecom_binding_codes.project_id` 与 `.consumed_by_user_id`、
      // `wecom_group_deliveries.group_binding_id`。上面那份清单最初只覆盖个人绑定那四张
      // 表，漏了这三张——删除跑在 replica 模式下不校验外键，漏删就留下孤儿行，逻辑备份
      // 恢复演练重建 RESTRICT 约束时报 FK 违反（2026-10-16 本地 `app_ci` 实测：
      // `project_wecom_binding_codes_consumer_user_fk` 与 `project_wecom_groups_project_fk`）。
      await remove(
        `DELETE FROM app.wecom_group_deliveries
          WHERE group_binding_id IN (
            SELECT id FROM app.project_wecom_groups
             WHERE project_id IN (SELECT id FROM _cleanup_projects)
                OR bound_by_user_id IN (SELECT id FROM _cleanup_users)
          )`,
      );
      await remove(
        `DELETE FROM app.project_wecom_groups
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR bound_by_user_id IN (SELECT id FROM _cleanup_users)`,
      );
      await remove(
        `DELETE FROM app.project_wecom_binding_codes
          WHERE project_id IN (SELECT id FROM _cleanup_projects)
             OR consumed_by_user_id IN (SELECT id FROM _cleanup_users)`,
      );

      await remove(
        `DELETE FROM app.users WHERE id IN (SELECT id FROM _cleanup_users)`,
      );

      // 夹具用户删除后才可能出现悬空 actor；覆盖全部链，含缺失 project_id 的 PROJECT 链行。
      const strayRows = await remove(
        `DELETE FROM app.audit_logs
          WHERE actor_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM app.users u WHERE u.id = app.audit_logs.actor_id
            )`,
      );

      // ADR-085：夹具项目经 API 删除后，项目行消失但项目链保留。上面已在夹具账号
      // 仍存在时按 project.create 事件收集这些项目；这里只删除该集合，绝不按
      // “项目不存在且 actor 已消失”推断历史归属。
      const orphanProjectAuditRows = await remove(
        `DELETE FROM app.audit_logs l
           USING _cleanup_orphan_projects p
          WHERE l.project_id = p.id`,
      );
      const orphanProjectChainHeads = await remove(
        `DELETE FROM app.audit_chain_heads h
           USING _cleanup_orphan_projects p
          WHERE h.project_id = p.id`,
      );

      const orphansRemoved = await sweepOrphanReferences();

      const rewind = await transaction.unsafe(
        `UPDATE app.audit_chain_heads h
            SET last_sequence = t.sequence_no,
                last_hash = t.record_hash,
                updated_at = t.occurred_at
           FROM (
             SELECT sequence_no, record_hash, occurred_at
               FROM app.audit_logs
              WHERE chain_id = 'SYSTEM'
              ORDER BY sequence_no DESC
              LIMIT 1
           ) t
          WHERE h.chain_id = 'SYSTEM'
            AND h.last_sequence > t.sequence_no`,
      );
      const systemChainRewound = Number(rewind.count ?? 0) > 0;

      await transaction.unsafe(
        `SELECT setval('app.users_id_seq',
                       coalesce((SELECT max(id) FROM app.users), 0) + 1,
                       false)`,
      );
      await transaction.unsafe(
        `SELECT setval('app.projects_id_seq',
                       coalesce((SELECT max(id) FROM app.projects), 0) + 1,
                       false)`,
      );

      let systemChainBroken = false;
      if (systemRows > 0) {
        const breaks = await transaction.unsafe(
          `SELECT count(*)::int AS n
             FROM app.audit_logs a
            WHERE a.chain_id = 'SYSTEM'
              AND a.sequence_no > 1
              AND NOT EXISTS (
                SELECT 1 FROM app.audit_logs b
                 WHERE b.chain_id = a.chain_id
                   AND b.sequence_no = a.sequence_no - 1
                   AND b.record_hash = a.prev_hash
              )`,
        );
        systemChainBroken = Number(breaks[0]?.["n"] ?? 0) > 0;
      }

      const checkRows = await transaction.unsafe(
        `SELECT
           (SELECT count(*)::int FROM app.document_import_runs r
             WHERE r.project_id IN (SELECT id FROM _cleanup_projects)
                OR r.actor_id IN (SELECT id FROM _cleanup_users))
             AS remaining_import_runs,
           (SELECT count(*)::int FROM app.document_import_runs r
             WHERE NOT EXISTS (
               SELECT 1 FROM app.projects p WHERE p.id = r.project_id
             )
                OR NOT EXISTS (
                  SELECT 1 FROM app.users u WHERE u.id = r.actor_id
                )) AS orphan_import_runs,
           (SELECT count(*)::int FROM app.project_wecom_binding_codes c
             WHERE NOT EXISTS (
               SELECT 1 FROM app.projects p WHERE p.id = c.project_id
             )
                OR (c.consumed_by_user_id IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM app.users u WHERE u.id = c.consumed_by_user_id
                    ))) AS orphan_project_wecom_codes,
           (SELECT count(*)::int FROM app.project_wecom_groups g
             WHERE NOT EXISTS (
               SELECT 1 FROM app.projects p WHERE p.id = g.project_id
             )
                OR NOT EXISTS (
                  SELECT 1 FROM app.users u WHERE u.id = g.bound_by_user_id
                )) AS orphan_project_wecom_groups,
           (SELECT count(*)::int FROM app.wecom_group_deliveries d
             WHERE NOT EXISTS (
               SELECT 1 FROM app.project_wecom_groups g WHERE g.id = d.group_binding_id
             )) AS orphan_wecom_deliveries,
           (SELECT count(*)::int FROM app.users
             WHERE ${FIXTURE_LOGIN_FILTER}) AS remaining_users,
           (SELECT count(*)::int FROM app.projects
             WHERE id IN (SELECT id FROM _cleanup_projects))
             AS remaining_projects,
           (SELECT count(*)::int FROM app.audit_logs l
             WHERE l.actor_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM app.users u WHERE u.id = l.actor_id
               )) AS dangling_audit_actors,
           (SELECT count(*)::int FROM app.projects p
             WHERE NOT EXISTS (
               SELECT 1 FROM app.project_members m
                WHERE m.project_id = p.id
                  AND m.user_id = p.created_by
                  AND m.joined_at = p.created_at
             )) AS broken_bootstrap,
           (SELECT count(*)::int FROM (
             SELECT p.id
               FROM app.projects p
               LEFT JOIN app.modules m
                 ON m.project_id = p.id AND m.kind = 'UNCLASSIFIED'
              GROUP BY p.id
             HAVING count(m.id) <> 1
           ) missing) AS missing_unclassified`,
      );
      const checks = (checkRows[0] ?? {}) as Record<string, number>;
      const before = (beforeInvariants[0] ?? {}) as Record<string, number>;
      const failedChecks = [
        // 夹具残留与悬空审计 actor 必须为 0。
        ...[
          "remaining_users",
          "remaining_projects",
          "remaining_import_runs",
          "orphan_import_runs",
          "dangling_audit_actors",
          "orphan_project_wecom_codes",
          "orphan_project_wecom_groups",
          "orphan_wecom_deliveries",
        ].filter((key) => Number(checks[key] ?? 0) !== 0),
        // 项目不变量只要求清理未让计数变差：本地库可能存在规范化之前建立的历史项目。
        ...["broken_bootstrap", "missing_unclassified"].filter(
          (key) => Number(checks[key] ?? 0) > Number(before[key] ?? 0),
        ),
      ];
      if (failedChecks.length > 0) {
        throw new Error(
          `夹具清理后完整性断言失败：${failedChecks
            .map((key) => `${key}=${String(checks[key])}`)
            .join(", ")}`,
        );
      }

      return {
        fixtureUsers,
        fixtureProjects,
        deletedRows,
        auditRowsDeleted:
          projectChainRows +
          systemRows +
          strayRows +
          orphanProjectAuditRows +
          orphanProjectChainHeads,
        orphansRemoved,
        systemChainRewound,
        systemChainBroken,
      } satisfies FixtureCleanupReport;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const databaseUrl =
    process.env["E2E_DATABASE_URL"]?.trim() ??
    process.env["TEST_DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error(
      "[e2e] 需要 E2E_DATABASE_URL 或 TEST_DATABASE_URL（bootstrap 角色）才能清理夹具数据",
    );
    process.exitCode = 1;
  } else {
    const report = await cleanupFixtures(databaseUrl);
    console.log(formatFixtureCleanupReport(report));
  }
}
