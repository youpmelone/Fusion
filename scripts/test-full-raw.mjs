#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const titleShieldImportFlag = `--import=${path.resolve(dirname(currentFilePath), "test-title-shield.mjs")}`;

function withTitleShieldNodeOptions(nodeOptions) {
  return nodeOptions ? `${nodeOptions} ${titleShieldImportFlag}` : titleShieldImportFlag;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function safeRealpath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function getGitToplevel(cwd = process.cwd(), spawn = spawnSync) {
  const result = spawn("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) {
    return null;
  }

  return result.stdout.trim();
}

export function getNestedWorktreeInfo(worktreeRoot) {
  const resolvedRoot = safeRealpath(worktreeRoot);
  const parts = resolvedRoot.split(sep).filter(Boolean);
  const worktreesIndex = parts.lastIndexOf(".worktrees");

  if (worktreesIndex < 0 || worktreesIndex >= parts.length - 1) {
    return { isNestedWorktree: false, worktreeRoot: resolvedRoot, parentRoot: null, worktreeSlug: null };
  }

  const rootPrefix = resolvedRoot.startsWith(sep) ? sep : "";
  const parentParts = parts.slice(0, worktreesIndex);
  const parentRoot = parentParts.length > 0 ? rootPrefix + path.join(...parentParts) : rootPrefix || sep;
  const worktreeSlug = parts[worktreesIndex + 1];
  const directWorktreeRoot = path.join(parentRoot, ".worktrees", worktreeSlug);
  const rel = relative(directWorktreeRoot, resolvedRoot);
  const isWithinDirectWorktree = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));

  return {
    isNestedWorktree: isWithinDirectWorktree,
    worktreeRoot: resolvedRoot,
    parentRoot,
    worktreeSlug,
  };
}

export function resolveActiveWorktreeRoot({ cwd = process.cwd(), env = process.env, spawn = spawnSync } = {}) {
  const explicitRoot = env.FUSION_ACTIVE_WORKTREE_ROOT;
  const rawRoot = explicitRoot || getGitToplevel(cwd, spawn) || cwd;
  const worktreeRoot = safeRealpath(rawRoot);
  return getNestedWorktreeInfo(worktreeRoot);
}

function logActiveWorktreeDiagnostic(info) {
  if (info.isNestedWorktree) {
    console.log(
      `[test-full-raw] active worktree root: ${info.worktreeRoot} ` +
      `(nested under ${path.join(info.parentRoot, ".worktrees", info.worktreeSlug)}); protecting it during tests.`,
    );
    return;
  }

  console.log(`[test-full-raw] active worktree root: ${info.worktreeRoot}`);
}

export function tailLines(content, lineCount = 120) {
  return content.split(/\r?\n/).slice(-lineCount).join("\n");
}

function readLog(logPath) {
  try {
    return readFileSync(logPath, "utf-8");
  } catch {
    return "";
  }
}

export function runLogged(command, commandArgs, options = {}) {
  const logPath = options.env?.FUSION_TEST_FULL_LOG || path.join(tmpdir(), `fusion-test-full-${process.pid}.log`);
  const logFd = openSync(logPath, "w");
  let result;
  try {
    console.log(`[test-full-raw] writing package test output to ${logPath}`);
    result = spawnSync(command, commandArgs, {
      cwd: process.cwd(),
      stdio: ["ignore", logFd, logFd],
      ...options,
    });
  } finally {
    closeSync(logFd);
  }

  if (result.status !== 0) {
    console.error(`[test-full-raw] package tests failed; last log lines from ${logPath}:`);
    const logContent = readLog(logPath);
    if (logContent) {
      console.error(tailLines(logContent));
    } else {
      console.error("[test-full-raw] could not read log.");
    }
    process.exit(result.status ?? 1);
  }

  console.log(`[test-full-raw] package tests passed; full log at ${logPath}`);
}

export function buildFullTestEnv(env = process.env, options = {}) {
  const workspaceConcurrency = env.FUSION_TEST_WORKSPACE_CONCURRENCY || "1";
  const activeWorktree = resolveActiveWorktreeRoot({ env, ...options });
  return {
    env: {
      ...env,
      FUSION_ACTIVE_WORKTREE_ROOT: activeWorktree.worktreeRoot,
      FUSION_TEST_NESTED_WORKTREE: activeWorktree.isNestedWorktree ? "1" : "0",
      FUSION_TEST_TOTAL_WORKERS: env.FUSION_TEST_TOTAL_WORKERS || "1",
      FUSION_TEST_CONCURRENCY: env.FUSION_TEST_CONCURRENCY || workspaceConcurrency,
      FUSION_TEST_PROCESS_TITLE: env.FUSION_TEST_PROCESS_TITLE || "fusion-test-worker",
      NODE_OPTIONS: withTitleShieldNodeOptions(env.NODE_OPTIONS),
    },
    workspaceConcurrency,
    activeWorktree,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { env: testEnv, workspaceConcurrency, activeWorktree } = buildFullTestEnv(env);
  logActiveWorktreeDiagnostic(activeWorktree);

  run("pnpm", ["sync:fusion-skill:check"], { env: testEnv });
  runLogged("pnpm", ["-r", `--workspace-concurrency=${workspaceConcurrency}`, "test", ...argv], { env: testEnv });
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
