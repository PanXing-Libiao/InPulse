import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function buildDatabaseUrl() {
  const direct = process.env.DATABASE_URL;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const host = process.env.DB_HOST || "db";
  const port = process.env.DB_PORT || "5432";
  const name = process.env.DB_NAME || "app";
  const user = process.env.DB_USER || "app_runtime";
  const passwordFile =
    process.env.DB_PASSWORD_FILE || "/run/secrets/db_runtime_password";
  const password = readFileSync(passwordFile, "utf8").trim();
  const sslmode = (process.env.DB_SSLMODE || "").trim();
  const base =
    "postgresql://" +
    encodeURIComponent(user) +
    ":" +
    encodeURIComponent(password) +
    "@" +
    host +
    ":" +
    port +
    "/" +
    name;
  return sslmode.length > 0 ? base + "?sslmode=" + sslmode : base;
}

const databaseUrl = buildDatabaseUrl();
const childEnv = Object.assign({}, process.env, { DATABASE_URL: databaseUrl });
const APP_DIR = "/opt/wecom-bridge";
const children = [];
let shuttingDown = false;

function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[runner]", new Date().toISOString(), "关闭桥接子进程:", reason);
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* process already gone */
    }
  }
  setTimeout(() => process.exit(code), 1500);
}

function launch(label, args) {
  const child = spawn(process.execPath, args, {
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    console.log(
      "[runner]",
      new Date().toISOString(),
      label,
      "退出 code=" + code + " signal=" + signal,
    );
    shutdown(label + " 意外退出", 1);
  });
  children.push(child);
}

process.on("SIGTERM", () => shutdown("收到 SIGTERM", 0));
process.on("SIGINT", () => shutdown("收到 SIGINT", 0));

console.log(
  "[runner]",
  new Date().toISOString(),
  "启动 InPulse 企业微信通知桥接（正式环境）",
);
launch("long-conn", [APP_DIR + "/long-conn.mjs", APP_DIR + "/config.json"]);
launch("bridge", [APP_DIR + "/bridge.mjs", APP_DIR + "/bridge-config.json"]);
