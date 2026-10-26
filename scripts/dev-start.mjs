#!/usr/bin/env node

/**
 * InPulse 本地开发启动：检查 PostgreSQL -> 构建 API -> 启动 API（可选 Casdoor SSO）-> 启动 Vite。
 *
 * 统一身份认证（ADR-032）配置来源，按优先级：
 *   1. 当前进程环境变量 SSO_ISSUER / SSO_CLIENT_ID / SSO_CLIENT_SECRET_FILE / SSO_REDIRECT_URI；
 *   2. --env-file 指定的配置文件（默认 deploy/.env.dev.local，被 .gitignore 忽略）。
 * 两者都拿不到完整配置时，按 fail closed 以本地口令登录启动，并在结束时打印启用方法。
 *
 * 本脚本只服务本地开发，不参与 CI 门禁；生产部署走 deploy/compose.yaml。
 *
 * 用法：
 *   node scripts/dev-start.mjs
 *   node scripts/dev-start.mjs --skip-build
 *   node scripts/dev-start.mjs --local-only
 *   node scripts/dev-start.mjs --env-file path/to/.env.dev.local
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { domainToASCII, fileURLToPath } from "node:url";
import {
  localDatabaseUrl,
  prepareManagedLocalDatabase,
  resolveLocalPostgresPort,
} from "./local-postgres.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, ".data");
const LOG_DIR = path.join(DATA_DIR, "dev");
const KEYRING_DIR = path.join(DATA_DIR, "keyrings");
const API_PORT = 3000;
const WEB_PORT = 5173;
const WEB_HOST = "127.0.0.1";
const WEB_ORIGIN = "http://" + WEB_HOST + ":" + WEB_PORT;
const LAN_CERT_DIR = path.join(DATA_DIR, "dev-certs");
const SSO_KEYS = [
  "SSO_ISSUER",
  "SSO_CLIENT_ID",
  "SSO_CLIENT_SECRET_FILE",
  "SSO_REDIRECT_URI",
];

const USAGE = `InPulse 本地开发启动

  node scripts/dev-start.mjs [选项]

选项：
  --skip-build        跳过 API 构建（dist 已是最新时使用）
  --local-only        强制关闭统一身份认证，按本地口令登录启动
  --lan               让同一局域网的设备以 HTTPS 访问（自签证书存放在 .data/dev-certs）
  --env-file <路径>   统一身份认证配置文件，默认 deploy/.env.dev.local
  -h, --help          显示本帮助`;

function parseArguments(argv) {
  const options = {
    skipBuild: false,
    localOnly: false,
    lan: false,
    help: false,
    envFile: path.join(ROOT, "deploy", ".env.dev.local"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-build") {
      options.skipBuild = true;
    } else if (argument === "--local-only") {
      options.localOnly = true;
    } else if (argument === "--lan") {
      options.lan = true;
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

function resolveSso(options, fileValues) {
  if (options.localOnly) {
    return { enabled: false, reason: "已通过 --local-only 关闭" };
  }
  const flag = (process.env["SSO_ENABLED"] ?? fileValues["SSO_ENABLED"] ?? "")
    .trim()
    .toLowerCase();
  if (flag === "0" || flag === "false") {
    return { enabled: false, reason: "配置中 SSO_ENABLED 为假值" };
  }
  const values = {};
  const missing = [];
  for (const key of SSO_KEYS) {
    const value = (process.env[key] ?? fileValues[key] ?? "").trim();
    values[key] = value;
    if (value.length === 0) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return { enabled: false, reason: `${missing.join("、")} 未配置` };
  }
  if (!existsSync(values["SSO_CLIENT_SECRET_FILE"])) {
    return {
      enabled: false,
      reason: `Secret 文件不存在：${values["SSO_CLIENT_SECRET_FILE"]}`,
    };
  }
  return { enabled: true, values };
}

function ensureKeyrings() {
  mkdirSync(KEYRING_DIR, { recursive: true });
  const created = [];
  for (const name of [
    "session.keyring",
    "idempotency.keyring",
    "audit.keyring",
    "ai-assist-encryption.keyring",
    "wecom-robot-encryption.keyring",
  ]) {
    const target = path.join(KEYRING_DIR, name);
    if (existsSync(target)) {
      continue;
    }
    writeFileSync(target, `1:${randomBytes(32).toString("hex")}\n`, "utf8");
    created.push(name);
  }
  return created;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function runPnpm(commandLine) {
  // 用单条命令字符串配合 shell，避免在 Windows 上把 .cmd 与参数数组混用（Node DEP0190 警告）。
  const result = spawnSync(commandLine, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`${commandLine} 失败，退出码 ${result.status}`);
  }
}

/** 本机可用于局域网访问的 IPv4 地址，私网网段优先，并带接口名便于识别虚拟网卡。 */
function listLanAddresses() {
  const entries = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        entries.push({ name, address: address.address });
      }
    }
  }
  const priority = (entry) => {
    const value = entry.address;
    if (value.startsWith("192.168.")) {
      return 0;
    }
    if (value.startsWith("10.")) {
      return 1;
    }
    const match = /^172\.(\d{1,2})\./.exec(value);
    const second = match === null ? 0 : Number.parseInt(match[1], 10);
    return second >= 16 && second <= 31 ? 2 : 3;
  };
  return entries.sort((left, right) => priority(left) - priority(right));
}

function findOpenssl() {
  const configured = process.env["INPULSE_OPENSSL"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!existsSync(configured)) {
      throw new Error("INPULSE_OPENSSL 指向的文件不存在：" + configured);
    }
    return configured;
  }
  if (capture("openssl", ["version"]).status === 0) {
    return "openssl";
  }
  const lookup = process.platform === "win32" ? "where" : "which";
  const gitPath = capture(lookup, ["git"]).stdout.split(/\r?\n/)[0]?.trim();
  if (gitPath !== undefined && gitPath.length > 0) {
    const installRoot = path.resolve(path.dirname(gitPath), "..");
    for (const candidate of [
      path.join(installRoot, "usr", "bin", "openssl.exe"),
      path.join(installRoot, "mingw64", "bin", "openssl.exe"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** 生成 openssl req 配置：SAN 覆盖 localhost、loopback、主机名与局域网 IPv4。 */
function buildOpensslConfig(names) {
  const subjectAltName = names
    .map((name) => (isIP(name) === 0 ? "DNS:" : "IP:") + name)
    .join(",");
  return [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "x509_extensions = ext",
    "",
    "[dn]",
    "CN = InPulse LAN Dev",
    "",
    "[ext]",
    "basicConstraints = CA:FALSE",
    "keyUsage = digitalSignature,keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = " + subjectAltName,
    "",
  ].join("\n");
}

/**
 * 局域网模式的自签证书：SAN 必须覆盖当前地址，地址变化（DHCP）时重新生成；
 * 证书与私钥只落在被 .gitignore 忽略的 .data/dev-certs，不进入版本库。
 */
function ensureLanCertificate(entries) {
  const openssl = findOpenssl();
  if (openssl === undefined) {
    throw new Error(
      "未找到 openssl，无法生成局域网自签证书；可安装 Git for Windows（自带 openssl），或用 INPULSE_OPENSSL 指定可执行文件路径。",
    );
  }
  const machineName = domainToASCII(hostname());
  const names = Array.from(
    new Set(
      ["localhost", "127.0.0.1", machineName]
        .concat(entries.map((entry) => entry.address))
        .filter((name) => name.length > 0),
    ),
  ).sort();
  mkdirSync(LAN_CERT_DIR, { recursive: true });
  const keyFile = path.join(LAN_CERT_DIR, "lan-key.pem");
  const certFile = path.join(LAN_CERT_DIR, "lan-cert.pem");
  const configFile = path.join(LAN_CERT_DIR, "lan-openssl.cnf");
  const metaFile = path.join(LAN_CERT_DIR, "lan-hosts.json");
  let reusable = false;
  if (existsSync(keyFile) && existsSync(certFile) && existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8"));
      reusable =
        Array.isArray(meta.names) &&
        meta.names.length === names.length &&
        meta.names.every((value, index) => value === names[index]);
    } catch {
      reusable = false;
    }
    if (reusable) {
      const check = capture(openssl, [
        "x509",
        "-in",
        certFile,
        "-noout",
        "-checkend",
        String(30 * 24 * 60 * 60),
      ]);
      reusable = check.status === 0;
    }
  }
  if (!reusable) {
    writeFileSync(configFile, buildOpensslConfig(names), "utf8");
    const result = spawnSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "825",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-config",
        configFile,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        "openssl 生成自签证书失败：" + (result.stderr ?? "").trim(),
      );
    }
    writeFileSync(
      metaFile,
      JSON.stringify(
        { names, generatedAt: new Date().toISOString() },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  return { certFile, keyFile, names };
}

function relativeToRoot(target) {
  return path.relative(ROOT, target).split(path.sep).join("/");
}

function readConfiguredValue(fileValues, key, fallback) {
  const fromProcess = process.env[key]?.trim();
  if (fromProcess) {
    return fromProcess;
  }
  const fromFile = fileValues[key]?.trim();
  if (fromFile) {
    return fromFile;
  }
  return fallback;
}

function resolveDefaultDatabaseUrl(fileValues, role) {
  return localDatabaseUrl(
    "app",
    resolveLocalPostgresPort(process.env, fileValues),
    role,
  );
}

function resolveRuntimeDatabaseUrl(fileValues) {
  return readConfiguredValue(
    fileValues,
    "DATABASE_URL",
    resolveDefaultDatabaseUrl(fileValues, "app_runtime"),
  );
}

async function ensureDatabase(fileValues) {
  console.log("[1/4] 准备本地原生 PostgreSQL ...");
  const databaseUrl = resolveRuntimeDatabaseUrl(fileValues);
  const managed = await prepareManagedLocalDatabase({
    root: ROOT,
    databaseUrl,
    fileValues,
    environment: process.env,
    migrate: true,
  });
  if (managed !== null) {
    console.log(
      "  就绪：127.0.0.1:" +
        managed.port +
        "（原生数据目录 " +
        relativeToRoot(managed.dataDir) +
        "）",
    );
    console.log("  迁移：" + managed.database + " 已是最新");
    return {
      port: managed.port,
      summary:
        "原生 PostgreSQL 18 / PGroonga（127.0.0.1:" + managed.port + "）",
    };
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL 不是合法 URL；无法启动 API。");
  }
  const database = parsed.pathname.replace(/^\//, "") || "app";
  console.log(
    "  使用外部数据库：" +
      parsed.host +
      "/" +
      database +
      "（不启动本机集群，迁移由外部环境负责）",
  );
  return {
    port: parsed.port || "5432",
    summary: "外部 " + parsed.host + "/" + database,
  };
}

function buildApi(skipBuild) {
  console.log("[2/4] 构建 API ...");
  if (skipBuild) {
    console.log("  已跳过（--skip-build）");
    return;
  }
  // API 运行时按 package exports 从 workspace 依赖的 dist 解析（如
  // @inpulse/api-contract）；只构建 apps/api 会让这些包停留在旧产物，
  // 出现「响应契约校验失败」等假故障，因此连同依赖一起构建。
  runPnpm("pnpm --filter @inpulse/api... build");
  console.log("  构建完成：apps/api 及其 workspace 依赖的 dist");
}

function stopPortOwner(port) {
  const pids = new Set();
  if (process.platform === "win32") {
    const output = capture("netstat", ["-ano", "-p", "tcp"]).stdout;
    for (const line of output.split(/\r?\n/)) {
      const match = line
        .trim()
        .match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (match && Number(match[1]) === port) {
        pids.add(match[2]);
      }
    }
    for (const pid of pids) {
      spawnSync("taskkill", ["/pid", pid, "/t", "/f"], { stdio: "ignore" });
    }
  } else {
    const output = capture("lsof", [
      "-ti",
      `tcp:${port}`,
      "-sTCP:LISTEN",
    ]).stdout;
    for (const pid of output.split(/\s+/).filter(Boolean)) {
      pids.add(pid);
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        pids.delete(pid);
      }
    }
  }
  return pids.size;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function waitForPort(port, name, logFile, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await delay(500);
  }
  throw new Error(
    `${name} 未在 ${timeoutMs / 1000} 秒内监听 ${port}，请查看 ${relativeToRoot(logFile)}。`,
  );
}

function buildApiEnvironment(fileValues, sso, runtime) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(API_PORT),
    DATABASE_URL: resolveRuntimeDatabaseUrl(fileValues),
    AUDIT_DATABASE_URL: readConfiguredValue(
      fileValues,
      "AUDIT_DATABASE_URL",
      resolveDefaultDatabaseUrl(fileValues, "audit_reader"),
    ),
    SESSION_HASH_KEYRING_FILE: path.join(KEYRING_DIR, "session.keyring"),
    SESSION_HASH_KEYRING_TEST_PATH: "1",
    SESSION_HASH_KEY_VERSION: "1",
    IDEMPOTENCY_FINGERPRINT_KEYRING_FILE: path.join(
      KEYRING_DIR,
      "idempotency.keyring",
    ),
    IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH: "1",
    IDEMPOTENCY_FINGERPRINT_KEY_VERSION: "1",
    AUDIT_HMAC_KEYRING_FILE: path.join(KEYRING_DIR, "audit.keyring"),
    AUDIT_HMAC_KEYRING_TEST_PATH: "1",
    AUDIT_HMAC_KEY_VERSION: "1",
    AI_ASSIST_ENCRYPTION_KEY_FILE: path.join(
      KEYRING_DIR,
      "ai-assist-encryption.keyring",
    ),
    AI_ASSIST_ENCRYPTION_KEY_TEST_PATH: "1",
    AI_ASSIST_ENCRYPTION_KEY_VERSION: "1",
    WECOM_ROBOT_ENCRYPTION_KEY_FILE: path.join(
      KEYRING_DIR,
      "wecom-robot-encryption.keyring",
    ),
    WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH: "1",
    WECOM_ROBOT_ENCRYPTION_KEY_VERSION: "1",
  };
  if (runtime.apiHost !== undefined) {
    env["INPULSE_API_HOST"] = runtime.apiHost;
  }
  // 清掉继承来的 SSO 变量，避免与本次解析结果混用。
  for (const key of [
    ...SSO_KEYS,
    "SSO_ENABLED",
    "SSO_CLIENT_SECRET_TEST_PATH",
  ]) {
    delete env[key];
  }
  if (!sso.enabled) {
    return env;
  }
  env["SSO_ENABLED"] = "1";
  env["SSO_ISSUER"] = sso.values["SSO_ISSUER"];
  env["SSO_CLIENT_ID"] = sso.values["SSO_CLIENT_ID"];
  env["SSO_CLIENT_SECRET_FILE"] = sso.values["SSO_CLIENT_SECRET_FILE"];
  env["SSO_REDIRECT_URI"] =
    sso.values["SSO_REDIRECT_URI"] ||
    runtime.webOrigin + "/api/v1/auth/sso/callback";
  // 本地 Secret 位于 /run/secrets 之外，按仓库规则只允许 NODE_ENV=test 加该开关读取（技术设计 §7）。
  env["SSO_CLIENT_SECRET_TEST_PATH"] = "1";
  return env;
}

function spawnBackground(command, args, options) {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(path.join(LOG_DIR, `${options.name}.out.log`), "a");
  const err = openSync(path.join(LOG_DIR, `${options.name}.err.log`), "a");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  return child.pid ?? 0;
}

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    // 局域网模式探测的是本机自签证书入口，本机探测按设计跳过证书校验。
    const secure = url.startsWith("https://");
    const client = secure ? httpsRequest : request;
    const options = secure
      ? { method: "GET", rejectUnauthorized: false }
      : { method: "GET" };
    const req = client(url, options, (res) => {
      res.resume();
      resolve({
        status: res.statusCode ?? 0,
        location: res.headers.location ?? "",
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function verifySso(issuer, webOrigin) {
  try {
    const response = await requestOnce(webOrigin + "/api/v1/auth/sso/start");
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.location.startsWith(issuer)
    ) {
      return `SSO 已启用 -> ${issuer}`;
    }
    return `SSO 未生效：/api/v1/auth/sso/start 返回 ${response.status} ${response.location}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `SSO 状态未知（探测失败：${message}）`;
  }
}

function printSsoGuidance(reason, webOrigin) {
  const callbackUrl = webOrigin + "/api/v1/auth/sso/callback";
  console.log("");
  console.log("提示：SSO 未启用（" + reason + "）。启用步骤：");
  console.log(
    "  1. 复制 deploy/.env.dev.example 为 deploy/.env.dev.local（该文件名被 .gitignore 忽略）；",
  );
  console.log(
    "  2. 填入 Casdoor 应用签发的 SSO_CLIENT_ID 与 Client Secret 文件的绝对路径；",
  );
  console.log("  3. 在 Casdoor 应用中登记回调地址 " + callbackUrl + "；");
  console.log("  4. 重新运行 node scripts/dev-start.mjs。");
}

function printLanGuidance(certificate) {
  console.log("");
  console.log("局域网访问说明（--lan）：");
  console.log(
    "  1. 其他设备首次访问会提示证书不受信任，点击「高级」->「继续前往」即可；",
  );
  console.log("     如需消除警告，可把自签证书导入访问设备的受信任根证书：");
  console.log("     " + certificate.certFile);
  console.log(
    "  2. Windows 首次共享需以管理员身份放行 TCP " + WEB_PORT + " 入站：",
  );
  console.log(
    '     netsh advfirewall firewall add rule name="InPulse Dev" ' +
      "dir=in action=allow protocol=TCP localport=" +
      WEB_PORT,
  );
  console.log(
    "  3. 局域网地址随 DHCP 变化，以本次输出为准；重启脚本会自动重建证书。",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  mkdirSync(LOG_DIR, { recursive: true });

  const fileValues = readEnvFile(options.envFile);
  const sso = resolveSso(options, fileValues);
  if (existsSync(options.envFile)) {
    console.log(`配置来源：${relativeToRoot(options.envFile)}`);
  }

  const createdKeyrings = ensureKeyrings();
  if (createdKeyrings.length > 0) {
    console.log(`已为本地开发生成 keyring：${createdKeyrings.join("、")}`);
  }

  const lanAddresses = options.lan ? listLanAddresses() : [];
  const lanCertificate = options.lan
    ? ensureLanCertificate(lanAddresses)
    : undefined;
  const webOrigin = options.lan
    ? "https://" + WEB_HOST + ":" + WEB_PORT
    : WEB_ORIGIN;
  const runtime = {
    webOrigin,
    apiHost: options.lan ? WEB_HOST : undefined,
  };
  const ssoRedirectUri = sso.enabled
    ? sso.values["SSO_REDIRECT_URI"] || webOrigin + "/api/v1/auth/sso/callback"
    : undefined;
  if (lanCertificate !== undefined) {
    console.log(
      "局域网证书就绪：" +
        relativeToRoot(lanCertificate.certFile) +
        "（SAN：" +
        lanCertificate.names.join("、") +
        "）",
    );
  }

  const database = await ensureDatabase(fileValues);
  buildApi(options.skipBuild);

  console.log("[3/4] 启动 API ...");
  const stoppedApi = stopPortOwner(API_PORT);
  if (stoppedApi > 0) {
    console.log(`  已停止占用 ${API_PORT} 的旧进程（${stoppedApi} 个）`);
  }
  const apiPid = spawnBackground(
    process.execPath,
    ["--enable-source-maps", "dist/main.js"],
    {
      name: "api",
      cwd: path.join(ROOT, "apps", "api"),
      env: buildApiEnvironment(fileValues, sso, runtime),
    },
  );
  await waitForPort(API_PORT, "API", path.join(LOG_DIR, "api.err.log"));
  console.log(`  就绪：http://127.0.0.1:${API_PORT}（PID ${apiPid}）`);

  console.log("[4/4] 启动 Vite ...");
  const stoppedWeb = stopPortOwner(WEB_PORT);
  if (stoppedWeb > 0) {
    console.log(`  已停止占用 ${WEB_PORT} 的旧进程（${stoppedWeb} 个）`);
  }
  const webEnvironment = {
    ...process.env,
    INPULSE_WEB_CSP: "report-only",
  };
  if (lanCertificate !== undefined) {
    webEnvironment["VITE_DEV_HTTPS_CERT"] = lanCertificate.certFile;
    webEnvironment["VITE_DEV_HTTPS_KEY"] = lanCertificate.keyFile;
  }
  const webPid = spawnBackground(
    process.execPath,
    [
      path.join(ROOT, "apps", "web", "node_modules", "vite", "bin", "vite.js"),
      "--host",
      options.lan ? "0.0.0.0" : WEB_HOST,
      "--strictPort",
    ],
    {
      name: "web",
      cwd: path.join(ROOT, "apps", "web"),
      env: webEnvironment,
    },
  );
  await waitForPort(WEB_PORT, "Vite", path.join(LOG_DIR, "web.err.log"));
  console.log(`  就绪：${webOrigin}（PID ${webPid}）`);

  const ssoSummary = sso.enabled
    ? await verifySso(sso.values["SSO_ISSUER"], webOrigin)
    : "本地口令登录（SSO 已关闭）";

  console.log("");
  console.log("启动完成");
  console.log("  前端:        " + webOrigin);
  if (options.lan) {
    for (const entry of lanAddresses) {
      console.log(
        "  局域网:      https://" +
          entry.address +
          ":" +
          WEB_PORT +
          "（" +
          entry.name +
          "）",
      );
    }
  }
  console.log(
    "  健康检查:    http://127.0.0.1:" + API_PORT + "/api/v1/health/ready",
  );
  console.log("  数据库:      " + database.summary);
  console.log("  登录方式:    " + ssoSummary);
  console.log("  本地应急入口: " + webOrigin + "/login?local=1");
  console.log("  日志:        " + relativeToRoot(LOG_DIR));
  console.log("  进程:        API " + apiPid + " / Web " + webPid);

  if (options.lan && lanAddresses.length === 0) {
    console.log(
      "  提示:        未检测到局域网 IPv4 地址，其他设备暂时无法访问。",
    );
  }
  if (options.lan && sso.enabled && ssoRedirectUri !== undefined) {
    console.log("  SSO 回调:    " + ssoRedirectUri);
    console.log(
      "               局域网设备要用 SSO 需把 SSO_REDIRECT_URI 换成局域网地址并在 Casdoor 登记，",
    );
    console.log(
      "               改动后本机同样改用该地址访问；未登记时局域网设备请用本地口令登录。",
    );
  }
  if (options.lan) {
    printLanGuidance(lanCertificate);
  }
  if (!sso.enabled) {
    printSsoGuidance(sso.reason, webOrigin);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `启动失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
