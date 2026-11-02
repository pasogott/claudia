/**
 * Workspace folders (#107): which folders make up a workspace, how a cwd finds
 * its workspace, and the hand-run folder operations (add, remove, set root,
 * move, merge) behind `session.update_workspace`.
 *
 * Claude Code files transcripts per folder (`~/.claude/projects/<slug>`), so
 * operations that change a folder's path link the new slug to the old one.
 * They never rename the old one: Libby keys ingested files by path, and a
 * renamed transcript would be ingested again as a new file. Her directory walk
 * doesn't follow symlinks, so the link is never read twice.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claudeProjectDir, createLogger } from "@anima/shared";
import { resolveProjectDir } from "./claude-projects";
import { findGitLayout, worktreesConventionRoot } from "./git-layout";
import {
  getWorkspace,
  getWorkspaceByCwd,
  getWorkspaceByRoot,
  getWorkspaceDb,
  getWorkspaceFolder,
  listWorkspaceFolders,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceFolderKind,
} from "./workspace-db";

const log = createLogger("Workspace", join(homedir(), ".anima", "logs", "session.log"));

// ── Membership ───────────────────────────────────────────────

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
  getWorkspaceDb()
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

// ── Folder operations ────────────────────────────────────────

/** What a folder operation did, for the caller to show. */
export interface FolderOperationResult {
  workspace: Workspace;
  folders: WorkspaceFolder[];
  /** One line per thing done or deliberately left alone (links, merges, skips). */
  notes: string[];
}

/** An absolute folder path: `~` expanded, no trailing slash. */
export function normalizeFolderPath(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return resolve(expanded);
}

function requireDirectory(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }
}

function requireMember(workspace: Workspace, path: string): WorkspaceFolder {
  const folder = getWorkspaceFolder(path);
  if (!folder || folder.workspaceId !== workspace.id) {
    throw new Error(`${path} is not a folder of workspace ${workspace.name}`);
  }
  return folder;
}

function requireWorkspace(id: string): Workspace {
  const workspace = getWorkspace(id);
  if (!workspace) throw new Error(`Unknown workspace: ${id}`);
  return workspace;
}

function result(workspaceId: string, notes: string[]): FolderOperationResult {
  return {
    workspace: requireWorkspace(workspaceId),
    folders: listWorkspaceFolders(workspaceId),
    notes,
  };
}

/**
 * The kind a folder joins `workspace` as: a git worktree of one of its
 * folders is a `worktree`, anything else is `added`.
 */
function joiningKind(workspace: Workspace, path: string): Exclude<WorkspaceFolderKind, "root"> {
  const mainRepo = findGitLayout(path)?.mainRepo;
  return mainRepo && getWorkspaceFolder(mainRepo)?.workspaceId === workspace.id
    ? "worktree"
    : "added";
}

/**
 * Pin sessions that have no stored folder to the root they implicitly run in,
 * before the root changes under them (a NULL `sessions.cwd` reads as the
 * workspace's root).
 */
function pinRootlessSessions(workspace: Workspace): void {
  getWorkspaceDb()
    .query("UPDATE sessions SET cwd = ? WHERE workspace_id = ? AND cwd IS NULL")
    .run(workspace.cwd, workspace.id);
}

/**
 * Add a folder to a workspace. A folder that is another workspace's root
 * merges that workspace in when `merge` is set (its sessions, folders and
 * support tickets move over, its project fields are folded in, and it is
 * deleted); otherwise it's refused.
 * An inactive folder of this workspace is made active again.
 */
export function addFolder(
  workspaceId: string,
  rawPath: string,
  options: { merge?: boolean } = {},
): FolderOperationResult {
  const workspace = requireWorkspace(workspaceId);
  const path = normalizeFolderPath(rawPath);
  requireDirectory(path);
  const notes: string[] = [];

  const existing = getWorkspaceFolder(path);
  if (existing?.workspaceId === workspace.id) {
    if (existing.inactiveAt) {
      getWorkspaceDb()
        .query("UPDATE workspace_folders SET inactive_at = NULL WHERE path = ?")
        .run(path);
      notes.push(`${path} is active again`);
    } else {
      notes.push(`${path} is already a folder of this workspace`);
    }
    return result(workspace.id, notes);
  }

  const owner = existing ? getWorkspace(existing.workspaceId) : getWorkspaceByRoot(path);
  if (owner) {
    if (owner.cwd !== path) {
      throw new Error(
        `${path} belongs to workspace ${owner.name} (${owner.id}); remove it there first`,
      );
    }
    if (!options.merge) {
      throw new Error(
        `${path} is the root of workspace ${owner.name} (${owner.id}); pass merge: true to merge it into ${workspace.name}`,
      );
    }
    notes.push(...mergeWorkspace(owner, workspace));
    return result(workspace.id, notes);
  }

  const kind = joiningKind(workspace, path);
  addWorkspaceFolder(workspace.id, path, kind);
  notes.push(`added ${path} (${kind})`);
  if (kind === "added") notes.push(linkAutoMemory(workspace.cwd, path));
  return result(workspace.id, notes);
}

/**
 * Merge `source` into `target`: every session, folder and support ticket of
 * `source` moves to `target`, its project fields are folded in (lists joined;
 * repo and description only where `target` has none), and the `source` row is
 * deleted, since nothing points at it any more and its root path must be free
 * to become `target`'s. Its root joins as a `worktree` when it is one of the
 * target's repo, otherwise as `added`.
 */
function mergeWorkspace(source: Workspace, target: Workspace): string[] {
  if (source.id === target.id) return [];
  const db = getWorkspaceDb();
  const rootKind = joiningKind(target, source.cwd);
  const joined = (a: string[], b: string[]) => JSON.stringify([...new Set([...a, ...b])]);
  let sessions = 0;
  let folders = 0;
  let tickets = 0;

  db.transaction(() => {
    const current = getWorkspace(target.id) ?? target;
    db.query(
      `UPDATE workspaces SET aliases = ?, email_domains = ?, sentry_projects = ?,
         github_repo = COALESCE(github_repo, ?), description = COALESCE(description, ?)
       WHERE id = ?`,
    ).run(
      joined(current.aliases, source.aliases),
      joined(current.emailDomains, source.emailDomains),
      joined(current.sentryProjects, source.sentryProjects),
      source.githubRepo,
      source.description,
      target.id,
    );
    pinRootlessSessions(source);
    sessions = db
      .query("UPDATE sessions SET workspace_id = ? WHERE workspace_id = ?")
      .run(target.id, source.id).changes;
    folders = db
      .query(
        `UPDATE workspace_folders SET workspace_id = ?1,
           kind = CASE WHEN kind = 'root' THEN ?3 ELSE kind END
         WHERE workspace_id = ?2`,
      )
      .run(target.id, source.id, rootKind).changes;
    const hasTickets = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'support_tickets'")
      .get();
    if (hasTickets) {
      tickets = db
        .query("UPDATE support_tickets SET workspace_id = ? WHERE workspace_id = ?")
        .run(target.id, source.id).changes;
    }
    db.query("DELETE FROM workspaces WHERE id = ?").run(source.id);
  })();

  log.info("Merged workspace", { from: source.id, into: target.id, sessions, folders, tickets });
  const notes = [
    `merged workspace ${source.name} (${source.id}): ${sessions} sessions, ${folders} folders` +
      (tickets ? `, ${tickets} support tickets` : ""),
  ];
  if (rootKind === "added") notes.push(linkAutoMemory(target.cwd, source.cwd));
  return notes;
}

/**
 * Take a folder out of a workspace. The root can't be removed (set another
 * root first). Its sessions stay filed where they are; a new session in the
 * folder starts a workspace of its own (or rejoins through git, for a
 * worktree). An auto-memory link to the root's memory is removed.
 */
export function removeFolder(workspaceId: string, rawPath: string): FolderOperationResult {
  const workspace = requireWorkspace(workspaceId);
  const path = normalizeFolderPath(rawPath);
  const folder = requireMember(workspace, path);
  if (folder.kind === "root") {
    throw new Error(`${path} is the root of ${workspace.name}; set another root first`);
  }
  getWorkspaceDb().query("DELETE FROM workspace_folders WHERE path = ?").run(path);
  log.info("Removed workspace folder", { workspaceId, path });
  const notes = [`removed ${path}`];
  if (folder.kind === "added") {
    const unlinked = unlinkAutoMemory(workspace.cwd, path);
    if (unlinked) notes.push(unlinked);
  }
  return result(workspace.id, notes);
}

/**
 * Make one of the workspace's active folders its root: the folder whose
 * `tmp/` and auto memory the others link to. The old root stays a member
 * (`added`).
 */
export function setRoot(workspaceId: string, rawPath: string): FolderOperationResult {
  const workspace = requireWorkspace(workspaceId);
  const path = normalizeFolderPath(rawPath);
  const folder = requireMember(workspace, path);
  if (folder.kind === "root") return result(workspace.id, [`${path} is already the root`]);
  if (folder.inactiveAt) throw new Error(`${path} is inactive; add it again first`);

  const db = getWorkspaceDb();
  db.transaction(() => {
    pinRootlessSessions(workspace);
    db.query("UPDATE workspace_folders SET kind = 'added' WHERE path = ?").run(workspace.cwd);
    db.query("UPDATE workspace_folders SET kind = 'root' WHERE path = ?").run(path);
    db.query("UPDATE workspaces SET cwd = ?, updated_at = datetime('now') WHERE id = ?").run(
      path,
      workspace.id,
    );
  })();
  log.info("Set workspace root", { workspaceId, from: workspace.cwd, to: path });
  return result(workspace.id, [`root is now ${path} (was ${workspace.cwd})`]);
}

/**
 * Record that a folder moved on disk (the move itself is done by hand):
 * `to` joins with `from`'s kind (becoming the root if `from` was), `from`
 * stays a member but inactive, the sessions in it (and in its subfolders)
 * get their new folder, and each of their transcript folders is linked at
 * the new path so they still resume and list. `to` that is another
 * workspace's root (a session started there before the move was recorded)
 * merges that workspace in when `merge` is set.
 */
export function moveFolder(
  workspaceId: string,
  rawFrom: string,
  rawTo: string,
  options: { merge?: boolean } = {},
): FolderOperationResult {
  const workspace = requireWorkspace(workspaceId);
  const from = normalizeFolderPath(rawFrom);
  const to = normalizeFolderPath(rawTo);
  if (from === to) throw new Error("from and to are the same folder");
  const source = requireMember(workspace, from);
  requireDirectory(to);
  const notes: string[] = [];

  const existing = getWorkspaceFolder(to);
  if (existing && existing.workspaceId !== workspace.id) {
    const owner = getWorkspace(existing.workspaceId);
    if (!owner || owner.cwd !== to || !options.merge) {
      throw new Error(
        owner?.cwd === to
          ? `${to} is the root of workspace ${owner.name} (${owner.id}); pass merge: true to merge it in`
          : `${to} belongs to workspace ${existing.workspaceId}; remove it there first`,
      );
    }
    notes.push(...mergeWorkspace(owner, workspace));
  }

  const db = getWorkspaceDb();
  const wasRoot = source.kind === "root";
  let oldCwds: string[] = [];
  db.transaction(() => {
    if (wasRoot) pinRootlessSessions(workspace);
    const inFolder = `workspace_id = ?1 AND (cwd = ?2 OR substr(cwd, 1, length(?2) + 1) = ?2 || '/')`;
    oldCwds = (
      db.query(`SELECT DISTINCT cwd FROM sessions WHERE ${inFolder}`).all(workspace.id, from) as {
        cwd: string;
      }[]
    ).map((row) => row.cwd);
    db.query(`UPDATE sessions SET cwd = ?3 || substr(cwd, length(?2) + 1) WHERE ${inFolder}`).run(
      workspace.id,
      from,
      to,
    );

    db.query(
      `UPDATE workspace_folders SET inactive_at = datetime('now'),
         kind = CASE WHEN kind = 'root' THEN 'added' ELSE kind END
       WHERE path = ?`,
    ).run(from);
    db.query(
      `INSERT INTO workspace_folders (path, workspace_id, kind) VALUES (?1, ?2, ?3)
       ON CONFLICT(path) DO UPDATE SET kind = ?3, inactive_at = NULL`,
    ).run(to, workspace.id, source.kind);
    if (wasRoot) {
      db.query("UPDATE workspaces SET cwd = ?, updated_at = datetime('now') WHERE id = ?").run(
        to,
        workspace.id,
      );
    }
  })();
  log.info("Moved workspace folder", { workspaceId, from, to, sessions: oldCwds.length });
  notes.push(`moved ${from} → ${to}${wasRoot ? " (root)" : ""}; ${from} is now inactive`);

  // The folder itself is always linked (its auto memory lives there even
  // with no sessions), then each subfolder a session ran in.
  const cwds = new Set([from, ...oldCwds]);
  for (const cwd of cwds) {
    notes.push(linkTranscripts(cwd, to + cwd.slice(from.length)));
  }
  if (source.kind === "added") {
    const root = requireWorkspace(workspace.id).cwd;
    notes.push(linkAutoMemory(root, to));
  }
  return result(workspace.id, notes);
}

// ── Claude Code project links ────────────────────────────────

/** Whether `path` is an empty directory (safe to replace with a link). */
function isEmptyDir(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).length === 0;
}

/**
 * Point `link` at `target` (an existing directory). Returns a note saying
 * what happened, never clobbering a real folder that has something in it.
 */
function linkDir(target: string, link: string, label: string): string {
  let stats: ReturnType<typeof lstatSync> | null = null;
  try {
    stats = lstatSync(link);
  } catch {
    stats = null;
  }
  if (stats?.isSymbolicLink()) {
    const current = resolve(dirname(link), readlinkSync(link));
    if (existsSync(current) && realpathSync(current) === realpathSync(target)) {
      return `${label}: already linked (${link})`;
    }
    return `${label}: left alone, ${link} already links to ${current}`;
  }
  if (stats) {
    if (!isEmptyDir(link)) return `${label}: left alone, ${link} already has its own files`;
    rmdirSync(link);
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  return `${label}: linked ${link} → ${target}`;
}

/**
 * Link the transcript folder of `newCwd` to the existing one of `oldCwd`, so
 * Claude Code finds the old sessions (resume, history) from the new path.
 */
function linkTranscripts(oldCwd: string, newCwd: string): string {
  const oldDir = resolveProjectDir(oldCwd);
  if (!oldDir) return `transcripts: none for ${oldCwd}`;
  return linkDir(oldDir, claudeProjectDir(newCwd), "transcripts");
}

/**
 * The folder whose Claude Code project holds `path`'s auto memory: Claude
 * Code keys it by git repository (the main checkout, for a worktree), and by
 * the folder itself outside git.
 */
function autoMemoryHome(path: string): string {
  const git = findGitLayout(path);
  return git?.mainRepo ?? git?.toplevel ?? path;
}

/** Share the root's Claude Code auto memory with an added folder. */
function linkAutoMemory(root: string, folder: string): string {
  const rootHome = autoMemoryHome(root);
  const folderHome = autoMemoryHome(folder);
  if (rootHome === folderHome) return `auto memory: ${folder} already shares the root's`;
  const target = join(claudeProjectDir(rootHome), "memory");
  mkdirSync(target, { recursive: true });
  return linkDir(target, join(claudeProjectDir(folderHome), "memory"), "auto memory");
}

/** Undo `linkAutoMemory`, only when the link still points at the root's memory. */
function unlinkAutoMemory(root: string, folder: string): string | null {
  const link = join(claudeProjectDir(autoMemoryHome(folder)), "memory");
  const target = join(claudeProjectDir(autoMemoryHome(root)), "memory");
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    if (resolve(dirname(link), readlinkSync(link)) !== target) return null;
  } catch {
    return null;
  }
  unlinkSync(link);
  return `auto memory: unlinked ${link}`;
}
