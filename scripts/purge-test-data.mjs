#!/usr/bin/env node
// 清理 InPulse 本地数据库中的测试残留数据。
// 清理对象: login_name 以 user_ 开头的测试用户、其创建的测试项目、以及全部关联行。
// 用法: node scripts/purge-test-data.mjs [--dry-run] [--no-backup]
// 约定: 每次跑完集成测试、Playwright E2E 或手工冒烟后都必须执行本脚本清理测试数据。
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  localDatabaseUrl,
  prepareManagedLocalDatabase,
  resolveLocalPostgresPort,
  resolvePostgresBin,
} from "./local-postgres.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = (process.env.INPULSE_PG_CONTAINER ?? "").trim();
const LEGACY_DB_USER = process.env.INPULSE_PG_USER ?? "cluster_bootstrap";
const LEGACY_DB_NAME = process.env.INPULSE_PG_DB ?? "app";
const DEFAULT_DATABASE_URL = localDatabaseUrl(
  "app",
  resolveLocalPostgresPort(process.env),
);
const PURGE_DATABASE_URL =
  process.env.INPULSE_PURGE_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const DRY = process.argv.includes("--dry-run");
const NO_BACKUP = process.argv.includes("--no-backup");

let DATABASE;
if (CONTAINER.length > 0) {
  DATABASE = {
    mode: "docker",
    container: CONTAINER,
    user: LEGACY_DB_USER,
    database: LEGACY_DB_NAME,
  };
  console.log(
    "使用显式指定的 Docker 容器 " +
      CONTAINER +
      "（兼容模式；默认已改为原生 PostgreSQL）",
  );
} else {
  const managed = await prepareManagedLocalDatabase({
    root: ROOT,
    databaseUrl: PURGE_DATABASE_URL,
    environment: process.env,
    migrate: false,
  });
  let parsed;
  try {
    parsed = new URL(PURGE_DATABASE_URL);
  } catch {
    throw new Error("INPULSE_PURGE_DATABASE_URL 不是合法 URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("清理连接串必须是 postgresql://");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (database.length === 0) {
    throw new Error("清理连接串缺少数据库名");
  }
  const user = decodeURIComponent(parsed.username);
  if (user.length === 0) {
    throw new Error("清理连接串缺少数据库角色");
  }
  const bin = managed?.bin ?? resolvePostgresBin(process.env, {});
  DATABASE = {
    mode: "native",
    bin,
    host: parsed.hostname,
    port: managed?.port ?? Number.parseInt(parsed.port || "5432", 10),
    user,
    database,
    password: decodeURIComponent(parsed.password),
  };
  console.log(
    "使用原生 PostgreSQL " +
      DATABASE.host +
      ":" +
      DATABASE.port +
      "/" +
      database,
  );
}

function executableName(name) {
  return process.platform === "win32" ? name + ".exe" : name;
}

const psqlPath =
  DATABASE.mode === "native"
    ? path.join(DATABASE.bin, executableName("psql"))
    : "";
const pgDumpPath =
  DATABASE.mode === "native"
    ? path.join(DATABASE.bin, executableName("pg_dump"))
    : "";

function connectionEnvironment() {
  if (DATABASE.mode !== "native" || !DATABASE.password) {
    return process.env;
  }
  return { ...process.env, PGPASSWORD: DATABASE.password };
}

function sh(cmd, argv, options = {}) {
  const res = spawnSync(cmd, argv, {
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(cmd + " 执行失败, 退出码 " + res.status);
  }
  return (res.stdout ?? "").trim();
}

function psql(sql) {
  if (DATABASE.mode === "docker") {
    return sh("docker", [
      "exec",
      DATABASE.container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      DATABASE.user,
      "-d",
      DATABASE.database,
      "-t",
      "-A",
      "-c",
      sql,
    ]);
  }
  return sh(
    psqlPath,
    [
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      DATABASE.host,
      "-p",
      String(DATABASE.port),
      "-U",
      DATABASE.user,
      "-d",
      DATABASE.database,
      "-t",
      "-A",
      "-c",
      sql,
    ],
    { env: connectionEnvironment() },
  );
}

function parseCounts(out) {
  const LF = String.fromCharCode(10);
  const map = new Map();
  for (const raw of out.split(LF)) {
    const line = raw.trim();
    const sep = line.indexOf("|");
    if (sep > 0) map.set(line.slice(0, sep), Number(line.slice(sep + 1)));
  }
  return map;
}

const TEST_USER_PREDICATE = "login_name ~ $$^user_$$";
const TEST_USERS = "(select id from users where " + TEST_USER_PREDICATE + ")";
const REAL_PROJECTS =
  "(select id from projects where created_by not in " + TEST_USERS + ")";
const PROJECT_SCOPE = "project_id in (select id from tmp_purge_projects)";
const USER_SCOPE = "(select id from tmp_purge_users)";

const precheck = parseCounts(
  psql(
    [
      "set search_path=app;",
      "select $$test_users|$$ || count(*) from users where " +
        TEST_USER_PREDICATE +
        ";",
      "select $$test_projects|$$ || count(*) from projects where created_by in " +
        TEST_USERS +
        ";",
      "select $$system_chain_affected|$$ || count(*) from audit_logs where chain_id = $$SYSTEM$$ and (actor_id in " +
        TEST_USERS +
        " or project_id in (select id from projects where created_by in " +
        TEST_USERS +
        "));",
      "select $$real_project_leak|$$ || count(*) from (",
      "  select 1 from project_members where project_id in " +
        REAL_PROJECTS +
        " and user_id in " +
        TEST_USERS,
      "  union all select 1 from task_assignees where project_id in " +
        REAL_PROJECTS +
        " and user_id in " +
        TEST_USERS,
      "  union all select 1 from notifications where project_id in " +
        REAL_PROJECTS +
        " and recipient_id in " +
        TEST_USERS,
      "  union all select 1 from activity_projection where project_id in " +
        REAL_PROJECTS +
        " and actor_id in " +
        TEST_USERS,
      "  union all select 1 from tasks where project_id in " +
        REAL_PROJECTS +
        " and creator_id in " +
        TEST_USERS,
      "  union all select 1 from features where project_id in " +
        REAL_PROJECTS +
        " and created_by in " +
        TEST_USERS,
      "  union all select 1 from modules where project_id in " +
        REAL_PROJECTS +
        " and created_by in " +
        TEST_USERS,
      "  union all select 1 from audit_logs where project_id in " +
        REAL_PROJECTS +
        " and actor_id in " +
        TEST_USERS,
      ") q;",
    ].join(" "),
  ),
);

console.log("== 预检 ==");
for (const entry of precheck) console.log("  " + entry[0] + ": " + entry[1]);

const systemAffected = precheck.get("system_chain_affected") ?? 0;
const realLeak = precheck.get("real_project_leak") ?? 0;
if (systemAffected > 0) {
  throw new Error(
    "SYSTEM 审计链上存在测试事件, 为避免破坏审计链完整性已中止。",
  );
}
if (realLeak > 0) {
  throw new Error(
    "真实项目中仍有测试用户引用, 直接删除会触发外键失败, 请人工处理后再运行。",
  );
}

const STEPS = [
  ["change_record_version_leftovers", PROJECT_SCOPE],
  ["change_record_external_links", PROJECT_SCOPE],
  ["change_record_versions", PROJECT_SCOPE],
  ["leftover_task_links", PROJECT_SCOPE],
  ["change_record_leftover_items", PROJECT_SCOPE],
  ["change_records", PROJECT_SCOPE],
  ["task_group_members", PROJECT_SCOPE],
  ["task_status_history", PROJECT_SCOPE],
  ["task_assignees", PROJECT_SCOPE],
  ["task_external_links", PROJECT_SCOPE],
  ["tasks", PROJECT_SCOPE],
  ["task_groups", PROJECT_SCOPE],
  ["project_external_links", PROJECT_SCOPE],
  ["modules", PROJECT_SCOPE],
  ["project_archive_requests", PROJECT_SCOPE],
  ["code_sequences", PROJECT_SCOPE],
  ["project_members", PROJECT_SCOPE],
  ["notifications", PROJECT_SCOPE + " or recipient_id in " + USER_SCOPE],
  ["activity_projection", PROJECT_SCOPE + " or actor_id in " + USER_SCOPE],
  ["search_projection", PROJECT_SCOPE],
  ["external_links", PROJECT_SCOPE + " or created_by in " + USER_SCOPE],
  ["audit_logs", PROJECT_SCOPE + " or actor_id in " + USER_SCOPE],
  [
    "audit_chain_heads",
    "project_id in (select id from tmp_purge_projects) and not exists (select 1 from app.audit_logs l where l.chain_id = app.audit_chain_heads.chain_id)",
  ],
  ["idempotency_records", "actor_id in " + USER_SCOPE],
  [
    "session_csrf_tokens",
    "session_id in (select id from app.user_sessions where user_id in " +
      USER_SCOPE +
      ")",
  ],
  ["user_sessions", "user_id in " + USER_SCOPE],
  ["user_totp_factors", "user_id in " + USER_SCOPE],
  ["mfa_recovery_codes", "user_id in " + USER_SCOPE],
  ["preauth_sessions", "consumed_at is not null or expires_at < now()"],
  ["sso_login_attempts", "consumed_at is not null or expires_at < now()"],
  ["auth_rate_limit_buckets", "window_started_at < now() - interval $$1 day$$"],
  ["projects", "id in (select id from tmp_purge_projects)"],
  ["users", TEST_USER_PREDICATE],
];

const statements = [
  "set search_path=app;",
  "begin;",
  "create temp table tmp_purge_users on commit drop as select id from users where " +
    TEST_USER_PREDICATE +
    ";",
  "create temp table tmp_purge_projects on commit drop as select id from projects where created_by in (select id from tmp_purge_users);",
  "alter table app.modules disable trigger modules_protect_unclassified;",
];
for (const step of STEPS) {
  statements.push(
    "with d as (delete from app." +
      step[0] +
      " where " +
      step[1] +
      " returning 1) select $$" +
      step[0] +
      "|$$ || count(*) from d;",
  );
}
statements.push("set constraints all immediate;");
statements.push(
  "alter table app.modules enable trigger modules_protect_unclassified;",
);
statements.push(DRY ? "rollback;" : "commit;");

if (!DRY && !NO_BACKUP) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (DATABASE.mode === "docker") {
    const dumpPath = "/tmp/purge-backup-" + stamp + ".dump";
    sh("docker", [
      "exec",
      DATABASE.container,
      "pg_dump",
      "-U",
      DATABASE.user,
      "-d",
      DATABASE.database,
      "-Fc",
      "-f",
      dumpPath,
    ]);
    console.log("已备份到容器内 " + dumpPath);
  } else {
    const dumpPath = path.join(
      tmpdir(),
      "inpulse-purge-backup-" + stamp + ".dump",
    );
    sh(
      pgDumpPath,
      [
        "-h",
        DATABASE.host,
        "-p",
        String(DATABASE.port),
        "-U",
        DATABASE.user,
        "-d",
        DATABASE.database,
        "-Fc",
        "-f",
        dumpPath,
      ],
      { env: connectionEnvironment() },
    );
    console.log("已备份到本机 " + dumpPath);
  }
}

console.log("== 清理" + (DRY ? " (dry-run, 结束后回滚)" : "") + " ==");
console.log(psql(statements.join(" ")));

if (DRY) {
  console.log("dry-run 已回滚, 数据库未改动。");
} else {
  const after = parseCounts(
    psql(
      [
        "set search_path=app;",
        "select $$remaining_users|$$ || count(*) from users;",
        "select $$remaining_projects|$$ || count(*) from projects;",
        "select $$remaining_test_users|$$ || count(*) from users where " +
          TEST_USER_PREDICATE +
          ";",
        "select $$remaining_chains|$$ || count(*) from audit_chain_heads;",
      ].join(" "),
    ),
  );
  console.log("== 校验 ==");
  for (const entry of after) console.log("  " + entry[0] + ": " + entry[1]);
  const leftover = after.get("remaining_test_users") ?? 0;
  if (leftover > 0) {
    throw new Error("仍有 " + leftover + " 个测试用户未删除。");
  }
  console.log("测试数据清理完成。");
}
