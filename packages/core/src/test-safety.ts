import { realpathSync, type PathLike } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function pathLikeToString(pathValue: PathLike): string {
  if (typeof pathValue === "string") return pathValue;
  if (pathValue instanceof URL) return fileURLToPath(pathValue);
  return pathValue.toString();
}

function resolveGuardPath(pathValue: PathLike): string {
  const raw = pathLikeToString(pathValue);
  if (!raw || raw === ":memory:") return raw;
  try {
    return realpathSync(raw);
  } catch {
    return resolve(raw);
  }
}

function isSameOrWithin(candidate: string, protectedPath: string): boolean {
  return candidate === protectedPath || candidate.startsWith(protectedPath + sep);
}

export function getProtectedFusionDir(): string | null {
  const root = process.env.FUSION_TEST_REAL_ROOT;
  if (!root) return null;

  const resolvedRoot = resolveGuardPath(root);
  if (!resolvedRoot) return null;
  return join(resolvedRoot, ".fusion");
}

export function getProtectedActiveWorktreeRoot(): string | null {
  const root = process.env.FUSION_ACTIVE_WORKTREE_ROOT;
  if (!root) return null;

  const resolvedRoot = resolveGuardPath(root);
  if (!resolvedRoot || resolvedRoot === ":memory:") return null;
  return resolvedRoot;
}

export function getProtectedActiveWorktreeGitEntry(): string | null {
  const activeRoot = getProtectedActiveWorktreeRoot();
  if (!activeRoot) return null;
  return join(activeRoot, ".git");
}

export function isWithinProtectedFusionDir(pathValue: PathLike): boolean {
  const protectedFusionDir = getProtectedFusionDir();
  if (!protectedFusionDir) return false;

  const candidate = resolveGuardPath(pathValue);
  if (!candidate || candidate === ":memory:") return false;
  return isSameOrWithin(candidate, protectedFusionDir);
}

export function isProtectedActiveWorktreeTarget(pathValue: PathLike): boolean {
  const activeRoot = getProtectedActiveWorktreeRoot();
  if (!activeRoot) return false;

  const candidate = resolveGuardPath(pathValue);
  if (!candidate || candidate === ":memory:") return false;
  if (candidate === activeRoot) return true;

  const gitEntry = getProtectedActiveWorktreeGitEntry();
  return gitEntry ? isSameOrWithin(candidate, gitEntry) : false;
}

export function assertOutsideRealFusionPath(pathValue: PathLike, context = "operation"): void {
  const candidate = resolveGuardPath(pathValue);
  if (!candidate || candidate === ":memory:") return;

  if (isWithinProtectedFusionDir(candidate)) {
    throw new Error(
      `[test-safety] ${context} targeted protected repo .fusion directory: ${candidate}\n` +
      "Tests must operate inside a temp directory. Use tempWorkspace() or useIsolatedCwd().",
    );
  }

  if (isProtectedActiveWorktreeTarget(candidate)) {
    throw new Error(
      `[test-safety] ${context} targeted protected active worktree path: ${candidate}\n` +
      "Tests must never remove, overwrite, rename, or copy over the active checkout root or its .git entry.",
    );
  }
}
