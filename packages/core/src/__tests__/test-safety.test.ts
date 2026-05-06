import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOutsideRealFusionPath,
  getProtectedActiveWorktreeGitEntry,
  getProtectedActiveWorktreeRoot,
  isProtectedActiveWorktreeTarget,
} from "../test-safety.js";

const originalEnv = {
  FUSION_ACTIVE_WORKTREE_ROOT: process.env.FUSION_ACTIVE_WORKTREE_ROOT,
  FUSION_TEST_REAL_ROOT: process.env.FUSION_TEST_REAL_ROOT,
};

afterEach(() => {
  if (originalEnv.FUSION_ACTIVE_WORKTREE_ROOT === undefined) {
    delete process.env.FUSION_ACTIVE_WORKTREE_ROOT;
  } else {
    process.env.FUSION_ACTIVE_WORKTREE_ROOT = originalEnv.FUSION_ACTIVE_WORKTREE_ROOT;
  }

  if (originalEnv.FUSION_TEST_REAL_ROOT === undefined) {
    delete process.env.FUSION_TEST_REAL_ROOT;
  } else {
    process.env.FUSION_TEST_REAL_ROOT = originalEnv.FUSION_TEST_REAL_ROOT;
  }
});

function activeWorktreeFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-active-worktree-")));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "packages"));
  return root;
}

describe("test safety active worktree protection", () => {
  it("protects the active worktree root and its .git entry", () => {
    const activeRoot = activeWorktreeFixture();
    process.env.FUSION_ACTIVE_WORKTREE_ROOT = activeRoot;

    expect(getProtectedActiveWorktreeRoot()).toBe(activeRoot);
    expect(getProtectedActiveWorktreeGitEntry()).toBe(join(activeRoot, ".git"));
    expect(isProtectedActiveWorktreeTarget(activeRoot)).toBe(true);
    expect(isProtectedActiveWorktreeTarget(join(activeRoot, ".git"))).toBe(true);
    expect(isProtectedActiveWorktreeTarget(join(activeRoot, ".git", "config"))).toBe(true);
  });

  it("does not block ordinary temp workspace paths inside the active checkout", () => {
    const activeRoot = activeWorktreeFixture();
    process.env.FUSION_ACTIVE_WORKTREE_ROOT = activeRoot;

    expect(isProtectedActiveWorktreeTarget(join(activeRoot, "packages", "core"))).toBe(false);
    expect(() => assertOutsideRealFusionPath(join(activeRoot, "packages", "core", "tmp.txt"), "write temp file")).not.toThrow();
  });

  it("throws a clear error when a write-capable operation targets the active checkout root", () => {
    const activeRoot = activeWorktreeFixture();
    process.env.FUSION_ACTIVE_WORKTREE_ROOT = activeRoot;

    expect(() => assertOutsideRealFusionPath(activeRoot, "fs.rmSync")).toThrow(/protected active worktree path/);
  });

  it("preserves the existing protected .fusion guard", () => {
    const repoRoot = activeWorktreeFixture();
    process.env.FUSION_TEST_REAL_ROOT = repoRoot;

    expect(() => assertOutsideRealFusionPath(join(repoRoot, ".fusion", "fusion.db"), "fs.writeFileSync")).toThrow(/protected repo \.fusion directory/);
  });
});
