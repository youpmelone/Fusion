import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const runVtPath = join(repoRoot, "scripts", "run-vt.mjs");
const titleShieldPath = join(repoRoot, "scripts", "test-title-shield.mjs");

test("run-vt installs the title shield for Vitest workers", () => {
  const source = readFileSync(runVtPath, "utf-8");

  assert.match(source, /test-title-shield\.mjs/);
  assert.match(source, /--import=/);
  assert.match(source, /FUSION_TEST_PROCESS_TITLE/);
});

test("test-title-shield neutralizes Vitest-like process titles", () => {
  const script = `
    process.title = "vitest worker";
    setTimeout(() => {
      console.log(process.title);
    }, 150);
  `;

  const result = spawnSync(process.execPath, ["--import", titleShieldPath, "--eval", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      FUSION_TEST_PROCESS_TITLE: "fusion-test-worker-contract",
    },
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "fusion-test-worker-contract");
});
