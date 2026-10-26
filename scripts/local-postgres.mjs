#!/usr/bin/env node

/**
 * 本地原生 PostgreSQL 18 + PGroonga 管理。
 *
 * 公司环境不允许 Docker Desktop，本地开发、集成测试与 E2E 统一复用这里管理的
 * loopback 原生集群。默认数据目录为 .data/pg-dev，默认端口 55432；生产/CI
 * 仍各自准备数据库，不受本模块影响。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

export const LOCAL_DB_PORT = 55432;
export const LOCAL_DB_ADMIN_USER = "cluster_bootstrap";
export const LOCAL_DB_DEFAULT_DATA_DIR = ".data/pg-dev";

export function resolveLocalPostgresPort(
  environment = process.env,
  fileValues = {},
) {
  const value =
    (environment.INPULSE_LOCAL_PG_PORT ?? "").trim() ||
    (fileValues.INPULSE_LOCAL_PG_PORT ?? "").trim();
  if (value.length === 0) {
    return LOCAL_DB_PORT;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("INPULSE_LOCAL_PG_PORT 必须是整数端口：" + value);
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    throw new Error("INPULSE_LOCAL_PG_PORT 超出 1-65535：" + value);
  }
  return port;
}

const REQUIRED_PROGRAMS = [
  "initdb",
  "pg_ctl",
  "createdb",
  "psql",
  "pg_isready",
  "postgres",
];

function executableName(name) {
  return process.platform === "win32" ? name + ".exe" : name;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function hasRequiredPrograms(directory) {
  return REQUIRED_PROGRAMS.every((name) =>
    existsSync(path.join(directory, executableName(name))),
  );
}

function postgresMajorVersion(bin) {
  const result = capture(path.join(bin, executableName("postgres")), [
    "--version",
  ]);
  if (result.status !== 0) {
    return undefined;
  }
  const match = /PostgreSQL\)?\s+(\d+)\./.exec(result.stdout);
  return match === undefined ? undefined : Number.parseInt(match[1], 10);
}

function candidatePostgresBins() {
  if (process.platform === "win32") {
    return [
      "D:\\PostgreSQL\\18\\pgsql\\bin",
      "C:\\Program Files\\PostgreSQL\\18\\bin",
      "C:\\Program Files\\PostgreSQL\\18\\pgsql\\bin",
    ];
  }
  return ["/usr/lib/postgresql/18/bin", "/usr/local/pgsql/bin"];
}

/**
 * 解析 PostgreSQL 18 bin 目录。优先级：显式参数/环境变量 > 常见安装位置 >
 * pg_config > PATH。找不到或不满足 18.x 时直接失败，不回退 Docker。
 */
export function resolvePostgresBin(environment = process.env, fileValues = {}) {
  const environmentBin = (environment.POSTGRES_BIN ?? "").trim();
  const fileBin = (fileValues.POSTGRES_BIN ?? "").trim();
  const configured = environmentBin.length > 0 ? environmentBin : fileBin;
  const candidates = [];
  if (configured.length > 0) {
    candidates.push(path.resolve(configured));
  }
  candidates.push(...candidatePostgresBins());

  const pgConfig = capture("pg_config", ["--bindir"]);
  if (pgConfig.status === 0 && pgConfig.stdout.trim().length > 0) {
    candidates.push(pgConfig.stdout.trim());
  }

  const lookup = process.platform === "win32" ? "where" : "which";
  const onPath = capture(lookup, ["pg_ctl"]);
  if (onPath.status === 0) {
    const first = onPath.stdout.split(/\r?\n/).find((line) => line.trim());
    if (first !== undefined) {
      candidates.push(path.dirname(first.trim()));
    }
  }

  const checked = new Set();
  for (const rawCandidate of candidates) {
    const candidate = path.resolve(rawCandidate);
    if (checked.has(candidate) || !existsSync(candidate)) {
      continue;
    }
    checked.add(candidate);
    if (!hasRequiredPrograms(candidate)) {
      continue;
    }
    const major = postgresMajorVersion(candidate);
    if (major === 18) {
      return candidate;
    }
  }

  throw new Error(
    "未找到 PostgreSQL 18 + PGroonga 的安装目录。请安装 PostgreSQL 18，设置 POSTGRES_BIN 指向其 bin 目录；" +
      "本地不要求 Docker Desktop。已检查：" +
      [...checked].join("、"),
  );
}

function postgresProgram(bin, name) {
  return path.join(bin, executableName(name));
}

function runPostgresProgram(bin, name, args, options = {}) {
  return spawnSync(postgresProgram(bin, name), args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
  });
}

function assertSuccess(result, label) {
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    throw new Error(label + "失败" + (detail.length > 0 ? "：" + detail : ""));
  }
}

function pgIsReady(bin, port) {
  return (
    runPostgresProgram(bin, "pg_isready", [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-q",
    ]).status === 0
  );
}

function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPostgres(bin, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pgIsReady(bin, port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "本地 PostgreSQL 未在 " +
      timeoutMs / 1000 +
      " 秒内就绪；请检查数据目录日志。",
  );
}

/**
 * 启动（必要时初始化）原生开发集群。现有 .data/pg-dev 会被原样复用。
 */
export async function ensureLocalPostgres(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const environment = options.environment ?? process.env;
  const fileValues = options.fileValues ?? {};
  const bin = resolvePostgresBin(environment, fileValues);
  const configuredDataDir =
    (environment.INPULSE_LOCAL_PG_DATA ?? "").trim() ||
    (fileValues.INPULSE_LOCAL_PG_DATA ?? "").trim() ||
    LOCAL_DB_DEFAULT_DATA_DIR;
  const dataDir = path.resolve(root, configuredDataDir);
  const port =
    options.port ?? resolveLocalPostgresPort(environment, fileValues);
  const logDir = options.logDir ?? path.join(root, ".data", "dev");
  const logFile = path.join(logDir, "postgresql.log");
  mkdirSync(logDir, { recursive: true });

  const status = runPostgresProgram(bin, "pg_ctl", ["-D", dataDir, "status"]);
  const running = status.status === 0;
  const ready = pgIsReady(bin, port);

  if (running && ready) {
    return { bin, dataDir, port, started: false };
  }
  if (running && !ready) {
    throw new Error(
      "数据目录 " +
        dataDir +
        " 中的 PostgreSQL 已运行，但 " +
        port +
        " 端口不可用；请检查是否以不同端口启动，或先执行 pg_ctl -D <数据目录> stop。",
    );
  }
  if (!running && (await portIsListening(port))) {
    throw new Error(
      "127.0.0.1:" +
        port +
        " 已被其它进程占用，但 " +
        dataDir +
        " 未运行。请先停止旧的 Docker 容器或其它 PostgreSQL 实例；本项目本地开发不再启动 Docker。",
    );
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    const entries = readdirSync(dataDir);
    if (entries.length > 0) {
      throw new Error(
        "目录 " +
          dataDir +
          " 非空但不是有效的 PostgreSQL 数据目录；拒绝覆盖。请清理该目录或设置 INPULSE_LOCAL_PG_DATA。",
      );
    }
    const initialized = runPostgresProgram(
      bin,
      "initdb",
      [
        "-D",
        dataDir,
        "--username=" + LOCAL_DB_ADMIN_USER,
        "--encoding=UTF8",
        "--locale=C",
        "--auth=trust",
      ],
      { stdio: "inherit" },
    );
    assertSuccess(initialized, "初始化本地 PostgreSQL");
  }

  const serverOptions = "-p " + port + " -h 127.0.0.1 -c max_connections=150";
  const started = runPostgresProgram(
    bin,
    "pg_ctl",
    ["-D", dataDir, "-l", logFile, "-o", serverOptions, "-w", "start"],
    { stdio: "inherit" },
  );
  assertSuccess(started, "启动本地 PostgreSQL");
  await waitForPostgres(bin, port, 30_000);
  return { bin, dataDir, port, started: true };
}

export function databaseNameFromUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("数据库连接串不是合法 URL：" + databaseUrl);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("数据库连接串必须是 postgresql://，收到：" + databaseUrl);
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (name.length === 0) {
    throw new Error("数据库连接串缺少库名：" + databaseUrl);
  }
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error("数据库名只允许字母、数字和下划线：" + name);
  }
  return name;
}

export function isManagedLocalDatabaseUrl(databaseUrl, port = LOCAL_DB_PORT) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return false;
  }
  return (
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === String(port)
  );
}

export function localDatabaseUrl(
  database,
  port = LOCAL_DB_PORT,
  role = LOCAL_DB_ADMIN_USER,
) {
  return "postgresql://" + role + "@127.0.0.1:" + port + "/" + database;
}

function psql(bin, port, database, args) {
  return runPostgresProgram(bin, "psql", [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    LOCAL_DB_ADMIN_USER,
    "-d",
    database,
    ...args,
  ]);
}

function queryScalar(bin, port, database, sql) {
  const result = psql(bin, port, database, ["-Atc", sql]);
  assertSuccess(result, "查询本地 PostgreSQL");
  return result.stdout.trim();
}

function ensureDatabaseExists(bin, port, database) {
  const databases = queryScalar(
    bin,
    port,
    "postgres",
    "SELECT datname FROM pg_database WHERE datistemplate = false",
  ).split(/\r?\n/);
  if (databases.includes(database)) {
    return false;
  }
  const created = runPostgresProgram(bin, "createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    LOCAL_DB_ADMIN_USER,
    "-T",
    "template0",
    "-E",
    "UTF8",
    database,
  ]);
  assertSuccess(created, "创建本地数据库 " + database);
  return true;
}

function bootstrapDatabase({ root, bin, port, database }) {
  const available = queryScalar(
    bin,
    port,
    database,
    "SELECT count(*)::INTEGER FROM pg_available_extensions WHERE name = $$pgroonga$$",
  );
  if (available !== "1") {
    throw new Error(
      "PostgreSQL 18 未安装 PGroonga 扩展；请安装与本机 PostgreSQL 18 版本匹配的 PGroonga，" +
        "然后重试。本地不依赖 Docker Desktop。",
    );
  }

  const state = queryScalar(
    bin,
    port,
    database,
    "SELECT " +
      "(EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $$app$$))::INTEGER || $$|$$ || " +
      "(EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $$app_owner$$))::INTEGER || $$|$$ || " +
      "(EXISTS (SELECT 1 FROM pg_extension WHERE extname = $$pgroonga$$))::INTEGER",
  ).split("|");
  const hasSchema = state[0] === "1";
  const hasOwner = state[1] === "1";
  const hasPgRoonga = state[2] === "1";
  if (hasSchema && !hasOwner) {
    throw new Error(
      "数据库 " +
        database +
        " 已存在 app schema，但缺少 app_owner；拒绝猜测并修改既有库。",
    );
  }

  if (!hasSchema) {
    const roles = psql(bin, port, database, [
      "-f",
      path.join(root, "database", "bootstrap", "000_roles.sql"),
    ]);
    assertSuccess(roles, "执行 database/bootstrap/000_roles.sql");
  }
  if (!hasPgRoonga) {
    const pgroonga = psql(bin, port, database, [
      "-f",
      path.join(root, "database", "bootstrap", "020_pgroonga.sql"),
    ]);
    assertSuccess(pgroonga, "执行 database/bootstrap/020_pgroonga.sql");
  }
}

/**
 * 确保某个本地库存在并完成角色/PGroonga bootstrap。可重复调用；已有库不会
 * 重跑 000_roles.sql，避免把迁移 0005 已删除的 pg_trgm 扩展重新加回来。
 */
export function ensureLocalDatabase(options) {
  const root = path.resolve(options.root ?? process.cwd());
  const database = options.database;
  const port = options.port ?? LOCAL_DB_PORT;
  const bin =
    options.bin ??
    resolvePostgresBin(
      options.environment ?? process.env,
      options.fileValues ?? {},
    );
  const created = ensureDatabaseExists(bin, port, database);
  bootstrapDatabase({ root, bin, port, database });
  return { bin, port, database, created };
}

export function runMigrations({
  root,
  databaseUrl,
  environment = process.env,
}) {
  const result = spawnSync("pnpm db:migrate", {
    cwd: root,
    env: { ...environment, MIGRATION_DATABASE_URL: databaseUrl },
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      "pnpm db:migrate 失败（exit " + (result.status ?? 1) + "）",
    );
  }
}

/**
 * 一站式准备：仅当连接串指向受管理的本地默认端口时启动原生集群。
 * 外部数据库只返回 null，由调用方按原流程探测。
 */
export async function prepareManagedLocalDatabase(options) {
  const databaseUrl = options.databaseUrl;
  const expectedPort = resolveLocalPostgresPort(
    options.environment ?? process.env,
    options.fileValues ?? {},
  );
  if (!isManagedLocalDatabaseUrl(databaseUrl, expectedPort)) {
    return null;
  }
  const root = path.resolve(options.root ?? process.cwd());
  const database = databaseNameFromUrl(databaseUrl);
  const cluster = await ensureLocalPostgres({
    root,
    environment: options.environment,
    fileValues: options.fileValues,
  });
  const ensured = ensureLocalDatabase({
    root,
    database,
    port: cluster.port,
    bin: cluster.bin,
  });
  if (options.migrate !== false) {
    console.log("[local-postgres] 应用迁移到 " + database + " ...");
    runMigrations({
      root,
      databaseUrl: localDatabaseUrl(database, cluster.port, "app_migrator"),
      environment: options.environment,
    });
  }
  return { ...cluster, ...ensured, database };
}
