#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REQUIRED_BUILD_PACKAGES = [
  { name: "@fusion/core", distEntry: "packages/core/dist/index.js" },
  { name: "@fusion/plugin-sdk", distEntry: "packages/plugin-sdk/dist/index.js" },
  { name: "@fusion-plugin-examples/hermes-runtime", distEntry: "plugins/fusion-plugin-hermes-runtime/dist/index.js" },
  { name: "@fusion-plugin-examples/openclaw-runtime", distEntry: "plugins/fusion-plugin-openclaw-runtime/dist/index.js" },
  { name: "@fusion-plugin-examples/paperclip-runtime", distEntry: "plugins/fusion-plugin-paperclip-runtime/dist/index.js" },
];

export function detectMissingArtifacts(rootDir = process.cwd(), existsFn = existsSync) {
  return REQUIRED_BUILD_PACKAGES.filter((pkg) => !existsFn(path.join(rootDir, pkg.distEntry)));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function ensureTestArtifacts(rootDir = process.cwd(), runFn = run, existsFn = existsSync) {
  const missing = detectMissingArtifacts(rootDir, existsFn);
  if (missing.length === 0) return [];

  const names = missing.map((pkg) => pkg.name);
  console.log(`[test-bootstrap] building missing dist artifacts: ${names.join(", ")}`);
  runFn("pnpm", [...names.flatMap((name) => ["--filter", name]), "build"], rootDir);
  return names;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTestArtifacts();
}
