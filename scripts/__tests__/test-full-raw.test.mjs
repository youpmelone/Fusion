import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFullTestEnv, getNestedWorktreeInfo, resolveActiveWorktreeRoot, tailLines } from "../test-full-raw.mjs";

test("test:full raw env defaults preserve explicit overrides", () => {
  const { env, workspaceConcurrency } = buildFullTestEnv({
    FUSION_TEST_TOTAL_WORKERS: "8",
    FUSION_TEST_CONCURRENCY: "4",
    FUSION_TEST_WORKSPACE_CONCURRENCY: "3",
    VITEST_MAX_WORKERS: "6",
  });

  assert.equal(workspaceConcurrency, "3");
  assert.equal(env.FUSION_TEST_TOTAL_WORKERS, "8");
  assert.equal(env.FUSION_TEST_CONCURRENCY, "4");
  assert.equal(env.VITEST_MAX_WORKERS, "6");
});

test("test:full raw env supplies conservative workspace defaults", () => {
  const { env, workspaceConcurrency } = buildFullTestEnv({});

  assert.equal(workspaceConcurrency, "1");
  assert.equal(env.FUSION_TEST_TOTAL_WORKERS, "1");
  assert.equal(env.FUSION_TEST_CONCURRENCY, "1");
  assert.equal(env.FUSION_TEST_PROCESS_TITLE, "fusion-test-worker");
  assert.match(env.NODE_OPTIONS, /--import=.*test-title-shield\.mjs/);
});

test("test:full raw env preserves existing NODE_OPTIONS while installing title shield", () => {
  const { env } = buildFullTestEnv({ NODE_OPTIONS: "--trace-warnings" });

  assert.match(env.NODE_OPTIONS, /^--trace-warnings /);
  assert.match(env.NODE_OPTIONS, /--import=.*test-title-shield\.mjs/);
});

function createNestedWorktreeFixture() {
  const parentRoot = mkdtempSync(path.join(tmpdir(), "fusion-parent-"));
  const worktreeRoot = path.join(parentRoot, ".worktrees", "dusky-trout");
  mkdirSync(worktreeRoot, { recursive: true });
  return { parentRoot: realpathSync(parentRoot), worktreeRoot: realpathSync(worktreeRoot) };
}

test("test:full raw detects a worktree under a parent .worktrees directory", () => {
  const { parentRoot, worktreeRoot } = createNestedWorktreeFixture();

  const info = getNestedWorktreeInfo(worktreeRoot);

  assert.equal(info.isNestedWorktree, true);
  assert.equal(info.worktreeRoot, worktreeRoot);
  assert.equal(info.parentRoot, parentRoot);
  assert.equal(info.worktreeSlug, "dusky-trout");
});

test("test:full raw publishes the active nested worktree root to child test processes", () => {
  const { worktreeRoot } = createNestedWorktreeFixture();

  const { env, activeWorktree } = buildFullTestEnv({}, { cwd: worktreeRoot, spawn: () => ({ status: 0, stdout: `${worktreeRoot}\n` }) });

  assert.equal(activeWorktree.isNestedWorktree, true);
  assert.equal(env.FUSION_ACTIVE_WORKTREE_ROOT, worktreeRoot);
  assert.equal(env.FUSION_TEST_NESTED_WORKTREE, "1");
});

test("test:full raw honors an explicit active worktree root when git output is unavailable", () => {
  const { worktreeRoot } = createNestedWorktreeFixture();

  const info = resolveActiveWorktreeRoot({
    cwd: path.join(worktreeRoot, "packages", "core"),
    env: { FUSION_ACTIVE_WORKTREE_ROOT: worktreeRoot },
    spawn: () => ({ status: 1, stdout: "", stderr: "not a git repo" }),
  });

  assert.equal(info.isNestedWorktree, true);
  assert.equal(info.worktreeRoot, worktreeRoot);
});

test("test:full raw log tail keeps the last requested lines", () => {
  assert.equal(tailLines("one\ntwo\nthree", 2), "two\nthree");
});

test("test:full raw does not turn SIGKILL-style package failures into success", () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "fusion-test-full-")), "package.log");
  const moduleUrl = pathToFileURL(path.resolve("scripts/test-full-raw.mjs")).href;
  const script = `
    import { runLogged } from ${JSON.stringify(moduleUrl)};
    runLogged(process.execPath, ["-e", "console.error('worker died with SIGKILL / exit code 137'); process.exit(137)"], {
      env: { ...process.env, FUSION_TEST_FULL_LOG: ${JSON.stringify(logPath)} },
    });
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
  });

  assert.equal(result.status, 137);
  assert.match(result.stderr, /worker died with SIGKILL \/ exit code 137/);
  assert.doesNotMatch(result.stdout, /package tests passed/);
});

