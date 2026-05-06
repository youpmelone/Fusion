#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
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

export function buildFullTestEnv(env = process.env) {
  const workspaceConcurrency = env.FUSION_TEST_WORKSPACE_CONCURRENCY || "1";
  return {
    env: {
      ...env,
      FUSION_TEST_TOTAL_WORKERS: env.FUSION_TEST_TOTAL_WORKERS || "1",
      FUSION_TEST_CONCURRENCY: env.FUSION_TEST_CONCURRENCY || workspaceConcurrency,
      FUSION_TEST_PROCESS_TITLE: env.FUSION_TEST_PROCESS_TITLE || "fusion-test-worker",
      NODE_OPTIONS: withTitleShieldNodeOptions(env.NODE_OPTIONS),
    },
    workspaceConcurrency,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { env: testEnv, workspaceConcurrency } = buildFullTestEnv(env);

  run("pnpm", ["sync:fusion-skill:check"], { env: testEnv });
  runLogged("pnpm", ["-r", `--workspace-concurrency=${workspaceConcurrency}`, "test", ...argv], { env: testEnv });
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
