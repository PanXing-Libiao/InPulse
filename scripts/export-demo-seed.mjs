#!/usr/bin/env node
/**
 * 从演示库导出可提交进仓库的种子数据（`database/seed/demo-data.sql`）。
 *
 * 这是维护者工具：只有在演示库内容有意变更时才重新运行，并把生成的 SQL 与这次改动一起提交。
 * 导出过程会做三件事：
 *   1. 只导出演示数据表，运行痕迹（登录会话、CSRF、幂等记录、限流桶、审计留痕）一律不导出；
 *   2. 把 `app.users.password_hash` 换成固定占位值，口令哈希绝不能进仓库；
 *   3. 统一文件头、保持 pg_dump 的依赖顺序，保证同样的数据导出同样的字节。
 *
 * 用法：
 *   INPULSE_SEED_SOURCE_URL=postgresql://cluster_bootstrap@127.0.0.1:55432/app \
 *   INPULSE_SEED_PG_DUMP=/path/to/pg_dump \
 *   node scripts/export-demo-seed.mjs [--out <path>] [--check]
 *
 * `--check` 只读文件、不连数据库，用于 `pnpm db:seed:check` 的生成物漂移检查。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "database/seed/demo-data.sql");

/**
 * 进入演示快照的业务表。**顺序就是载入顺序**，必须同时满足外键与应用层触发器：
 * `project_members` 要早于 `tasks`（任务负责人必须是项目在册成员），
 * `audit_chain_heads` 要早于 `audit_logs`（`audit_logs.chain_id` 指向链头），
 * `audit_logs` 要早于 `activity_projection`（项目动态的来源外键指向审计记录），
 * `external_links` 要早于各张 `*_external_links` 关联表，其余按父到子排列。
 */
export const SEED_TABLES = [
  "users",
  "projects",
  "project_members",
  "audit_chain_heads",
  "audit_logs",
  "modules",
  "tasks",
  "task_assignees",
  "task_groups",
  "task_group_members",
  "task_status_history",
  "change_records",
  "change_record_versions",
  "change_record_leftover_items",
  "change_record_version_leftovers",
  "leftover_task_links",
  "external_links",
  "project_external_links",
  "task_external_links",
  "change_record_external_links",
  "activity_projection",
  "notifications",
  "search_projection",
  "code_sequences",
];

/**
 * 明确不进快照的表：登录态、一次性安全材料、幂等重放、限流桶、恢复码
 * 以及迁移台账（由目标库自己的迁移运行器维护）。
 * 业务审计链必须导出：项目动态的来源外键指向它。
 */
export const EXCLUDED_TABLES = [
  "auth_rate_limit_buckets",
  "idempotency_records",
  "mfa_recovery_codes",
  "preauth_sessions",
  "schema_migrations",
  "session_csrf_tokens",
  "user_sessions",
  "user_totp_factors",
];

/**
 * 必须替换掉的列：口令列既 NOT NULL 又有 `LIKE '$argon2id$%'` 约束，所以导出时写入固定占位值，
 * 由 `pnpm db:seed:demo` 在载入后统一重置为演示口令。
 * 占位值不是完整的 Argon2 编码，登录校验必然返回「口令错误」，
 * 因此即使有人只导入了 SQL 也无法用任何口令登录。
 */
export const PLACEHOLDER_COLUMNS = {
  users: { password_hash: "$argon2id$seed-demo-placeholder" },
};

/**
 * 按行丢弃的痕迹：审计链里由测试套件写入的 SYSTEM 链记录（`SYSTEM_TEST` /
 * `AUDIT_SEED_*`）不是业务历史，留在快照里只会让演示数据看起来像测试库。
 */
export const DROPPED_ROW_MARKERS = {
  audit_logs: ["SYSTEM_TEST", "AUDIT_SEED_"],
};

/**
 * 完整 Argon2 编码哈希的形态，与 scripts/check_secrets.mjs 的判定保持一致：
 * 只有完整编码才算口令哈希泄露，`LIKE '$argon2id$%'` 这类前缀不算。
 */
const COMPLETE_PASSWORD_HASH =
  /\$(?:argon2i|argon2d|argon2id)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[^\s$]{6,}\$[A-Za-z0-9+/=]{16,}/;

const PROLOGUE = `--
-- InPulse 演示种子数据（自动生成，请勿手工编辑）
--
-- 由 scripts/export-demo-seed.mjs 从演示库导出，只包含业务数据：
--   * 不含登录会话、CSRF、幂等记录、限流桶、恢复码（运行痕迹）
--   * 含项目审计链：项目动态的来源外键指向它，缺了就无法载入
--   * 不含演示账号的口令哈希，口令列是固定占位值，载入时由 db:seed:demo 统一重置为演示口令
--   * 表顺序是父到子的载入顺序，请勿调整
-- 载入方式：pnpm db:seed:demo（会顺带把演示账号口令重置为演示口令）
--
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;
`;

export function parseDump(text) {
  // Windows 版 pg_dump 输出 CRLF，仓库统一使用 LF。
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = new Map();
  const setvals = [];
  const ignoredHeader = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("COPY app.")) {
      const header = /^COPY app\.([a-z_]+) \(([^)]*)\) FROM stdin;$/.exec(line);
      if (!header) throw new Error(`无法解析 COPY 头：${line}`);
      const table = header[1];
      const rows = [];
      i += 1;
      while (i < lines.length && lines[i] !== "\\.") {
        rows.push(lines[i]);
        i += 1;
      }
      if (i >= lines.length) throw new Error(`COPY 块未闭合：${table}`);
      blocks.set(table, { columns: header[2].split(", "), rows });
      continue;
    }
    if (line.startsWith("SELECT pg_catalog.setval(")) {
      setvals.push(line);
      continue;
    }
    ignoredHeader.push(line);
  }

  return { blocks, setvals, ignoredHeader };
}

function redactBlock(table, block) {
  const replacements = PLACEHOLDER_COLUMNS[table];
  if (!replacements) return block;
  const targets = new Map();
  block.columns.forEach((column, index) => {
    if (column in replacements) targets.set(index, replacements[column]);
  });
  if (targets.size === 0) return block;
  const rows = block.rows.map((row) => {
    const fields = row.split("\t");
    if (fields.length !== block.columns.length) {
      throw new Error(
        `app.${table} 行字段数 ${fields.length} 与列数 ${block.columns.length} 不一致`,
      );
    }
    for (const [index, value] of targets) fields[index] = value;
    return fields.join("\t");
  });
  return { columns: block.columns, rows };
}

function dropTracedRows(table, rows) {
  const markers = DROPPED_ROW_MARKERS[table];
  if (!markers) return rows;
  return rows.filter((row) => !markers.some((marker) => row.includes(marker)));
}

export function renderSeed(parsed) {
  const parts = [PROLOGUE];
  // 按 SEED_TABLES 的顺序输出：外键与应用层触发器都要求父表在前。
  for (const table of SEED_TABLES) {
    const block = parsed.blocks.get(table);
    if (!block) continue;
    const replaced = redactBlock(table, block);
    const rows = dropTracedRows(table, replaced.rows);
    parts.push(
      `--\n-- Data for Name: ${table}; Type: TABLE DATA; Schema: app\n--\n`,
      `COPY app.${table} (${replaced.columns.join(", ")}) FROM stdin;`,
      ...rows,
      "\\.",
      "",
    );
  }
  parts.push("--\n-- Sequence values\n--\n");
  for (const line of parsed.setvals.sort()) parts.push(`${line}\n`);
  return `${parts.join("\n")}`;
}

export function validateSeed(text, tables = SEED_TABLES) {
  const problems = [];
  if (COMPLETE_PASSWORD_HASH.test(text)) problems.push("包含口令哈希");
  for (const table of EXCLUDED_TABLES) {
    if (new RegExp(`COPY app\\.${table} \\(`).test(text)) {
      problems.push(`包含不应导出的表 app.${table}`);
    }
  }
  for (const table of tables) {
    if (!new RegExp(`COPY app\\.${table} \\(`).test(text)) {
      problems.push(`缺少表 app.${table}`);
    }
  }
  if (/PRIVATE KEY|BEGIN OPENSSH/.test(text)) problems.push("包含密钥材料");
  for (const [table, markers] of Object.entries(DROPPED_ROW_MARKERS)) {
    for (const marker of markers) {
      if (new RegExp(`COPY app\\.${table} \\([^]*?${marker}`).test(text)) {
        problems.push(`app.${table} 仍含测试痕迹 ${marker}`);
      }
    }
  }
  const parsed = parseDump(text);
  const order = [...parsed.blocks.keys()].filter((table) =>
    tables.includes(table),
  );
  const expected = tables.filter((table) => parsed.blocks.has(table));
  if (order.join(",") !== expected.join(",")) {
    problems.push(`表顺序必须满足载入依赖：${expected.join(" -> ")}`);
  }
  const users = parsed.blocks.get("users");
  if (!users || !/^id, login_name/.test(users.columns.join(", "))) {
    problems.push("app.users 列顺序异常");
  }
  for (const [table, columns] of Object.entries(PLACEHOLDER_COLUMNS)) {
    const block = parsed.blocks.get(table);
    if (!block) continue;
    for (const [column, expected] of Object.entries(columns)) {
      const index = block.columns.indexOf(column);
      if (index < 0) {
        problems.push(`app.${table} 缺少列 ${column}`);
        continue;
      }
      for (const row of block.rows) {
        const value = row.split("\t")[index];
        if (value !== expected) {
          problems.push(`app.${table}.${column} 出现非占位值：${value}`);
          break;
        }
      }
    }
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : DEFAULT_OUT;
  const check = args.includes("--check");

  if (check) {
    const existing = readFileSync(out, "utf8");
    const problems = validateSeed(existing);
    if (problems.length > 0) {
      console.error(`✖ ${out} 校验失败：\n  - ${problems.join("\n  - ")}`);
      process.exit(1);
    }
    console.log(
      `✔ ${out} 校验通过（${SEED_TABLES.length} 张业务表，无口令哈希）`,
    );
    return;
  }

  const url = process.env.INPULSE_SEED_SOURCE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("缺少 INPULSE_SEED_SOURCE_URL（或 DATABASE_URL）");
    process.exit(1);
  }
  const pgDump = process.env.INPULSE_SEED_PG_DUMP ?? "pg_dump";
  const tableArgs = SEED_TABLES.flatMap((table) => ["-t", `app.${table}`]);
  const result = spawnSync(
    pgDump,
    [
      "--dbname",
      url,
      "--data-only",
      "--no-owner",
      "--no-acl",
      "--no-tablespaces",
      ...tableArgs,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) {
    console.error(`无法运行 pg_dump（${pgDump}）：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }

  const rendered = renderSeed(parseDump(result.stdout));
  const problems = validateSeed(rendered);
  if (problems.length > 0) {
    console.error(`✖ 导出结果校验失败：\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rendered, "utf8");
  console.log(`✔ 已写入 ${out}（${Buffer.byteLength(rendered)} 字节）`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
