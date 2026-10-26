#!/usr/bin/env node

/**
 * InPulse 本地 E2E 入口：一条命令跑通需要真实 PostgreSQL 的 `pnpm test:e2e`。
 *
 * 本脚本只解决本地两个易错点，不改变 CI 行为（CI 仍按技术设计 §12.4 自行准备）：
 *   1. E2E 夹具会**直接写进数据库**（AGENTS.md §8），指向演示库 `app` 会把演示数据写脏；
 *      本脚本默认指向独立测试库 `app_ci`，一旦解析出演示库就直接拒绝运行。
 *   2. 手工指定 `E2E_DATABASE_URL` 容易忘记；本脚本按「进程环境变量 > `--env-file`
 *      （默认 `deploy/.env.dev.local`）> 内置默认」解析后显式注入，并在跑测试前先对
 *      测试库执行一次 `pnpm db:migrate`（幂等，已就位时 0 applied）。
 *
 * E2E 自身用生产构建 + `vite preview`（端口默认 3100 / 4173），与本地 dev 的 3000 / 5173 不冲突。
 *
 * 用法：
 *   node scripts/test-e2e-local.mjs
 *   node scripts/test-e2e-local.mjs --skip-migrate
 *   node scripts/test-e2e-local.mjs --env-file path/to/.env.dev.local
 *   node scripts/test-e2e-local.mjs tests/audit.spec.ts    # 其余参数原样转发给 Playwright
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
} from "./local-postgres.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** AGENTS.md §8：E2E 夹具会直接写进数据库，禁止指向演示库 `app`。 */
const FORBIDDEN_DATABASE_NAME = "app";
const API_ENTRY = path.join(ROOT, "apps", "api", "dist", "main.js");

const USAGE = `InPulse 本地 E2E

  node scripts/test-e2e-local.mjs [选项] [Playwright 参数...]

选项：
  --skip-migrate      跳过测试库迁移补齐，直接跑测试
  --env-file <路径>   读取覆盖配置，默认 deploy/.env.dev.local
  -h, --help          显示本帮助

其它参数原样转发给 Playwright，例如传入 tests/audit.spec.ts 只跑单个 spec。
`;

function parseArguments(argv) {
  const options = {
    skipMigrate: false,
    envFile: path.join(ROOT, "deploy", ".env.dev.local"),
    playwrightArgs: [],
  };
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (passthrough) {
      options.playwrightArgs.push(argument);
    } else if (argument === "--") {
      passthrough = true;
    } else if (argument === "--skip-migrate") {
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
    } else if (argument.startsWith("-")) {
      throw new Error(
        `未知参数：${argument}（Playwright 参数请放在 \`--\` 之后）`,
      );
    } else {
      options.playwrightArgs.push(argument);
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

/** 解析 E2E 目标库并拒绝演示库：夹具会直接写进目标库，写进 `app` 会污染演示数据。 */
function resolveDatabaseName(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`E2E 数据库连接串不是合法 URL：${url}`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`E2E 数据库连接串必须是 postgresql://，收到：${url}`);
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (name.length === 0) {
    throw new Error(`E2E 数据库连接串缺少库名：${url}`);
  }
  if (name === FORBIDDEN_DATABASE_NAME) {
    throw new Error(
      `拒绝运行：E2E 夹具会直接写进数据库，禁止指向演示库 \`${FORBIDDEN_DATABASE_NAME}\`；` +
        "请使用独立测试库 app_ci（默认值），或显式设置 E2E_DATABASE_URL。",
    );
  }
  return name;
}

function quoteArgument(argument) {
  return argument.includes(" ") ? `"${argument}"` : argument;
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

function runCommand(commandLine, environment) {
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
  const defaultDatabaseUrl = localDatabaseUrl(
    "app_ci",
    resolveLocalPostgresPort(process.env, fileValues),
  );
  const e2eDatabaseUrl = pick(
    process.env,
    fileValues,
    "E2E_DATABASE_URL",
    pick(process.env, fileValues, "TEST_DATABASE_URL", defaultDatabaseUrl),
  );
  const databaseName = resolveDatabaseName(e2eDatabaseUrl);

  if (!existsSync(API_ENTRY)) {
    throw new Error(
      `找不到 ${API_ENTRY}；E2E 用生产构建启动 API，请先执行一次 \`pnpm build\`。`,
    );
  }

  const environment = { ...process.env };
  environment["E2E_DATABASE_URL"] = e2eDatabaseUrl;
  environment["MIGRATION_DATABASE_URL"] = pick(
    process.env,
    fileValues,
    "MIGRATION_DATABASE_URL",
    e2eDatabaseUrl,
  );

  console.log(`E2E 测试库：${e2eDatabaseUrl}（库名 ${databaseName}）`);
  console.log("（E2E 夹具会写进该库，禁止指向演示库 app）");

  const managed = await prepareManagedLocalDatabase({
    root: ROOT,
    databaseUrl: e2eDatabaseUrl,
    fileValues,
    environment: process.env,
    migrate: !options.skipMigrate,
  });
  if (managed !== null) {
    console.log(
      "本地原生 PostgreSQL 就绪：" +
        managed.dataDir +
        "（" +
        (managed.started ? "本次启动" : "复用已有实例") +
        "，库 " +
        managed.database +
        "）",
    );
    if (options.skipMigrate) {
      console.log("（--skip-migrate：未检查该库迁移是否已到 HEAD）");
    }
  } else {
    const probe = await probeDatabase(e2eDatabaseUrl);
    if (!probe.reachable) {
      throw new Error(
        "连不上测试库 " +
          probe.host +
          ":" +
          probe.port +
          "；请启动 PostgreSQL 18 + PGroonga（可用 POSTGRES_BIN 指向本机安装），" +
          "或设置 E2E_DATABASE_URL 指向独立测试库。",
      );
    }
    if (!options.skipMigrate) {
      console.log("\n== 补齐测试库迁移 ==");
      const migrateStatus = runCommand("pnpm db:migrate", environment);
      if (migrateStatus !== 0) {
        process.exitCode = migrateStatus;
        return;
      }
    }
  }

  const playwrightArgs = options.playwrightArgs.map(quoteArgument).join(" ");
  const command =
    "pnpm --filter @inpulse/e2e test:e2e" +
    (playwrightArgs.length > 0 ? ` ${playwrightArgs}` : "");
  console.log(`\n== ${command} ==`);
  process.exitCode = runCommand(command, environment);
}

main().catch((error) => {
  console.error(
    `[test-e2e-local] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
