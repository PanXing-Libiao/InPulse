#!/usr/bin/env node

/**
 * InPulse 本地集成测试入口：一条命令跑通需要真实 PostgreSQL 的 `pnpm test:integration`。
 *
 * 本脚本只解决两处「本地环境缺口」，不改变 CI 行为（CI 仍按技术设计 §12.4 自行准备）：
 *   1. 拉取到新迁移后独立测试库 `app_ci` 会滞后。database 集成里的「迁移幂等」用例要求
 *      测试库已迁到当前 HEAD，否则首次运行会把待应用迁移写进库并因此报红；本脚本在跑测试前
 *      先对测试库执行一次 `pnpm db:migrate`（幂等，已就位时 0 applied）。
 *   2. `apps/ops` 备份/恢复集成测试需要真实 `pg_dump`/`pg_restore`。本脚本按仓库既有的
 *      `POSTGRES_BIN`（已安装 PGroonga 的 PostgreSQL 18 bin 目录）注入
 *      `INPULSE_BACKUP_PG_DUMP` / `INPULSE_BACKUP_PG_RESTORE`。
 *
 * 不得把测试指向演示库 `app`：夹具会直接写进演示页面。默认指向 `app_ci`。
 *
 * 用法：
 *   node scripts/test-integration-local.mjs
 *   node scripts/test-integration-local.mjs --skip-migrate
 *   node scripts/test-integration-local.mjs --env-file path/to/.env.dev.local
 *
 * 取值优先级（与 scripts/dev-start.mjs 一致）：
 *   进程环境变量 > --env-file（默认 deploy/.env.dev.local，被 .gitignore 忽略）> 内置默认。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  localDatabaseUrl,
  prepareManagedLocalDatabase,
  resolveLocalPostgresPort,
  resolvePostgresBin,
} from "./local-postgres.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `InPulse 本地集成测试

  node scripts/test-integration-local.mjs [选项]

选项：
  --skip-migrate      跳过测试库迁移补齐，直接跑测试
  --env-file <路径>   读取覆盖配置，默认 deploy/.env.dev.local
  -h, --help          显示本帮助
`;

function parseArguments(argv) {
  const options = {
    skipMigrate: false,
    envFile: path.join(ROOT, "deploy", ".env.dev.local"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-migrate") {
      options.skipMigrate = true;
    } else if (argument === "--env-file") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--env-file 需要一个路径参数");
      }
      options.envFile = path.resolve(value);
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function readEnvFile(file) {
  const values = {};
  if (!existsSync(file)) {
    return values;
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      continue;
    }
    values[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return values;
}

function pick(environment, fileValues, key, fallback) {
  const fromProcess = environment[key]?.trim();
  if (fromProcess) {
    return fromProcess;
  }
  const fromFile = fileValues[key]?.trim();
  if (fromFile) {
    return fromFile;
  }
  return fallback;
}

function resolvePostgresBinForBackup(environment, fileValues) {
  try {
    return {
      dir: resolvePostgresBin(environment, fileValues),
      source: "PostgreSQL 18 检测",
    };
  } catch {
    return { dir: "", source: "未找到" };
  }
}

function probeDatabase(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port || "5432", 10);
    const socket = connect({ host: parsed.hostname, port });
    const done = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ reachable, host: parsed.hostname, port });
    };
    socket.setTimeout(3000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function runPnpm(commandLine, environment) {
  // 单条命令字符串 + shell，避免在 Windows 上把 .cmd 与参数数组混用（Node DEP0190 警告）。
  const result = spawnSync(commandLine, {
    cwd: ROOT,
    env: environment,
    shell: true,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help === true) {
    console.log(USAGE);
    return;
  }

  const fileValues = readEnvFile(options.envFile);
  const environment = { ...process.env };
  const defaultDatabaseUrl = localDatabaseUrl(
    "app_ci",
    resolveLocalPostgresPort(process.env, fileValues),
  );

  const testDatabaseUrl = pick(
    process.env,
    fileValues,
    "TEST_DATABASE_URL",
    defaultDatabaseUrl,
  );
  const migrationDatabaseUrl = pick(
    process.env,
    fileValues,
    "MIGRATION_DATABASE_URL",
    testDatabaseUrl,
  );
  environment["NODE_ENV"] = "test";
  environment["TEST_DATABASE_URL"] = testDatabaseUrl;
  environment["MIGRATION_DATABASE_URL"] = migrationDatabaseUrl;

  const postgresBin = resolvePostgresBinForBackup(process.env, fileValues);
  if (postgresBin.dir.length > 0) {
    const suffix = process.platform === "win32" ? ".exe" : "";
    environment["INPULSE_BACKUP_PG_DUMP"] = path.join(
      postgresBin.dir,
      `pg_dump${suffix}`,
    );
    environment["INPULSE_BACKUP_PG_RESTORE"] = path.join(
      postgresBin.dir,
      `pg_restore${suffix}`,
    );
  }

  console.log(`测试库：${testDatabaseUrl}`);
  console.log(
    `PostgreSQL 18 bin：${postgresBin.dir.length > 0 ? `${postgresBin.dir}（${postgresBin.source}）` : "未配置，pg_dump/pg_restore 回落到 PATH"}`,
  );

  const managed = await prepareManagedLocalDatabase({
    root: ROOT,
    databaseUrl: testDatabaseUrl,
    fileValues,
    environment: process.env,
    migrate: !options.skipMigrate,
  });
  if (managed !== null) {
    console.log(
      "本地原生 PostgreSQL 就绪：" +
        managed.dataDir +
        "（库 " +
        managed.database +
        "）",
    );
  } else {
    const probe = await probeDatabase(testDatabaseUrl);
    if (!probe.reachable) {
      throw new Error(
        "连不上测试库 " +
          probe.host +
          ":" +
          probe.port +
          "；请启动 PostgreSQL 18 + PGroonga（可用 POSTGRES_BIN 指向本机安装），" +
          "或设置 TEST_DATABASE_URL 指向独立测试库。",
      );
    }
    if (!options.skipMigrate) {
      console.log("\n== 补齐测试库迁移 ==");
      const migrateStatus = runPnpm("pnpm db:migrate", environment);
      if (migrateStatus !== 0) {
        process.exitCode = migrateStatus;
        return;
      }
    }
  }

  console.log("\n== pnpm test:integration ==");
  process.exitCode = runPnpm("pnpm test:integration", environment);
}

main().catch((error) => {
  console.error(
    `[test-integration-local] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
