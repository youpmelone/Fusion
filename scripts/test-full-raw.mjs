#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) {
    console.error(`[test-full-raw] failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const listResult = spawnSync("pnpm", ["-r", "--json", "list", "--depth", "-1"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  shell: false,
});
if (listResult.error) {
  console.error(`[test-full-raw] failed to list workspaces: ${listResult.error.message}`);
  process.exit(1);
}
if (listResult.status !== 0) process.exit(listResult.status ?? 1);

const workspaces = JSON.parse(listResult.stdout || "[]");
const rootDir = resolve(process.cwd());
const priority = [
  "/packages/core",
  "/packages/desktop",
  "/packages/mobile",
  "/packages/pi-claude-cli",
  "/packages/pi-llama-cpp",
  "/packages/engine",
  "/packages/plugin-sdk",
  "/plugins/examples/",
  "/plugins/fusion-plugin-dependency-graph",
  "/plugins/fusion-plugin-droid-runtime",
  "/plugins/fusion-plugin-hermes-runtime",
  "/plugins/fusion-plugin-openclaw-runtime",
  "/plugins/fusion-plugin-paperclip-runtime",
  "/packages/droid-cli",
  "/packages/dashboard",
  "/packages/cli",
];
function priorityFor(workspace) {
  const normalized = resolve(workspace.path).replaceAll("\\", "/");
  const index = priority.findIndex((entry) => normalized.includes(entry));
  return index === -1 ? 1_000 : index;
}
workspaces.sort((left, right) => priorityFor(left) - priorityFor(right) || String(left.name).localeCompare(String(right.name)));
for (const workspace of workspaces) {
  const name = workspace.name;
  const path = workspace.path;
  if (!name || !path || resolve(path) === rootDir) continue;
  const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  if (!pkg.scripts?.test) continue;
  console.log(`\n[test-full-raw] ${name}`);
  run("pnpm", ["--filter", name, "test"], {
    env: {
      ...process.env,
      FUSION_TEST_TOTAL_WORKERS: process.env.FUSION_TEST_TOTAL_WORKERS ?? "1",
      FUSION_TEST_CONCURRENCY: process.env.FUSION_TEST_CONCURRENCY ?? "1",
      VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "1",
      VITEST_MIN_WORKERS: process.env.VITEST_MIN_WORKERS ?? "1",
    },
  });
}
