import test from "node:test";
import assert from "node:assert/strict";
import { buildFullTestEnv } from "../test-full-raw.mjs";

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

  assert.equal(workspaceConcurrency, "2");
  assert.equal(env.FUSION_TEST_TOTAL_WORKERS, "4");
  assert.equal(env.FUSION_TEST_CONCURRENCY, "2");
});
