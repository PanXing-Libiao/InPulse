#!/usr/bin/env node
/**
 * 把仓库里的演示数据（`database/seed/demo-data.sql`）载入一个已经跑完迁移的数据库。
 *
 *   pnpm db:seed:demo              目标库必须还没有业务数据
 *   pnpm db:seed:demo -- --force   先清空演示表再载入（本地反复演示时用）
 *
 * 目标库地址按 SEED_DATABASE_URL → DATABASE_URL 的顺序取，默认指向本地演示库。
 * 载入完成后会把演示账号的口令统一重置为演示口令（默认 Inpulse@2026，可用 SEED_DEMO_PASSWORD 覆盖），
 * 并清掉种子快照之外的运行痕迹，让拿到仓库的人可以直接登录。
 *
 * 之所以放在 API 包里：口令哈希必须由 `@node-rs/argon2` 生成，而它已经是 API 的运行时依赖，
 * 这里可以直接复用同一套参数，不需要为了脚本新增任何依赖。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashSync, verifySync } from "@node-rs/argon2";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SEED_FILE = resolve(ROOT, "database/seed/demo-data.sql");
const DEFAULT_DATABASE_URL =
  "postgresql://cluster_bootstrap@127.0.0.1:55432/app";
// 与 apps/api/src/auth/password.service.ts 的 ARGON2ID_OPTIONS 保持一致。
const ARGON2ID_OPTIONS = {
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  algorithm: 2,
};
const ARGON2ID_PREFIX = "$argon2id$v=19$m=19456,t=2,p=1$";

/** 演示数据表：`--force` 时先清空，避免重复载入产生主键冲突。 */
const SEEDED_TABLES = [
  "activity_projection",
  "audit_chain_heads",
  "audit_logs",
  "change_record_external_links",
  "change_record_feature_impacts",
  "change_record_leftover_items",
  "change_record_version_leftovers",
  "change_record_versions",
  "change_records",
  "code_sequences",
  "external_links",
  "leftover_task_links",
  "modules",
  "notifications",
  "project_external_links",
  "project_members",
  "projects",
  "search_projection",
  "task_external_links",
  "task_group_members",
  "task_groups",
  "task_status_history",
  "tasks",
  "users",
];

/** 运行痕迹表：不属于演示数据，载入时一并清掉，保证登录态是干净的。 */
const RUNTIME_TABLES = [
  "auth_rate_limit_buckets",
  "idempotency_records",
  "mfa_recovery_codes",
  "preauth_sessions",
  "session_csrf_tokens",
  "user_sessions",
  "user_totp_factors",
];

/**
 * 统计用单行查询：SQL 里只出现 ASCII，
 * 因为 Windows 版 psql 会把 `--command` 参数按控制台代码页转码，中文会变成非法字节序列。
 */
const SUMMARY_COLUMNS = [
  ["users", "账号"],
  ["projects", "项目"],
  ["project_members", "项目成员"],
  ["modules", "模块"],
  ["tasks", "任务"],
  ["change_records", "迭代记录"],
  ["external_links", "外部链接"],
  ["activity_projection", "项目动态"],
  ["audit_logs", "审计记录"],
  ["notifications", "站内通知"],
];
const SUMMARY_SQL = `SELECT ${SUMMARY_COLUMNS.map(
  ([table]) => `(SELECT count(*) FROM app.${table}) AS ${table}`,
).join(", ")};`;

function fatal(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function runPsql(psql, databaseUrl, args, options = {}) {
  const result = spawnSync(
    psql,
    ["--no-psqlrc", ...args, databaseUrl],
    options,
  );
  if (result.error) fatal(`无法运行 psql（${psql}）：${result.error.message}`);
  return result;
}

function probeOne(psql, databaseUrl, sql) {
  const result = runPsql(psql, databaseUrl, [
    "--set",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--command",
    sql,
  ]);
  if (result.status !== 0) {
    fatal(
      `无法连接目标数据库或查询失败：${result.stderr?.toString().trim() || sql}`,
    );
  }
  return result.stdout.toString().trim();
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const psql = process.env.INPULSE_SEED_PSQL ?? "psql";
  const databaseUrl =
    process.env.SEED_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_DATABASE_URL;
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? "Inpulse@2026";

  if (
    probeOne(psql, databaseUrl, "SELECT to_regclass('app.users') IS NULL") ===
    "t"
  ) {
    fatal("目标数据库还没有表结构，请先运行 pnpm db:migrate。");
  }

  const existingUsers = Number(
    probeOne(psql, databaseUrl, "SELECT count(*) FROM app.users"),
  );
  if (existingUsers > 0 && !force) {
    fatal(
      `目标数据库已有 ${existingUsers} 个账号，为避免重复载入已停止；确认要覆盖时请加 --force。`,
    );
  }

  if (force) {
    const truncate = runPsql(
      psql,
      databaseUrl,
      [
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        `TRUNCATE ${[...SEEDED_TABLES, ...RUNTIME_TABLES]
          .map((table) => `app.${table}`)
          .join(", ")} CASCADE`,
      ],
      { stdio: "inherit" },
    );
    if (truncate.status !== 0) fatal("清空演示表失败。");
  }

  const workdir = mkdtempSync(join(tmpdir(), "inpulse-seed-"));
  try {
    const passwordHash = hashSync(demoPassword, ARGON2ID_OPTIONS);
    if (!passwordHash.startsWith(ARGON2ID_PREFIX)) {
      fatal("口令哈希参数与登录校验不一致，已停止。");
    }
    const passwordFile = join(workdir, "demo-passwords.sql");
    writeFileSync(
      passwordFile,
      [
        "UPDATE app.users",
        `SET password_hash = '${passwordHash}',`,
        "    password_changed_at = now(),",
        "    row_version = row_version + 1,", // 行版本触发器要求恰好递增一次
        "    updated_at = now();",
        "",
      ].join("\n"),
      "utf8",
    );

    const load = runPsql(
      psql,
      databaseUrl,
      [
        "--set",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "--file",
        SEED_FILE,
        "--file",
        passwordFile,
      ],
      { stdio: "inherit" },
    );
    if (load.status !== 0) fatal("演示数据载入失败，事务已回滚。");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  const summary = runPsql(psql, databaseUrl, [
    "--set",
    "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--field-separator",
    "|",
    "--command",
    SUMMARY_SQL,
  ]);
  if (summary.status !== 0) fatal("载入后统计失败。");
  const counts = summary.stdout.toString().trim().split("|");

  // 回读一次口令哈希，确认刚写进去的口令真的能通过登录校验。
  const storedHash = probeOne(
    psql,
    databaseUrl,
    "SELECT password_hash FROM app.users WHERE login_name = 'tege'",
  );
  if (!verifySync(storedHash, demoPassword)) {
    fatal("口令回读校验失败，已载入的数据无法用演示口令登录。");
  }
  if (verifySync(storedHash, `${demoPassword}-wrong`)) {
    fatal("口令回读校验异常：错误口令也通过了校验。");
  }

  console.log("");
  console.log(`✔ 演示数据已载入 ${databaseUrl}`);
  SUMMARY_COLUMNS.forEach(([, label], index) => {
    console.log(`  ${label}：${counts[index]}`);
  });
  console.log(`  演示口令：${demoPassword}`);
  console.log("  特哥 tege（管理员）");
  console.log("  小潘 xiaopan / 小吴 xiaowu / 小邵 xiaoshao");
  console.log("  登录会话属于运行痕迹，不在演示数据内。");
}

main();
