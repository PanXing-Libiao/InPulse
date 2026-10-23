#!/usr/bin/env node
/**
 * 部署镜像引用 preflight（技术设计 v1.2.2 §11.1 / §11.2）。
 *
 * 职责：
 *   1. 校验所有 `*_IMAGE_REF` 匹配 `repository:tag@sha256:<64hex>`，拒绝空值、
 *      `latest/next/beta/rc/dev/local` 标签以及占位符（REPLACE_ME / TODO / <...>）。
 *   2. 渲染 `docker compose config --format json`，校验每个 service.image 都带 digest。
 *   3. 校验 §11.2 结构不变量：db 挂载 `/var/lib/postgresql`、read_only、cap_drop、
 *      migrate 一次性、api 等待 migrate 完成、web 仅暴露 80/443 等。
 *
 * 用法：
 *   node scripts/check_deploy_refs.mjs --env deploy/.env.deploy
 *   node scripts/check_deploy_refs.mjs --env deploy/.env.deploy.test
 *   node scripts/check_deploy_refs.mjs --env deploy/.env.deploy.example  # 应被拒绝
 *
 * 注意：真实 digest 只能由受信镜像仓库解析后写入，本脚本不生成也不伪造 digest。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REF_PATTERN = /^[^:\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/;
const FORBIDDEN_TAG =
  /\b(latest|next|beta|rc|dev|local|nightly|test|example|redacted)\b/i;
const PLACEHOLDER = /(REPLACE_ME|CHANGE_ME|TODO|placeholder|<[^>]*>)/i;

const REQUIRED_REFS = [
  "DB_IMAGE_REF",
  "MIGRATE_IMAGE_REF",
  "API_IMAGE_REF",
  "WEB_IMAGE_REF",
  "OPS_IMAGE_REF",
];

// 生产镜像的 Dockerfile 与配套文件（技术设计 §11.1 / §11.2）。
const REQUIRED_DOCKERFILES = [
  "deploy/docker/api.Dockerfile",
  "deploy/docker/migration.Dockerfile",
  "deploy/docker/web.Dockerfile",
  "deploy/docker/db-bootstrap.Dockerfile",
  "deploy/docker/ops.Dockerfile",
];
const REQUIRED_DOCKER_ASSETS = [
  "deploy/docker/nginx.conf",
  "deploy/docker/nginx-security-headers.conf",
  "deploy/docker/healthcheck.mjs",
];

// 备份调度宿主资产（技术设计 §11.5）：生产上线门禁项，上线前不部署、不运行。
// 静态校验范围：定时器节奏、并发锁、run 目标、go-live 门禁、staleness 阈值、
// 凭据只允许通过 *_FILE 提供，以及 operations 服务不得进入默认 profile。
const REQUIRED_BACKUP_ASSETS = [
  "deploy/backup/backup.env.example",
  "deploy/backup/backupctl.sh",
  "deploy/backup/audit-archivectl.sh",
  "deploy/backup/audit-archive.env.example",
  "deploy/backup/inpulse-audit-archive-checkpoint.service",
  "deploy/backup/inpulse-audit-archive-checkpoint.timer",
  "deploy/backup/inpulse-audit-archive-export.service",
  "deploy/backup/inpulse-audit-archive-export.timer",
  "deploy/backup/inpulse-backup.service",
  "deploy/backup/inpulse-backup.timer",
  "deploy/backup/inpulse-backup-alert@.service",
  "deploy/backup/inpulse-backup-watchdog.service",
  "deploy/backup/inpulse-backup-watchdog.timer",
  "docs/runbooks/backup-restore.md",
  "docs/runbooks/upgrade-rollback.md",
  "docs/runbooks/audit-archive.md",
];

async function checkBackupSchedule(rendered) {
  const problems = [];
  const texts = new Map();

  for (const asset of REQUIRED_BACKUP_ASSETS) {
    try {
      texts.set(asset, await readFile(asset, "utf8"));
    } catch {
      problems.push("missing required backup asset: " + asset);
    }
  }

  const controller = texts.get("deploy/backup/backupctl.sh");
  if (controller !== undefined) {
    if (!/--profile operations run --rm(?: -T)? backup/.test(controller)) {
      problems.push(
        "deploy/backup/backupctl.sh: 备份入口必须执行 docker compose --profile operations run --rm backup",
      );
    }
    if (!/\bflock\b/.test(controller)) {
      problems.push("deploy/backup/backupctl.sh: 必须用 flock 实现并发锁");
    }
    if (!/--confirm-go-live/.test(controller)) {
      problems.push(
        "deploy/backup/backupctl.sh: enable 必须要求 --confirm-go-live（上线门禁）",
      );
    }
    if (!/backup-drill-evidence/.test(controller)) {
      problems.push(
        "deploy/backup/backupctl.sh: enable 必须校验全新主机恢复演练证据",
      );
    }
    if (!/INPULSE_BACKUP_MAX_AGE_HOURS:-18/.test(controller)) {
      problems.push(
        "deploy/backup/backupctl.sh: staleness 阈值默认必须是 18 小时",
      );
    }
    if (!/ENABLED_STAMP=/.test(controller) || !/enabled-at/.test(controller)) {
      problems.push(
        "deploy/backup/backupctl.sh: 必须记录 enabled-at 启用时间，避免首次启用误报 staleness",
      );
    }
    if (/--profile operations up\b/.test(controller)) {
      problems.push(
        "deploy/backup/backupctl.sh: 宿主脚本不得常驻启动 operations profile",
      );
    }
  }

  const timer = texts.get("deploy/backup/inpulse-backup.timer");
  if (timer !== undefined) {
    if (!/OnCalendar=\*-\*-\* (?:00\/12|00,12):00:00/.test(timer)) {
      problems.push(
        "deploy/backup/inpulse-backup.timer: 必须是每 12 小时（OnCalendar=*-*-* 00/12:00:00）",
      );
    }
    if (!/Persistent=true/.test(timer)) {
      problems.push("deploy/backup/inpulse-backup.timer: 需要 Persistent=true");
    }
    if (!/Unit=inpulse-backup\.service/.test(timer)) {
      problems.push(
        "deploy/backup/inpulse-backup.timer: 必须绑定 Unit=inpulse-backup.service",
      );
    }
  }

  const service = texts.get("deploy/backup/inpulse-backup.service");
  if (service !== undefined) {
    if (!/ExecStart=__INPULSE_BACKUPCTL__ run/.test(service)) {
      problems.push(
        "deploy/backup/inpulse-backup.service: ExecStart 必须调用 backupctl.sh run（安装时替换路径）",
      );
    }
    if (!/TimeoutStartSec=/.test(service)) {
      problems.push(
        "deploy/backup/inpulse-backup.service: 必须声明 TimeoutStartSec",
      );
    }
    if (!/OnFailure=inpulse-backup-alert@%N\.service/.test(service)) {
      problems.push(
        "deploy/backup/inpulse-backup.service: 必须用 OnFailure 指向告警单元",
      );
    }
  }

  const alertUnit = texts.get("deploy/backup/inpulse-backup-alert@.service");
  if (
    alertUnit !== undefined &&
    !/ExecStart=__INPULSE_BACKUPCTL__ alert/.test(alertUnit)
  ) {
    problems.push(
      "deploy/backup/inpulse-backup-alert@.service: 必须调用 backupctl.sh alert",
    );
  }

  const watchdog = texts.get("deploy/backup/inpulse-backup-watchdog.service");
  if (
    watchdog !== undefined &&
    !/ExecStart=__INPULSE_BACKUPCTL__ check-staleness/.test(watchdog)
  ) {
    problems.push(
      "deploy/backup/inpulse-backup-watchdog.service: 必须调用 backupctl.sh check-staleness",
    );
  }

  const watchdogTimer = texts.get(
    "deploy/backup/inpulse-backup-watchdog.timer",
  );
  if (watchdogTimer !== undefined && !/OnCalendar=hourly/.test(watchdogTimer)) {
    problems.push(
      "deploy/backup/inpulse-backup-watchdog.timer: staleness 检查必须每小时一次",
    );
  }

  // F-08 步骤 6：审计远端归档的宿主调度静态校验（每小时检查点 + 每日导出）。
  const auditController = texts.get("deploy/backup/audit-archivectl.sh");
  if (auditController !== undefined) {
    if (
      !auditController.includes("--profile operations run --rm") ||
      !auditController.includes("audit-archive")
    ) {
      problems.push(
        "deploy/backup/audit-archivectl.sh: 归档入口必须执行 docker compose --profile operations run --rm audit-archive",
      );
    }
    if (!auditController.includes("flock")) {
      problems.push(
        "deploy/backup/audit-archivectl.sh: 必须用 flock 实现并发锁",
      );
    }
    if (!auditController.includes("--confirm-go-live")) {
      problems.push(
        "deploy/backup/audit-archivectl.sh: enable 必须要求 --confirm-go-live（上线门禁）",
      );
    }
    if (auditController.includes("--profile operations up")) {
      problems.push(
        "deploy/backup/audit-archivectl.sh: 宿主脚本不得常驻启动 operations profile",
      );
    }
  }

  const checkpointAuditTimer = texts.get(
    "deploy/backup/inpulse-audit-archive-checkpoint.timer",
  );
  if (checkpointAuditTimer !== undefined) {
    if (!checkpointAuditTimer.includes("OnCalendar=hourly")) {
      problems.push(
        "deploy/backup/inpulse-audit-archive-checkpoint.timer: 必须每小时（OnCalendar=hourly）",
      );
    }
    if (!checkpointAuditTimer.includes("Persistent=true")) {
      problems.push(
        "deploy/backup/inpulse-audit-archive-checkpoint.timer: 需要 Persistent=true",
      );
    }
  }

  const exportAuditTimer = texts.get(
    "deploy/backup/inpulse-audit-archive-export.timer",
  );
  if (exportAuditTimer !== undefined) {
    if (!exportAuditTimer.includes("OnCalendar=*-*-* 00:20:00")) {
      problems.push(
        "deploy/backup/inpulse-audit-archive-export.timer: 必须每日 UTC 00:20（OnCalendar=*-*-* 00:20:00）",
      );
    }
  }

  for (const [file, command] of [
    [
      "deploy/backup/inpulse-audit-archive-checkpoint.service",
      "run-checkpoint",
    ],
    ["deploy/backup/inpulse-audit-archive-export.service", "run-export"],
  ]) {
    const unitText = texts.get(file);
    if (unitText === undefined) continue;
    if (!unitText.includes("__INPULSE_AUDIT_ARCHIVECTL__ " + command)) {
      problems.push(
        file + ": ExecStart 必须调用 audit-archivectl.sh（安装时替换路径）",
      );
    }
    if (!unitText.includes("TimeoutStartSec=")) {
      problems.push(file + ": 必须声明 TimeoutStartSec");
    }
    if (!unitText.includes("OnFailure=inpulse-backup-alert@%N.service")) {
      problems.push(file + ": 必须用 OnFailure 指向告警单元");
    }
  }

  const auditEnvExample = texts.get("deploy/backup/audit-archive.env.example");
  if (auditEnvExample !== undefined) {
    for (const rawLine of auditEnvExample.split(String.fromCharCode(10))) {
      const trimmed = rawLine.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      const key = separator > 0 ? trimmed.slice(0, separator).trim() : trimmed;
      if (
        /^(PASSWORD|SECRET|TOKEN|WEBHOOK|DSN)/i.test(key) ||
        /(PASSWORD|SECRET|TOKEN|WEBHOOK|DSN)$/i.test(key)
      ) {
        problems.push(
          "deploy/backup/audit-archive.env.example: 敏感键必须以 *_FILE 提供或删除：" +
            key,
        );
      }
    }
  }

  const envExample = texts.get("deploy/backup/backup.env.example");
  if (envExample !== undefined) {
    envExample.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return;
      const separator = trimmed.indexOf("=");
      if (separator < 0) {
        problems.push(
          "deploy/backup/backup.env.example:" +
            (index + 1) +
            ": 必须是 KEY=VALUE",
        );
        return;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      const sensitive = /(PASSWORD|SECRET|TOKEN|KEY|URL|WEBHOOK|DSN)/i.test(
        key,
      );
      if (sensitive && !(key.endsWith("_FILE") || value === "")) {
        problems.push(
          "deploy/backup/backup.env.example:" +
            (index + 1) +
            ": " +
            key +
            " 必须留空或改为 *_FILE 指向受限文件",
        );
      }
    });
  }

  for (const name of ["backup", "audit-archive"]) {
    const svc = rendered.services?.[name];
    if (!svc) continue;
    const profiles = svc.profiles ?? [];
    if (!Array.isArray(profiles) || !profiles.includes("operations")) {
      problems.push(
        "service " +
          name +
          ": 必须声明 profiles: [operations]（上线前不得随默认 profile 启动）",
      );
    }
  }

  return problems;
}

let exitCode = 0;

// 首次建库 / 灾难恢复一次性覆盖（技术设计 §11.2 / §11.2.1）。版本化
// compose.init.yaml 只允许在该次向 db 服务提供 cluster_bootstrap 凭据和六份
// 独立密码 Secret；稳态渲染必须完全不含 bootstrap 凭据；migrate/api/web/
// backup/audit-archive 从不挂载 db_bootstrap_password。
const INIT_OVERLAY = "deploy/compose.init.yaml";
const REQUIRED_INIT_ASSETS = [
  INIT_OVERLAY,
  "docs/runbooks/disaster-recovery.md",
];
const INIT_DB_ENVIRONMENT = {
  POSTGRES_DB: "app",
  POSTGRES_USER: "cluster_bootstrap",
  POSTGRES_PASSWORD_FILE: "/run/secrets/db_bootstrap_password",
};
const INIT_DB_SECRETS = [
  "db_bootstrap_password",
  "db_migrator_password",
  "db_runtime_password",
  "db_backup_password",
  "db_audit_reader_password",
  "db_audit_archive_password",
];
const INIT_DB_SECRET_UID = "999";

function secretNameOf(ref) {
  return typeof ref === "string" ? ref : (ref?.source ?? "");
}

function checkInitOverlay(steadyRendered, initRendered) {
  const problems = [];
  const steadyDb = steadyRendered.services?.db;
  if (steadyDb) {
    const env = steadyDb.environment ?? {};
    for (const key of Object.keys(INIT_DB_ENVIRONMENT)) {
      if (env[key] !== undefined) {
        problems.push(
          "steady-state db: must not set " +
            key +
            "; initialization overlay is one-shot only",
        );
      }
    }
    if (
      (steadyDb.secrets ?? []).some(
        (ref) => secretNameOf(ref) === "db_bootstrap_password",
      )
    ) {
      problems.push("steady-state db: must not mount db_bootstrap_password");
    }
  }
  for (const name of ["migrate", "api", "web", "backup", "audit-archive"]) {
    const service = steadyRendered.services?.[name];
    if (!service) continue;
    if (
      (service.secrets ?? []).some(
        (ref) => secretNameOf(ref) === "db_bootstrap_password",
      )
    ) {
      problems.push(name + ": must never mount db_bootstrap_password");
    }
  }

  const db = initRendered.services?.db;
  if (!db) {
    problems.push("compose.init.yaml: db service missing in overlay render");
    return problems;
  }
  const environment = db.environment ?? {};
  for (const [key, value] of Object.entries(INIT_DB_ENVIRONMENT)) {
    if (environment[key] !== value) {
      problems.push(
        "compose.init.yaml: db environment " + key + " must be " + value,
      );
    }
  }
  const secrets = (db.secrets ?? []).map((ref) =>
    typeof ref === "string" ? { source: ref, target: undefined } : ref,
  );
  const bySource = new Map(secrets.map((ref) => [ref.source, ref]));
  for (const name of INIT_DB_SECRETS) {
    const ref = bySource.get(name);
    if (!ref) {
      problems.push("compose.init.yaml: db must mount secret " + name);
      continue;
    }
    if (ref.target !== "/run/secrets/" + name) {
      problems.push(
        "compose.init.yaml: secret " +
          name +
          " target must be /run/secrets/" +
          name,
      );
    }
    if (ref.mode !== "0400") {
      problems.push(
        "compose.init.yaml: secret " + name + " must set mode 0400",
      );
    }
    if (ref.uid !== INIT_DB_SECRET_UID || ref.gid !== INIT_DB_SECRET_UID) {
      problems.push(
        "compose.init.yaml: secret " +
          name +
          " uid/gid must be " +
          INIT_DB_SECRET_UID +
          ":" +
          INIT_DB_SECRET_UID,
      );
    }
  }
  for (const ref of secrets) {
    if (!INIT_DB_SECRETS.includes(ref.source)) {
      problems.push(
        "compose.init.yaml: db must not mount unexpected secret " + ref.source,
      );
    }
  }
  return problems;
}
function fail(message) {
  process.stderr.write(`[check:deploy] ERROR: ${message}\n`);
  exitCode = 1;
}

function info(message) {
  process.stdout.write(`[check:deploy] ${message}\n`);
}

function parseArgs(argv) {
  const args = { env: "deploy/.env.deploy", compose: "deploy/compose.yaml" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env" || arg === "--env-file") args.env = argv[i + 1];
    else if (arg === "--compose") args.compose = argv[i + 1];
  }
  return args;
}

async function loadEnv(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    fail(`environment file not found: ${file}`);
    return null;
  }
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.replace(/^export\s+/, "");
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function validateRef(label, value) {
  if (!value) {
    fail(`${label} is empty`);
    return false;
  }
  if (PLACEHOLDER.test(value)) {
    fail(
      `${label} contains a placeholder (\`${value}\`); real value must come from a trusted registry`,
    );
    return false;
  }
  if (!REF_PATTERN.test(value)) {
    fail(
      `${label} must be \`repository:tag@sha256:<64hex>\`, got \`${value}\``,
    );
    return false;
  }
  const tag = value.slice(0, value.indexOf("@")).split(":")[1] ?? "";
  if (!tag || FORBIDDEN_TAG.test(tag)) {
    fail(
      `${label} uses a non-pinned/imprecise tag \`${tag}\`; require an exact patch tag plus digest`,
    );
    return false;
  }
  return true;
}

function renderComposeJson({ env, compose }) {
  const projectDir = resolve(process.cwd(), "deploy");
  const composeFiles = Array.isArray(compose) ? compose : [compose];
  const args = ["compose", "--project-directory", projectDir];
  for (const file of composeFiles) args.push("-f", file);
  args.push(
    "--env-file",
    env,
    "--profile",
    "operations",
    "config",
    "--format",
    "json",
  );
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) {
    fail(`unable to run docker compose: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    fail(
      `docker compose config failed:\n${result.stderr || result.stdout || ""}`,
    );
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("docker compose config did not produce valid JSON");
    return null;
  }
}

function checkStructure(rendered) {
  const services = rendered.services ?? {};
  const problems = [];

  for (const name of ["db", "migrate", "api", "web"]) {
    if (!services[name]) problems.push(`missing ${name} service`);
  }

  for (const name of ["db", "migrate", "api", "web"]) {
    const svc = services[name];
    if (!svc) continue;
    if (svc.read_only !== true)
      problems.push(`${name}: read_only must be true`);
    if (!(svc.cap_drop ?? []).includes("ALL")) {
      problems.push(`${name}: cap_drop must include ALL`);
    }
  }

  const db = services.db;
  if (db) {
    const mount = (db.volumes ?? []).some(
      (v) =>
        typeof v === "object" && /\/var\/lib\/postgresql/.test(v.target ?? ""),
    );
    if (!mount)
      problems.push("db: must mount named volume at /var/lib/postgresql");
    if (!db.healthcheck) problems.push("db: healthcheck is required");
  }

  // 反向代理信任链（compose.yaml 说明 7 与 nginx.conf 顶部承诺）：backend 必须
  // 有且只有一个静态 ipam 子网，api 的 TRUSTED_PROXY_CIDRS 必须包含它。缺一都
  // 会让生产 req.ip 退化为 Nginx 容器地址（审计 ip_address、登录/SSO 的 IP 限流
  // 全部失真），而本地 loopback 环境不可复现该缺口。
  const backendSubnets = (rendered.networks?.backend?.ipam?.config ?? [])
    .map((entry) => entry?.subnet)
    .filter((subnet) => typeof subnet === "string" && subnet.length > 0);
  if (services.api && backendSubnets.length !== 1) {
    problems.push(
      "backend network: must declare exactly one static ipam subnet (the api trust proxy target)",
    );
  }

  const api = services.api;
  if (api) {
    if (!api.healthcheck) problems.push("api: healthcheck is required");
    if (
      api.depends_on?.migrate?.condition !== "service_completed_successfully"
    ) {
      problems.push(
        "api: must wait for migrate service_completed_successfully",
      );
    }
    const env = api.environment ?? {};
    if (!env.RUNTIME_DB_PASSWORD_FILE) {
      problems.push(
        "api: environment must set RUNTIME_DB_PASSWORD_FILE (code reads it)",
      );
    }
    const trustedProxies = String(env.TRUSTED_PROXY_CIDRS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (trustedProxies.length === 0) {
      problems.push(
        "api: environment must set TRUSTED_PROXY_CIDRS to the backend subnet (Express trust proxy)",
      );
    }
    if (
      trustedProxies.some(
        (entry) =>
          entry === "loopback" || entry === "0.0.0.0/0" || entry === "::/0",
      )
    ) {
      problems.push(
        "api: TRUSTED_PROXY_CIDRS must not trust loopback or all addresses in production",
      );
    }
    if (
      backendSubnets.length === 1 &&
      !trustedProxies.includes(backendSubnets[0])
    ) {
      problems.push(
        `api: TRUSTED_PROXY_CIDRS must include the backend subnet ${backendSubnets[0]}`,
      );
    }
  }

  const migrate = services.migrate;
  if (migrate) {
    if (migrate.restart !== "no") problems.push("migrate: restart must be no");
    const cmd = Array.isArray(migrate.command)
      ? migrate.command.join(" ")
      : String(migrate.command ?? "");
    if (!(cmd.includes("db:migrate") || cmd.includes("dist/src/migrate.js"))) {
      problems.push(
        "migrate: command must invoke db:migrate or dist/src/migrate.js",
      );
    }
    const env = migrate.environment ?? {};
    if (!env.MIGRATION_DB_PASSWORD_FILE) {
      problems.push(
        "migrate: environment must set MIGRATION_DB_PASSWORD_FILE (code reads it)",
      );
    }
  }

  const web = services.web;
  if (web) {
    if (!web.healthcheck) problems.push("web: healthcheck is required");
    const ports = (web.ports ?? []).map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") return `${p.published}:${p.target}`;
      return String(p);
    });
    if (!ports.includes("80:8080")) problems.push("web: must expose 80:8080");
    if (!ports.includes("443:8443")) problems.push("web: must expose 443:8443");
  }

  // 生产 `readTrimmedSecret` 要求 secret 为 /run/secrets 直接子项、owner-read-only
  // （mode 0400），且运行用户必须能读取。Compose 长语法在服务级声明 `uid/gid/mode`，
  // 必须与容器 user 的数值 uid/gid 一致，否则启动会 fail-closed。
  const numericUser = (value) => {
    const match = /^(\d+):(\d+)$/.exec(String(value ?? ""));
    return match ? { uid: match[1], gid: match[2] } : null;
  };
  for (const name of ["migrate", "api", "web", "backup", "audit-archive"]) {
    const svc = services[name];
    if (!svc) continue;
    const user = numericUser(svc.user);
    if (!user) continue;
    for (const ref of svc.secrets ?? []) {
      if (typeof ref === "string") {
        problems.push(
          `${name}: secret \`${ref}\` must use long syntax with target/uid/gid/mode`,
        );
        continue;
      }
      if (ref.mode !== "0400") {
        problems.push(
          `${name}: secret \`${ref.source}\` must set mode 0400 (owner-only readable)`,
        );
      }
      if (ref.uid !== user.uid || ref.gid !== user.gid) {
        problems.push(
          `${name}: secret \`${ref.source}\` uid/gid must match container user ${svc.user}`,
        );
      }
      if (!ref.target || !/^\/run\/secrets\/[^/]+$/.test(ref.target)) {
        problems.push(
          `${name}: secret \`${ref.source}\` target must be a direct child of /run/secrets`,
        );
      }
    }
  }

  return problems;
}

/**
 * 校验生产 Dockerfile：
 *   - 每个 `FROM` 必须带 `@sha256:<64hex>` 且不含浮动 tag；
 *   - runtime 阶段必须存在非 root 数值 `USER`；
 *   - API 镜像必须内置 healthcheck.mjs；Web 镜像必须内置 nginx.conf。
 */
async function checkDockerfiles() {
  const problems = [];

  for (const file of [...REQUIRED_DOCKERFILES, ...REQUIRED_DOCKER_ASSETS]) {
    try {
      await readFile(file, "utf8");
    } catch {
      problems.push(`missing required Docker asset: ${file}`);
    }
  }

  for (const file of REQUIRED_DOCKERFILES) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const fromLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("FROM "));
    if (fromLines.length === 0) {
      problems.push(`${file}: no FROM directive`);
    }

    let runtimeUser = false;
    let hasHealthcheck = false;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^USER\s+\d+/.test(trimmed)) runtimeUser = true;
      if (/healthcheck\.mjs/.test(trimmed)) hasHealthcheck = true;
    }

    for (const from of fromLines) {
      if (!/@sha256:[0-9a-f]{64}\s*(?:AS\s+\w+)?\s*$/.test(from)) {
        problems.push(
          `${file}: FROM must be pinned to <tag>@sha256:<64hex>; got \`${from}\``,
        );
      }
      if (FORBIDDEN_TAG.test(from)) {
        problems.push(
          `${file}: FROM uses a forbidden/imprecise tag \`${from}\``,
        );
      }
    }

    // db-bootstrap 基于官方 postgres 镜像，以非 root `postgres` 用户运行，
    // 不要求数值 USER；其余自建镜像必须声明非 root 数值 USER。
    if (!runtimeUser && !file.endsWith("db-bootstrap.Dockerfile")) {
      problems.push(`${file}: runtime must declare a numeric USER`);
    }
    if (file.endsWith("api.Dockerfile") && !hasHealthcheck) {
      problems.push(`${file}: api image must include healthcheck.mjs`);
    }
  }

  const web = await readFile("deploy/docker/web.Dockerfile", "utf8").catch(
    () => "",
  );
  if (!/nginx\.conf/.test(web)) {
    problems.push("deploy/docker/web.Dockerfile: must copy nginx.conf");
  }
  if (!/nginx-security-headers\.conf/.test(web)) {
    problems.push(
      "deploy/docker/web.Dockerfile: must copy nginx-security-headers.conf",
    );
  }

  // F-09 逐响应 nonce CSP：入口 HTML 的占位符必须由 Nginx 变量替换（sub_filter），
  // 安全头片段必须被 include，且策略不允许 unsafe-inline（ADR-021）。
  const nginxConf = await readFile("deploy/docker/nginx.conf", "utf8").catch(
    () => "",
  );
  if (
    !/sub_filter\s+"__INPULSE_CSP_NONCE__"\s+"\$request_id"/.test(nginxConf)
  ) {
    problems.push(
      'deploy/docker/nginx.conf: must rewrite the CSP nonce placeholder via sub_filter "__INPULSE_CSP_NONCE__" "$request_id"',
    );
  }
  // 审计「客户端请求 ID」（ADR-008 请求元数据）：/api/v1 代理必须注入
  // X-Request-Id，且缺省回退为 $request_id——浏览器不会自动发送该头，缺了它
  // 审计行的 client_request_id 恒为空。map 内正则必须与 API 白名单同一模式，
  // 两处漂移会让审计字段静默丢失。
  if (
    !/map\s+\$http_x_request_id\s+\$inpulse_audit_request_id\b/.test(nginxConf)
  ) {
    problems.push(
      "deploy/docker/nginx.conf: must define the $http_x_request_id -> $inpulse_audit_request_id map",
    );
  }
  if (!/default\s+\$request_id;/.test(nginxConf)) {
    problems.push(
      "deploy/docker/nginx.conf: X-Request-Id map must fall back to $request_id",
    );
  }
  if (
    !/proxy_set_header\s+X-Request-Id\s+\$inpulse_audit_request_id;/.test(
      nginxConf,
    )
  ) {
    problems.push(
      "deploy/docker/nginx.conf: /api/v1 proxy must set X-Request-Id from $inpulse_audit_request_id",
    );
  }
  const requestAuditContext = await readFile(
    "apps/api/src/audit/request-audit-context.ts",
    "utf8",
  ).catch(() => "");
  const apiRequestIdPattern = /CLIENT_REQUEST_ID_PATTERN\s*=\s*\/(.+?)\/;/.exec(
    requestAuditContext,
  )?.[1];
  if (!apiRequestIdPattern) {
    problems.push(
      "apps/api/src/audit/request-audit-context.ts: CLIENT_REQUEST_ID_PATTERN not found (needed to keep the Nginx map in sync)",
    );
  } else if (!nginxConf.includes(apiRequestIdPattern)) {
    problems.push(
      `deploy/docker/nginx.conf: X-Request-Id map regex must match the API whitelist ${apiRequestIdPattern}`,
    );
  }
  if (
    !/include\s+\/etc\/nginx\/snippets\/inpulse-security-headers\.conf;/.test(
      nginxConf,
    )
  ) {
    problems.push(
      "deploy/docker/nginx.conf: must include the security headers snippet in every location",
    );
  }
  if (!/^\s*server_tokens\s+off;/m.test(nginxConf)) {
    problems.push(
      "deploy/docker/nginx.conf: server_tokens must be off to avoid exposing the nginx version",
    );
  }
  if (/return\s+308\s+https:\/\/\$host\b/.test(nginxConf)) {
    problems.push(
      "deploy/docker/nginx.conf: HTTP redirect must not interpolate an untrusted $host",
    );
  }
  if (!/map\s+\$host\s+\$inpulse_https_origin\b/.test(nginxConf)) {
    problems.push(
      "deploy/docker/nginx.conf: must validate Host via the $inpulse_https_origin map",
    );
  }
  if (
    !/if\s*\(\$inpulse_https_origin\s*=\s*""\)\s*\{\s*return\s+421;/.test(
      nginxConf,
    )
  ) {
    problems.push(
      "deploy/docker/nginx.conf: untrusted Host values must return 421",
    );
  }
  if (!/return\s+308\s+\$inpulse_https_origin\$request_uri;/.test(nginxConf)) {
    problems.push(
      "deploy/docker/nginx.conf: HTTP redirect must use the validated HTTPS origin",
    );
  }
  for (const blockedPath of [
    "compose\\.ya?ml",
    "secrets(?:/|$)",
    "api/openapi(?:\\.json)?$",
    "robots\\.txt$",
  ]) {
    if (!nginxConf.includes(blockedPath)) {
      problems.push(
        "deploy/docker/nginx.conf: missing sensitive-path block for " +
          blockedPath,
      );
    }
  }
  if (!/location\s+~\s+\^\/\\\.\s*\{/.test(nginxConf)) {
    problems.push(
      "deploy/docker/nginx.conf: hidden paths must be blocked before the SPA fallback",
    );
  }

  const mainSource = await readFile("apps/api/src/main.ts", "utf8").catch(
    () => "",
  );
  const httpSecuritySource = await readFile(
    "apps/api/src/http-security.ts",
    "utf8",
  ).catch(() => "");
  if (!/disableFrameworkFingerprint\(app\)/.test(mainSource)) {
    problems.push(
      "apps/api/src/main.ts: must call disableFrameworkFingerprint(app)",
    );
  }
  if (!/app\.disable\("x-powered-by"\)/.test(httpSecuritySource)) {
    problems.push(
      "apps/api/src/http-security.ts: must disable the x-powered-by header",
    );
  }
  const securityHeaders = await readFile(
    "deploy/docker/nginx-security-headers.conf",
    "utf8",
  ).catch(() => "");
  // 注释里可以出现“禁止 unsafe-inline”这类说明，只能检查实际指令行。
  for (const [file, text] of [
    ["deploy/docker/nginx.conf", nginxConf],
    ["deploy/docker/nginx-security-headers.conf", securityHeaders],
  ]) {
    const directives = text
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    if (/unsafe-inline/.test(directives)) {
      problems.push(`${file}: CSP must not contain unsafe-inline`);
    }
  }

  for (const file of [
    "deploy/docker/api.Dockerfile",
    "deploy/docker/migration.Dockerfile",
    "deploy/docker/ops.Dockerfile",
  ]) {
    const text = await readFile(file, "utf8").catch(() => "");
    const runtime = text.split(/\bAS\s+runtime\b/i)[1] ?? "";
    if (!/rm\s+-rf\s+[^\n]*\/usr\/local\/lib\/node_modules/.test(runtime)) {
      problems.push(
        `${file}: Node runtime must remove bundled npm/corepack toolchain before non-root USER`,
      );
    }
  }

  const dbBootstrap = await readFile(
    "deploy/docker/db-bootstrap.Dockerfile",
    "utf8",
  ).catch(() => "");
  if (
    !/apt-get\s+install\s+-y\s+--only-upgrade\s+libssl3t64/.test(dbBootstrap)
  ) {
    problems.push(
      "deploy/docker/db-bootstrap.Dockerfile: runtime must upgrade OpenSSL from Debian security",
    );
  }
  if (!/rm\s+-f\s+\/usr\/local\/bin\/gosu/.test(dbBootstrap)) {
    problems.push(
      "deploy/docker/db-bootstrap.Dockerfile: runtime must remove official gosu binary",
    );
  }

  return problems;
}

async function main() {
  const { env, compose } = parseArgs(process.argv.slice(2));
  const envValues = await loadEnv(env);
  if (envValues === null) {
    process.exit(exitCode);
    return;
  }

  // 1. required IMAGE_REF present and valid
  let count = 0;
  for (const key of REQUIRED_REFS) {
    if (!envValues.has(key)) {
      fail(`${key} is missing from ${env}`);
      continue;
    }
    if (validateRef(key, envValues.get(key))) count += 1;
  }

  // 2. any other *_IMAGE_REF must also be valid (extra refs are allowed but checked)
  for (const [key, value] of envValues) {
    if (key.endsWith("_IMAGE_REF") && !REQUIRED_REFS.includes(key)) {
      validateRef(key, value);
    }
  }

  if (exitCode !== 0) {
    fail(
      `image ref(s) invalid; resolve them at a trusted registry before release`,
    );
    process.exit(exitCode);
  }

  // 3. compose render + image check + structure
  const rendered = renderComposeJson({ env, compose });
  if (rendered === null) {
    process.exit(exitCode);
    return;
  }

  for (const [name, svc] of Object.entries(rendered.services ?? {})) {
    const image = svc.image;
    if (!image) {
      fail(`service ${name} has no image`);
      continue;
    }
    validateRef(`service ${name} image`, image);
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
    return;
  }

  const problems = checkStructure(rendered);
  if (problems.length > 0) {
    for (const problem of problems) fail(problem);
    process.exit(exitCode);
    return;
  }

  for (const asset of REQUIRED_INIT_ASSETS) {
    if (!existsSync(asset)) {
      fail("missing required init asset: " + asset);
    }
  }
  const initRendered = renderComposeJson({
    env,
    compose: [compose, INIT_OVERLAY],
  });
  if (initRendered !== null) {
    const initProblems = checkInitOverlay(rendered, initRendered);
    for (const problem of initProblems) fail(problem);
  } else {
    fail("initialization overlay render failed");
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
    return;
  }

  const dockerProblems = await checkDockerfiles();
  if (dockerProblems.length > 0) {
    for (const problem of dockerProblems) fail(problem);
    process.exit(exitCode);
    return;
  }

  const backupProblems = await checkBackupSchedule(rendered);
  if (backupProblems.length > 0) {
    for (const problem of backupProblems) fail(problem);
    process.exit(exitCode);
    return;
  }

  info(
    `${count} image refs valid; compose config rendered; structure invariants, Dockerfile and backup-schedule checks OK.`,
  );
  process.exit(exitCode);
}

main();
