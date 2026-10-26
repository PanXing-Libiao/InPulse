#!/usr/bin/env node
/**
 * 生成 VM 更新用源码包。
 *
 * Git 的 --cached --others --exclude-standard 清单同时覆盖已提交文件和未忽略的
 * 未提交文件。清单用 NUL 分隔，避免中文路径被 quotePath 转义；Windows 自带
 * bsdtar 读取含中文的 -T 清单存在转换缺陷，因此 Windows 优先使用 Git for
 * Windows 自带的 GNU tar，并使用同目录 gzip。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const REQUIRED_FILES = [
  "deploy/compose.yaml",
  "deploy/docker/api.Dockerfile",
  "package.json",
  "pnpm-lock.yaml",
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let repo = process.cwd();
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--repo") {
      repo = argv[index + 1] ?? fail("--repo 缺少值");
      index += 1;
    } else if (key === "--output") {
      output = argv[index + 1] ?? fail("--output 缺少值");
      index += 1;
    } else if (key === "--help" || key === "-h") {
      console.log(
        "用法：node scripts/pack-source.mjs --repo <仓库> --output <tar.gz>",
      );
      process.exit(0);
    } else {
      fail("未知参数：" + key);
    }
  }
  if (output === undefined || output.length === 0) {
    fail("必须提供 --output");
  }
  return { repo: path.resolve(repo), output: path.resolve(output) };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    cwd: options.cwd,
    env: options.env,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(command + " 启动失败：" + result.error.message);
  }
  if (options.allowFailure !== true && result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    fail(
      command +
        " 失败（exit " +
        (result.status ?? 1) +
        "）" +
        (stderr.length > 0 ? "：" + stderr : ""),
    );
  }
  return result;
}

function firstOutputLine(result) {
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function validateGitPath(entry) {
  if (entry.length === 0) {
    fail("Git 文件清单包含空路径");
  }
  if (entry.includes("\n") || entry.includes("\r")) {
    fail("源码路径包含换行，无法安全打包：" + JSON.stringify(entry));
  }
  if (entry.includes("\\")) {
    fail("源码路径包含反斜杠，无法安全打包：" + JSON.stringify(entry));
  }
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
    fail("源码路径不能是绝对路径：" + entry);
  }
  if (entry.split("/").includes("..")) {
    fail("源码路径不能越出仓库：" + entry);
  }
}

function collectGitFiles(repo) {
  const result = run(
    "git",
    [
      "-C",
      repo,
      "-c",
      "core.quotepath=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "buffer" },
  );
  const entries = String(result.stdout)
    .split("\0")
    .filter((entry) => entry.length > 0);
  const unique = [...new Set(entries)];
  const files = [];
  const missing = [];
  for (const entry of unique) {
    validateGitPath(entry);
    const absolute = path.join(repo, ...entry.split("/"));
    if (!existsSync(absolute)) {
      missing.push(entry);
      continue;
    }
    if (statSync(absolute).isDirectory()) {
      fail("不支持打包子模块目录：" + entry);
    }
    files.push(entry);
  }
  files.sort();
  if (missing.length > 0) {
    console.error(
      "[pack-source] 跳过 " +
        missing.length +
        " 个工作区已删除的跟踪文件：" +
        missing.slice(0, 5).join("、"),
    );
  }
  if (files.length === 0) {
    fail("Git 源码文件清单为空，拒绝生成空包");
  }
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) {
      fail("源码文件清单缺少必需文件：" + required);
    }
  }
  return { files, missing };
}

function findAncestorTar(starts) {
  for (const start of starts) {
    let cursor = path.resolve(start);
    for (let depth = 0; depth < 6; depth += 1) {
      const binDir = path.join(cursor, "usr", "bin");
      const tarPath = path.join(binDir, "tar.exe");
      const gzipPath = path.join(binDir, "gzip.exe");
      if (existsSync(tarPath) && existsSync(gzipPath)) {
        return { tarPath, binDir };
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }
  return undefined;
}

function resolveTar() {
  if (process.platform !== "win32") {
    run("tar", ["--version"]);
    return { command: "tar", env: process.env };
  }

  const starts = [];
  const execPath = run("git", ["--exec-path"], { allowFailure: true });
  if (execPath.status === 0) {
    const resolved = firstOutputLine(execPath);
    if (resolved !== undefined) {
      starts.push(resolved);
    }
  }
  const located = run("where", ["git"], { allowFailure: true });
  if (located.status === 0) {
    for (const line of String(located.stdout).split(/\r?\n/)) {
      const resolved = line.trim();
      if (resolved.length > 0) {
        starts.push(path.dirname(resolved));
      }
    }
  }
  const found = findAncestorTar(starts);
  if (found === undefined) {
    fail(
      "Windows 上未找到 Git for Windows 自带的 GNU tar/gzip。请安装 Git for Windows，并确认其安装目录包含 usr/bin/tar.exe 与 usr/bin/gzip.exe；本机不会调用 Docker Desktop。",
    );
  }
  const pathValue = process.env.PATH ?? "";
  return {
    command: found.tarPath,
    env: {
      ...process.env,
      PATH: found.binDir + path.delimiter + pathValue,
    },
  };
}

function verifyArchive(tar, archive, files) {
  const listed = run(tar.command, ["-tzf", path.basename(archive)], {
    cwd: path.dirname(archive),
    env: tar.env,
  });
  const entries = String(listed.stdout)
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0);
  if (entries.length !== files.length) {
    fail(
      "源码包条目数不一致：期望 " + files.length + "，实际 " + entries.length,
    );
  }
  for (const required of REQUIRED_FILES) {
    if (!entries.includes(required)) {
      fail("源码包缺少必需文件：" + required);
    }
  }
  const banned = entries.filter(
    (entry) =>
      entry === ".git" ||
      entry.startsWith(".git/") ||
      entry === "node_modules" ||
      entry.startsWith("node_modules/") ||
      entry === ".data" ||
      entry.startsWith(".data/"),
  );
  if (banned.length > 0) {
    fail("源码包包含禁止目录：" + banned.slice(0, 5).join("、"));
  }
  return entries.length;
}

function main() {
  const { repo, output } = parseArguments(process.argv.slice(2));
  if (!existsSync(path.join(repo, ".git"))) {
    fail("--repo 不是 Git 工作区：" + repo);
  }
  const { files, missing } = collectGitFiles(repo);
  const tar = resolveTar();
  const manifestPath = output + ".files";
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    writeFileSync(manifestPath, Buffer.from(files.join("\0") + "\0", "utf8"));
    run(
      tar.command,
      ["--null", "-czf", path.basename(output), "-C", repo, "-T", manifestPath],
      { cwd: path.dirname(output), env: tar.env },
    );
    const archiveBytes = statSync(output).size;
    verifyArchive(tar, output, files);
    console.log(
      JSON.stringify({
        archive: output,
        archiveBytes,
        fileCount: files.length,
        skippedMissing: missing.length,
      }),
    );
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  } finally {
    rmSync(manifestPath, { force: true });
  }
}

try {
  main();
} catch (error) {
  console.error("[pack-source] " + error.message);
  process.exitCode = 1;
}
