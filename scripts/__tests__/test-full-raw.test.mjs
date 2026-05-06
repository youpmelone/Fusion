import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFullTestEnv, tailLines } from "../test-full-raw.mjs";

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

