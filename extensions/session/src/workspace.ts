/**
 * Workspace CRUD
 *
 * Owns the workspace table in ~/.anima/anima.db.
 * Opens its own SQLite connection (WAL mode) for concurrent access
 * with the gateway process.
 *
 * Note: activeSessionId removed — sessions are read from filesystem.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { generateWorkspaceId, createLogger } from "@anima/shared";
import { resolveProjectDir } from "./claude-projects";
import { findGitLayout, worktreesConventionRoot } from "./git-layout";

const log = createLogger("Workspace", join(homedir(), ".anima", "logs", "session.log"));

// ── Types ────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  general: boolean;
  /** User-pinned — sorts to the top of the workspace list with a visual badge. */
  pinned: boolean;
  cwdDisplay: string; // Normalized path with ~ for display
  /** One line about the project, for humans and for routing. */
  description: string | null;
  /** Other names the project goes by ("nutwords", "the nuthouse"). Lowercase. */
  aliases: string[];
  /** Email domains that belong to the project ("nutwords.com"). Lowercase. */
  emailDomains: string[];
  /** "owner/repo" on GitHub. */
  githubRepo: string | null;
  /** Sentry project slugs (a project can have several, e.g. API and web). Lowercase. */
  sentryProjects: string[];
  createdAt: string;
  updatedAt: string;
  /** When it was deleted; null while live. Deleted workspaces are hidden, not gone. */
  deletedAt: string | null;
}

/** How a folder came to be part of a workspace. */
export type WorkspaceFolderKind = "root" | "worktree" | "added";

/**
 * One folder of a workspace (#107). A workspace is its root plus any git
 * worktrees of its repo and folders added by hand; each folder belongs to at
 * most one workspace.
 */
export interface WorkspaceFolder {
  path: string;
  workspaceId: string;
  kind: WorkspaceFolderKind;
  /** Set when the folder moved or is gone. It stays a member so its sessions keep their workspace. */
  inactiveAt: string | null;
  createdAt: string;
}

interface WorkspaceFolderRow {
  path: string;
  workspace_id: string;
  kind: WorkspaceFolderKind;
  inactive_at: string | null;
  created_at: string;
}

function toWorkspaceFolder(row: WorkspaceFolderRow): WorkspaceFolder {
  return {
    path: row.path,
    workspaceId: row.workspace_id,
    kind: row.kind,
    inactiveAt: row.inactive_at ?? null,
    createdAt: row.created_at,
  };
}

/** Project fields settable with `updateWorkspaceProject`. */
export interface WorkspaceProjectFields {
  name?: string;
  description?: string | null;
  aliases?: string[];
  emailDomains?: string[];
  githubRepo?: string | null;
  sentryProjects?: string[];
}

/** Raw row from SQLite (snake_case) */
interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
  general: number;
  pinned: number;
  active_session_id: string | null; // Still in schema but we ignore it
  description: string | null;
  aliases: string;
  email_domains: string;
  github_repo: string | null;
  sentry_projects: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Normalize path for display by replacing home directory with ~
 */
function normalizePathForDisplay(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

function parseList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Convert DB row to API type */
function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd, // Keep full path for operations
    general: row.general === 1,
    pinned: row.pinned === 1,
    cwdDisplay: normalizePathForDisplay(row.cwd), // Normalized for display
    description: row.description ?? null,
    aliases: parseList(row.aliases),
    emailDomains: parseList(row.email_domains),
    githubRepo: row.github_repo ?? null,
    sentryProjects: parseList(row.sentry_projects),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

// ── Database ─────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  const claudiaDir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  if (!existsSync(claudiaDir)) {
    mkdirSync(claudiaDir, { recursive: true });
  }

  const dbPath = join(claudiaDir, "anima.db");
  db = new Database(dbPath);

  // WAL mode for concurrent access with gateway
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  // Ensure workspaces table exists (gateway migrations create it,
  // but we need this for standalone extension testing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      general INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      active_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const columns = db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "general")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN general INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "pinned")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  // Project fields (gateway migration 028); added here for standalone tests.
  const projectColumns: Array<[string, string]> = [
    ["description", "TEXT"],
    ["aliases", "TEXT NOT NULL DEFAULT '[]'"],
    ["email_domains", "TEXT NOT NULL DEFAULT '[]'"],
    ["github_repo", "TEXT"],
    ["sentry_projects", "TEXT NOT NULL DEFAULT '[]'"],
    // Soft delete (gateway migration 033).
    ["deleted_at", "TEXT"],
  ];
  for (const [name, type] of projectColumns) {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${name} ${type}`);
    }
  }

  // Folder membership (gateway migration 035); created here for standalone tests.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_folders (
      path         TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      kind         TEXT NOT NULL CHECK(kind IN ('root', 'worktree', 'added')),
      inactive_at  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  log.info("Opened workspace database", { path: dbPath });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
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
    const deleted = getDb()
      .query("SELECT * FROM workspaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all() as WorkspaceRow[];
    return deleted.map(toWorkspace);
  }
  const rows = getDb()
    .query("SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    .all() as WorkspaceRow[];

  // Enrich with most recent session timestamp from filesystem
  const workspaces = rows.map((row) => {
    const workspace = toWorkspace(row);
    const recentTimestamp = getMostRecentSessionTimestamp(row.cwd);
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
  const result = getDb()
    .query("UPDATE workspaces SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id);
  if (result.changes === 0) return null;
  return getWorkspace(id);
}

/**
 * One workspace by id or folder, deleted or not: sessions still point at a
 * deleted workspace, and their status events need its folder.
 */
export function getWorkspace(id: string): Workspace | null {
  const row = getDb().query("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

/**
 * The workspace one of whose folders is exactly `cwd` (its root, a worktree,
 * an added folder), deleted or not. No upward or git lookup: that is
 * `resolveWorkspaceForCwd`.
 */
export function getWorkspaceByCwd(cwd: string): Workspace | null {
  const row = getDb()
    .query(
      `SELECT w.* FROM workspace_folders f JOIN workspaces w ON w.id = f.workspace_id
        WHERE f.path = ?1
       UNION ALL
       SELECT * FROM workspaces WHERE cwd = ?1
       LIMIT 1`,
    )
    .get(cwd) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

/** A workspace's root, by its root folder only. */
function getWorkspaceByRoot(cwd: string): Workspace | null {
  const row = getDb()
    .query("SELECT * FROM workspaces WHERE cwd = ?")
    .get(cwd) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

export function createWorkspace(params: {
  name: string;
  cwd: string;
  general?: boolean;
}): Workspace {
  const id = generateWorkspaceId();
  const conn = getDb();
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

// ── Folders ──────────────────────────────────────────────────

export function getWorkspaceFolder(path: string): WorkspaceFolder | null {
  const row = getDb()
    .query("SELECT * FROM workspace_folders WHERE path = ?")
    .get(path) as WorkspaceFolderRow | null;
  return row ? toWorkspaceFolder(row) : null;
}

/** A workspace's folders, root first. */
export function listWorkspaceFolders(workspaceId: string): WorkspaceFolder[] {
  const rows = getDb()
    .query(
      `SELECT * FROM workspace_folders WHERE workspace_id = ?
        ORDER BY kind = 'root' DESC, path`,
    )
    .all(workspaceId) as WorkspaceFolderRow[];
  return rows.map(toWorkspaceFolder);
}

/**
 * Make `path` a folder of the workspace. A folder already in this workspace
 * is returned as it is; one that belongs to another workspace is refused,
 * because a folder (and the sessions in it) can only be filed in one place.
 */
export function addWorkspaceFolder(
  workspaceId: string,
  path: string,
  kind: Exclude<WorkspaceFolderKind, "root">,
): WorkspaceFolder {
  const existing = getWorkspaceFolder(path);
  if (existing) {
    if (existing.workspaceId === workspaceId) return existing;
    throw new Error(`${path} already belongs to workspace ${existing.workspaceId}`);
  }
  getDb()
    .query("INSERT INTO workspace_folders (path, workspace_id, kind) VALUES (?, ?, ?)")
    .run(path, workspaceId, kind);
  log.info("Added workspace folder", { workspaceId, path, kind });
  return getWorkspaceFolder(path)!;
}

// ── Resolution ───────────────────────────────────────────────

/** How `resolveWorkspaceForCwd` placed a folder. */
export type WorkspaceMatch =
  | "folder" // cwd is one of the workspace's folders
  | "subfolder" // cwd is inside a member folder's git repository
  | "worktree"; // cwd is in a git worktree of a member repository (now a member itself)

/**
 * The workspace a folder belongs to, or null when none does. The one place a
 * cwd becomes a workspace (#107); every caller goes through it via
 * `getOrCreateWorkspace`.
 *
 * 1. `cwd` is a member folder.
 * 2. `cwd` is inside a git repository whose top folder is a member
 *    (`packages/foo` of a member repo).
 * 3. `cwd` is in a linked git worktree of a member repository, wherever the
 *    worktree lives. The worktree's top folder joins as a `worktree` member.
 * 4. `cwd` is under `<member>.worktrees/` but has no `.git` to read (a
 *    removed worktree). The folder joins as a `worktree` member.
 *
 * Subfolders join only through git, never by path prefix: a workspace at `~`
 * would otherwise swallow every project under it.
 */
export function resolveWorkspaceForCwd(
  cwd: string,
): { workspace: Workspace; match: WorkspaceMatch } | null {
  const direct = getWorkspaceByCwd(cwd);
  if (direct) return { workspace: direct, match: "folder" };

  const git = findGitLayout(cwd);
  if (git && git.toplevel !== cwd) {
    const owner = getWorkspaceByCwd(git.toplevel);
    if (owner) return { workspace: owner, match: "subfolder" };
  }

  const mainRepo = git?.mainRepo ?? (git ? null : worktreesConventionRoot(cwd));
  if (mainRepo) {
    const owner = getWorkspaceByCwd(mainRepo);
    if (owner) {
      addWorkspaceFolder(owner.id, git?.toplevel ?? cwd, "worktree");
      return { workspace: owner, match: "worktree" };
    }
  }

  return null;
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
    getDb()
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

  getDb()
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
  const result = getDb()
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
  const rows = getDb()
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
