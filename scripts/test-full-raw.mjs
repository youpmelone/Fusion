#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function buildFullTestEnv(env = process.env) {
  const workspaceConcurrency = env.FUSION_TEST_WORKSPACE_CONCURRENCY || "2";
  return {
    env: {
      ...env,
      FUSION_TEST_TOTAL_WORKERS: env.FUSION_TEST_TOTAL_WORKERS || "4",
      FUSION_TEST_CONCURRENCY: env.FUSION_TEST_CONCURRENCY || workspaceConcurrency,
    },
    workspaceConcurrency,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { env: testEnv, workspaceConcurrency } = buildFullTestEnv(env);

  run("pnpm", ["sync:fusion-skill:check"], { env: testEnv });
  run("pnpm", ["-r", `--workspace-concurrency=${workspaceConcurrency}`, "test", ...argv], { env: testEnv });
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
