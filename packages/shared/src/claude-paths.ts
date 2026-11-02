/**
 * Claude Code's on-disk layout, in one place.
 *
 * Claude Code keeps a folder's transcripts in `~/.claude/projects/<slug>/`,
 * where the slug is the absolute path with every character other than an
 * ASCII letter or digit replaced by `-`. Verified against Claude Code itself:
 * `/a/b.c/slug_probe dir+x` becomes `-a-b-c-slug-probe-dir-x`, so `.` in
 * `swarm.worktrees` and `.hammerspoon` turns into `-` like everything else.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** `~/.claude/projects`, where every folder's transcripts live. */
export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** The transcript folder Claude Code uses for `cwd` (it may not exist yet). */
export function claudeProjectDir(cwd: string): string {
  return join(claudeProjectsDir(), claudeProjectSlug(cwd));
}
