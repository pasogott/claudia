/**
 * Workspace CRUD and project fields.
 *
 * Rows and lookups live in `workspace-db.ts`, folder membership and
 * cwd resolution in `workspace-folders.ts`.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { generateWorkspaceId, createLogger } from "@anima/shared";
import { resolveProjectDir } from "./claude-projects";
import { findGitLayout } from "./git-layout";
import {
  getWorkspace,
  getWorkspaceByRoot,
  getWorkspaceDb,
  listWorkspaceFolders,
  toWorkspace,
  type Workspace,
  type WorkspaceRow,
} from "./workspace-db";
import { addWorkspaceFolder, resolveWorkspaceForCwd } from "./workspace-folders";

const log = createLogger("Workspace", join(homedir(), ".anima", "logs", "session.log"));

/** Project fields settable with `updateWorkspaceProject`. */
export interface WorkspaceProjectFields {
  name?: string;
  description?: string | null;
  aliases?: string[];
  emailDomains?: string[];
  githubRepo?: string | null;
  sentryProjects?: string[];
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Get the most recent JSONL file timestamp for a workspace.
 * Returns ISO string or null if no sessions found.
 */
function getMostRecentSessionTimestamp(cwd: string): string | null {
  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) return null;

  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;

    let mostRecent = 0;
    for (const file of files) {
      try {
        const stats = statSync(join(projectDir, file));
        if (stats.mtimeMs > mostRecent) {
          mostRecent = stats.mtimeMs;
        }
      } catch {
        // skip
      }
    }

    return mostRecent > 0 ? new Date(mostRecent).toISOString() : null;
  } catch {
    return null;
  }
}

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Live workspaces, or with `deleted: true` only the deleted ones, most
 * recently deleted first (the data behind a "recently deleted" view).
 */
export function listWorkspaces(options?: { deleted?: boolean }): Workspace[] {
  if (options?.deleted) {
    const deleted = getWorkspaceDb()
      .query("SELECT * FROM workspaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all() as WorkspaceRow[];
    return deleted.map(toWorkspace);
  }
  const rows = getWorkspaceDb()
    .query("SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    .all() as WorkspaceRow[];

  // Enrich with the most recent transcript in any of the workspace's folders
  // (a worktree's work counts as the project's).
  const workspaces = rows.map((row) => {
    const workspace = toWorkspace(row);
    const folders = new Set([
      row.cwd,
      ...listWorkspaceFolders(row.id)
        .filter((f) => !f.inactiveAt)
        .map((f) => f.path),
    ]);
    let recentTimestamp: string | null = null;
    for (const folder of folders) {
      const timestamp = getMostRecentSessionTimestamp(folder);
      if (timestamp && (!recentTimestamp || timestamp > recentTimestamp)) {
        recentTimestamp = timestamp;
      }
    }
    // Use the most recent session timestamp if available, otherwise fall back to DB updated_at
    if (recentTimestamp) {
      workspace.updatedAt = recentTimestamp;
    }
    return workspace;
  });

  // Pinned workspaces float to the top; within each group, sort by updatedAt
  // descending (most recent first).
  return workspaces.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Pin or unpin a workspace. Pinned workspaces sort to the top of
 * `listWorkspaces()` regardless of last-activity time.
 */
export function setWorkspacePinned(id: string, pinned: boolean): Workspace | null {
  const result = getWorkspaceDb()
    .query("UPDATE workspaces SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id);
  if (result.changes === 0) return null;
  return getWorkspace(id);
}

export function createWorkspace(params: {
  name: string;
  cwd: string;
  general?: boolean;
}): Workspace {
  const id = generateWorkspaceId();
  const conn = getWorkspaceDb();
  conn.transaction(() => {
    conn
      .query("INSERT INTO workspaces (id, name, cwd, general) VALUES (?, ?, ?, ?)")
      .run(id, params.name, params.cwd, params.general ? 1 : 0);
    conn
      .query(
        "INSERT OR IGNORE INTO workspace_folders (path, workspace_id, kind) VALUES (?, ?, 'root')",
      )
      .run(params.cwd, id);
  })();

  return getWorkspace(id)!;
}

/**
 * The workspace for a folder, created if there is none.
 *
 * A deleted workspace for the folder is returned as it is, still deleted,
 * unless `restore` is set. Only an explicit "use this folder as a workspace"
 * (`session.get_or_create_workspace`) restores: this also runs on every
 * prompt and session list, and a tab still open on a workspace would
 * otherwise undo its deletion on the next refetch.
 */
export function getOrCreateWorkspace(
  cwd: string,
  name?: string,
  general?: boolean,
  options?: { restore?: boolean },
): { workspace: Workspace; created: boolean; restored?: boolean } {
  // Expand ~ to home directory
  let expandedCwd = cwd;
  if (cwd.startsWith("~")) {
    expandedCwd = join(homedir(), cwd.slice(1));
  }

  const existing = resolveWorkspaceForCwd(expandedCwd)?.workspace ?? null;
  if (existing?.deletedAt && options?.restore) {
    getWorkspaceDb()
      .query("UPDATE workspaces SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(existing.id);
    log.info("Restored workspace", { cwd: expandedCwd, id: existing.id });
    return { workspace: getWorkspace(existing.id)!, created: false, restored: true };
  }
  if (existing) {
    return { workspace: existing, created: false };
  }

  // Create directory tree if it doesn't exist
  if (!existsSync(expandedCwd)) {
    try {
      mkdirSync(expandedCwd, { recursive: true });
      log.info("Created workspace directory", { cwd: expandedCwd });
    } catch (error) {
      log.error("Failed to create workspace directory", {
        cwd: expandedCwd,
        error: String(error),
      });
      throw new Error(`Failed to create directory: ${expandedCwd}`);
    }
  }

  // Verify it's a directory
  try {
    const stats = statSync(expandedCwd);
    if (!stats.isDirectory()) {
      throw new Error(`Path exists but is not a directory: ${expandedCwd}`);
    }
  } catch (error) {
    log.error("Failed to verify workspace directory", {
      cwd: expandedCwd,
      error: String(error),
    });
    throw error;
  }

  // A worktree of a repo that has no workspace yet starts that repo's
  // workspace, with the worktree as its first extra folder: worktrees are part
  // of their project from the start, not a project of their own.
  const git = findGitLayout(expandedCwd);
  if (git?.mainRepo && existsSync(git.mainRepo)) {
    const workspace = createWorkspace({
      name: name || basename(git.mainRepo),
      cwd: git.mainRepo,
      general,
    });
    addWorkspaceFolder(workspace.id, git.toplevel, "worktree");
    return { workspace, created: true };
  }

  // Derive name from last path segment if not provided
  const derivedName = name || basename(expandedCwd);
  const workspace = createWorkspace({ name: derivedName, cwd: expandedCwd, general });
  return { workspace, created: true };
}

/**
 * Delete a workspace: hide it, keeping the row (and every session that points
 * at it) so `getOrCreateWorkspace(cwd, …, { restore: true })` can bring it back.
 * False when there is no live workspace at that folder.
 */
export function deleteWorkspace(cwd: string): boolean {
  const existing = getWorkspaceByRoot(cwd);
  if (!existing || existing.deletedAt) return false;

  getWorkspaceDb()
    .query("UPDATE workspaces SET deleted_at = datetime('now'), pinned = 0 WHERE id = ?")
    .run(existing.id);
  log.info("Deleted workspace", { cwd, id: existing.id });
  return true;
}

// ── Project fields ───────────────────────────────────────────

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/** Set a workspace's project fields. Omitted fields are left alone; null clears. */
export function updateWorkspaceProject(
  id: string,
  fields: WorkspaceProjectFields,
): Workspace | null {
  const sets: string[] = [];
  const args: Array<string | null> = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (fields.name !== undefined) set("name", fields.name.trim());
  if (fields.description !== undefined) set("description", fields.description?.trim() || null);
  if (fields.aliases !== undefined) set("aliases", JSON.stringify(normalizeList(fields.aliases)));
  if (fields.emailDomains !== undefined) {
    set("email_domains", JSON.stringify(normalizeList(fields.emailDomains)));
  }
  if (fields.githubRepo !== undefined) set("github_repo", fields.githubRepo?.trim() || null);
  if (fields.sentryProjects !== undefined) {
    set("sentry_projects", JSON.stringify(normalizeList(fields.sentryProjects)));
  }
  if (sets.length === 0) return getWorkspace(id);
  sets.push("updated_at = datetime('now')");
  const result = getWorkspaceDb()
    .query(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args, id);
  return result.changes === 0 ? null : getWorkspace(id);
}

/** "owner/repo" from a GitHub remote URL (https or ssh), or null. */
export function parseGithubRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The workspace's GitHub repo from its git `origin` remote, or null. */
export function detectGithubRepo(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  return parseGithubRemote(result.stdout.toString());
}

export interface WorkspaceQuery {
  /** Name or alias, case-insensitive. */
  name?: string;
  /** An email address or a bare domain; subdomains match their parent. */
  email?: string;
  githubRepo?: string;
  sentryProject?: string;
}

/** The one workspace a project reference points at, or null if none (or several) match. */
export function findWorkspace(query: WorkspaceQuery): Workspace | null {
  const rows = getWorkspaceDb()
    .query("SELECT * FROM workspaces WHERE deleted_at IS NULL")
    .all() as WorkspaceRow[];
  const all = rows.map(toWorkspace);
  let matches: Workspace[] = [];

  if (query.name) {
    const wanted = query.name.trim().toLowerCase();
    matches = all.filter((w) => w.name.toLowerCase() === wanted || w.aliases.includes(wanted));
  } else if (query.email) {
    const domain = query.email.trim().toLowerCase().split("@").pop() ?? "";
    matches = all.filter((w) =>
      w.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`)),
    );
  } else if (query.githubRepo) {
    const wanted = query.githubRepo.trim().toLowerCase();
    matches = all.filter((w) => w.githubRepo?.toLowerCase() === wanted);
  } else if (query.sentryProject) {
    const wanted = query.sentryProject.trim().toLowerCase();
    matches = all.filter((w) => w.sentryProjects.includes(wanted));
  }
  return matches.length === 1 ? matches[0] : null;
}
