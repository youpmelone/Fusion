import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDoesNotContainProtectedActiveWorktreePath,
  assertOutsideRealFusionPath,
  containsProtectedActiveWorktreeTarget,
  getProtectedActiveWorktreeGitEntry,
  getProtectedActiveWorktreeRoot,
  isProtectedActiveWorktreeTarget,
} from "../test-safety.js";

const originalEnv = {
  FUSION_ACTIVE_WORKTREE_ROOT: process.env.FUSION_ACTIVE_WORKTREE_ROOT,
  FUSION_TEST_REAL_ROOT: process.env.FUSION_TEST_REAL_ROOT,
};
const tempRoots = new Set<string>();

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

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function activeWorktreeFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fusion-active-worktree-")));
  tempRoots.add(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "packages"));
  return root;
}

function nestedActiveWorktreeFixture(): { parentRoot: string; worktreesDir: string; activeRoot: string } {
  const parentRoot = realpathSync(mkdtempSync(join(tmpdir(), "fusion-active-parent-")));
  tempRoots.add(parentRoot);
  const worktreesDir = join(parentRoot, ".worktrees");
  const activeRoot = join(worktreesDir, "dusky-trout");
  mkdirSync(join(activeRoot, ".git"), { recursive: true });
  return { parentRoot, worktreesDir, activeRoot: realpathSync(activeRoot) };
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

  it("detects destructive ancestor operations that would include the active checkout", () => {
    const { activeRoot, worktreesDir } = nestedActiveWorktreeFixture();
    process.env.FUSION_ACTIVE_WORKTREE_ROOT = activeRoot;

    expect(containsProtectedActiveWorktreeTarget(worktreesDir)).toBe(true);
    expect(() => assertDoesNotContainProtectedActiveWorktreePath(worktreesDir, "fs.rmSync")).toThrow(
      /would include protected active worktree path/,
    );
  });

  it("blocks fs wrappers from removing or renaming the active checkout parent", () => {
    const { activeRoot, parentRoot, worktreesDir } = nestedActiveWorktreeFixture();
    process.env.FUSION_ACTIVE_WORKTREE_ROOT = activeRoot;

    expect(() => rmSync(worktreesDir, { recursive: true, force: true })).toThrow(/would include protected active worktree path/);
    expect(() => renameSync(worktreesDir, join(parentRoot, "worktrees-backup"))).toThrow(/would include protected active worktree path/);
    expect(existsSync(activeRoot)).toBe(true);
  });

  it("preserves the existing protected .fusion guard", () => {
    const repoRoot = activeWorktreeFixture();
    process.env.FUSION_TEST_REAL_ROOT = repoRoot;

    expect(() => assertOutsideRealFusionPath(join(repoRoot, ".fusion", "fusion.db"), "fs.writeFileSync")).toThrow(/protected repo \.fusion directory/);
  });
});
