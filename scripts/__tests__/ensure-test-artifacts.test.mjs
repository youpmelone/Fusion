import test from "node:test";
import assert from "node:assert/strict";
import { detectMissingArtifacts, ensureTestArtifacts } from "../ensure-test-artifacts.mjs";

test("detectMissingArtifacts returns missing package list", () => {
  const missing = detectMissingArtifacts("/repo", () => false);
  assert.ok(missing.length >= 5);
  assert.equal(missing[0].name, "@fusion/core");
});

test("ensureTestArtifacts skips build when nothing is missing", () => {
  let called = false;
  const built = ensureTestArtifacts("/repo", () => {
    called = true;
  }, () => true);

  assert.equal(called, false);
  assert.deepEqual(built, []);
});

test("ensureTestArtifacts builds only missing packages", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.includes("fusion-plugin-openclaw-runtime"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});
