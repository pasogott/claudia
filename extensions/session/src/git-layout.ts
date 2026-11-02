/**
 * Where a folder sits in git, read straight off the filesystem.
 *
 * Workspace resolution (#107) asks this for every folder it hasn't seen
 * before, so it never spawns `git`: it walks up to the nearest `.git` the way
 * git itself does. A linked worktree's `.git` is a file pointing into the
 * main repository (`gitdir: <main>/.git/worktrees/<name>`), which is how a
 * worktree is recognized wherever it lives, not only under `<repo>.worktrees/`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GitLayout {
  /** The working tree's top folder (what `git rev-parse --show-toplevel` prints). */
  toplevel: string;
  /** For a linked worktree, the main repository's folder; null otherwise. */
  mainRepo: string | null;
}

/** The repository `cwd` is in, or null when it isn't in one. */
export function findGitLayout(cwd: string): GitLayout | null {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        const stats = statSync(dotGit);
        if (stats.isDirectory()) return { toplevel: dir, mainRepo: null };
        if (stats.isFile()) return { toplevel: dir, mainRepo: worktreeMainRepo(dir, dotGit) };
      } catch {
        // Unreadable: keep walking, as if it weren't there.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The main repository a `.git` file points into, when that file belongs to a
 * linked worktree. A submodule's `.git` file points at `.git/modules/…`
 * instead, and is not a worktree.
 */
function worktreeMainRepo(toplevel: string, dotGitFile: string): string | null {
  try {
    const match = readFileSync(dotGitFile, "utf-8").match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return null;
    const gitdir = resolve(toplevel, match[1].trim());
    const worktree = gitdir.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
    return worktree?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The repository a folder under `<repo>.worktrees/` belongs to, by name alone
 * (the layout swarm and Anima's own worktree bootstrap use). This is the
 * fallback for a worktree that has been removed, whose `.git` file is gone.
 */
export function worktreesConventionRoot(cwd: string): string | null {
  const match = cwd.match(/^(.+)\.worktrees(?:\/|$)/);
  return match?.[1] ?? null;
}
