/**
 * Workspace rows and lookups, shared by `workspace.ts` (CRUD, project fields)
 * and `workspace-folders.ts` (folder membership and resolution).
 *
 * Uses the session extension's one `anima.db` connection: folder operations
 * update `sessions` and `workspaces` in the same transaction, and two Bun
 * SQLite handles on a WAL database only contend for locks.
 */

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { closeSessionDb, getSessionDb } from "./session-store";

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

/** Raw row from SQLite (snake_case) */
export interface WorkspaceRow {
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

interface WorkspaceFolderRow {
  path: string;
  workspace_id: string;
  kind: WorkspaceFolderKind;
  inactive_at: string | null;
  created_at: string;
}

/** Normalize path for display by replacing home directory with ~ */
function normalizePathForDisplay(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
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
export function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd, // Keep full path for operations
    general: row.general === 1,
    pinned: row.pinned === 1,
    cwdDisplay: normalizePathForDisplay(row.cwd),
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

function toWorkspaceFolder(row: WorkspaceFolderRow): WorkspaceFolder {
  return {
    path: row.path,
    workspaceId: row.workspace_id,
    kind: row.kind,
    inactiveAt: row.inactive_at ?? null,
    createdAt: row.created_at,
  };
}

// ── Database ─────────────────────────────────────────────────

/** The connection the workspace columns were last ensured on. */
let ensuredOn: Database | null = null;

/**
 * Columns and tables the gateway migrations create, ensured here too for
 * standalone extension tests. The session store already made `workspaces`.
 */
function ensureWorkspaceSchema(db: Database): void {
  const columns = db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  const wanted: Array<[string, string]> = [
    // Project fields (gateway migration 028).
    ["description", "TEXT"],
    ["aliases", "TEXT NOT NULL DEFAULT '[]'"],
    ["email_domains", "TEXT NOT NULL DEFAULT '[]'"],
    ["github_repo", "TEXT"],
    ["sentry_projects", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [name, type] of wanted) {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${name} ${type}`);
    }
  }

  // Folder membership (gateway migration 035).
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_folders (
      path         TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      kind         TEXT NOT NULL CHECK(kind IN ('root', 'worktree', 'added')),
      inactive_at  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getWorkspaceDb(): Database {
  const db = getSessionDb();
  if (ensuredOn !== db) {
    ensureWorkspaceSchema(db);
    ensuredOn = db;
  }
  return db;
}

/** Close the shared connection (it reopens on the next call). */
export function closeDb(): void {
  closeSessionDb();
  ensuredOn = null;
}

// ── Lookups ──────────────────────────────────────────────────

/**
 * One workspace by id, deleted or not: sessions still point at a deleted
 * workspace, and their status events need its folder.
 */
export function getWorkspace(id: string): Workspace | null {
  const row = getWorkspaceDb()
    .query("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

/**
 * The workspace one of whose folders is exactly `cwd` (its root, a worktree,
 * an added folder), deleted or not. No upward or git lookup: that is
 * `resolveWorkspaceForCwd`.
 */
export function getWorkspaceByCwd(cwd: string): Workspace | null {
  const row = getWorkspaceDb()
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

/** A workspace by its root folder only. */
export function getWorkspaceByRoot(cwd: string): Workspace | null {
  const row = getWorkspaceDb()
    .query("SELECT * FROM workspaces WHERE cwd = ?")
    .get(cwd) as WorkspaceRow | null;
  return row ? toWorkspace(row) : null;
}

export function getWorkspaceFolder(path: string): WorkspaceFolder | null {
  const row = getWorkspaceDb()
    .query("SELECT * FROM workspace_folders WHERE path = ?")
    .get(path) as WorkspaceFolderRow | null;
  return row ? toWorkspaceFolder(row) : null;
}

/** A workspace's folders, root first. */
export function listWorkspaceFolders(workspaceId: string): WorkspaceFolder[] {
  const rows = getWorkspaceDb()
    .query(
      `SELECT * FROM workspace_folders WHERE workspace_id = ?
        ORDER BY kind = 'root' DESC, path`,
    )
    .all(workspaceId) as WorkspaceFolderRow[];
  return rows.map(toWorkspaceFolder);
}
