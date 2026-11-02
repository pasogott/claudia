/**
 * Session reconciler — keeps the `sessions` table in step with the transcripts
 * Claude Code writes to `~/.claude/projects/`.
 *
 * The session list used to be filesystem-first: every `session.list_sessions`
 * synchronously scanned the project directory and read the head of each
 * transcript, then wrote what it found to SQLite and returned the filesystem
 * result anyway. The DB was written constantly and read almost never, and nav
 * render time scaled with the number of transcripts in the workspace.
 *
 * This inverts that. Reads come from SQLite (indexed on
 * `(workspace_id, purpose)` and `last_activity DESC`); the filesystem is
 * consulted here, off the request path.
 *
 * The DB stays a **derived cache** — every row is rebuildable from the JSONL,
 * so a corrupt or deleted table is a performance problem, never a data-loss
 * one.
 */

import { claudeProjectDir, createLogger } from "@anima/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverSessions, resolveProjectDir } from "./claude-projects";
import {
  getStoredSession,
  listWorkspaceSessions,
  upsertSession,
  type SessionListInfo,
  type StoredSessionRef,
} from "./session-store";
import { getWorkspaceFolder, listWorkspaceFolders, resolveWorkspaceForCwd } from "./workspace";
import { listConventionWorktrees } from "./git-layout";
import type { RefsConfig } from "./session-refs";
import { parseGithubRemote, readRefsConfig } from "./session-refs";
import { syncSessionRefs, type RefSyncInput } from "./session-ref-sync";
import { getRuntime } from "./runtime";

const log = createLogger("SessionExt:Reconciler", join(homedir(), ".anima", "logs", "session.log"));

/**
 * Periodic sweep across every known workspace.
 *
 * Reads reconcile their own workspace inline, so this exists for the ones
 * nobody is looking at — keeping their rows current for cross-workspace views
 * and, later, for pushing live list updates to tabs that aren't focused there.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Grace before a session missing from disk is archived.
 *
 * A session created through Anima exists in the table before Claude Code has
 * flushed its transcript, so a sweep landing in that window would archive a
 * live session. Anything this recent is left alone.
 */
const PRUNE_GRACE_MS = 5 * 60_000;

const lastReconciledAt = new Map<string, number>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * `owner/repo` per workspace, resolved once from its git remote.
 *
 * Cached because reconcile runs on every list call and a checkout's remote
 * effectively never changes within a process lifetime.
 */
const repoByCwd = new Map<string, string | null>();

function resolveWorkspaceRepo(cwd: string): string | undefined {
  if (!repoByCwd.has(cwd)) {
    let repo: string | null = null;
    try {
      repo = parseGithubRemote(readFileSync(join(cwd, ".git", "config"), "utf-8"));
    } catch {
      // Not a git checkout, or unreadable — bare refs stay unlinked.
    }
    repoByCwd.set(cwd, repo);
  }
  return repoByCwd.get(cwd) ?? undefined;
}

/**
 * Ref-extraction config for a workspace: the `anima.json` block, with the
 * workspace's own git remote filling in `defaultRepo` when nothing explicit is
 * configured. Explicit config always wins.
 */
export function resolveRefsConfig(cwd: string): RefsConfig {
  const configured = readRefsConfig(getRuntime().config);
  return {
    ...configured,
    github: {
      ...configured.github,
      defaultRepo: configured.github?.defaultRepo ?? resolveWorkspaceRepo(cwd),
    },
  };
}

/**
 * Reconcile one workspace: discover the transcripts in each of its folders
 * and upsert them (#107).
 *
 * Claude Code keeps transcripts per folder, so a workspace's sessions are
 * spread over its root, its worktrees, folders added by hand, and any
 * subfolder a session ran in. Each is swept on its own, and each is pruned
 * only against the sessions that live in it: a worktree's sessions are not
 * in the root's transcript directory, and must not be archived for it.
 *
 * Titles are only re-derived for sessions that are new or whose mtime moved,
 * so a steady-state sweep costs one `readdir` plus a `stat` per file. When a
 * title is skipped the stored one is carried forward — `discoverSessions`
 * returns `firstPrompt: undefined` in that case, and writing that through
 * would erase a good title (or a user's explicit rename).
 */
export function reconcileWorkspace(workspace: { id: string; cwd: string }): number {
  adoptLiveWorktrees(workspace.cwd);

  const refsConfig = resolveRefsConfig(workspace.cwd);
  const stored = new Map(listWorkspaceSessions(workspace.id).map((s) => [s.sessionId, s]));

  let written = 0;
  const discovered: { sessionId: string }[] = [];
  const folders = foldersToSweep(workspace, stored.values());
  for (const folder of folders) {
    const result = reconcileFolder(folder, workspace, stored, refsConfig);
    written += result.written;
    discovered.push(...result.discovered);
  }

  // Each folder prunes only its own sessions, but against every transcript
  // found in the workspace: a session whose recorded folder is off (its
  // transcript sits under another member) is still on disk, and archiving it
  // here only for the other folder's sweep to revive it would flap forever.
  // A session with no recorded folder predates #107 and lives in the root.
  let archived = 0;
  for (const folder of folders) {
    const here = new Map(
      [...stored].filter(([, session]) => (session.cwd ?? workspace.cwd) === folder),
    );
    if (here.size > 0) archived += pruneVanishedSessions(folder, here, discovered);
  }

  lastReconciledAt.set(workspace.id, Date.now());
  if (archived > 0) log.info("Reconciled workspace", { cwd: workspace.cwd, archived });
  return written;
}

/**
 * Make the root's worktrees under `<root>.worktrees/` members of its
 * workspace (through the resolver), so worktree sessions started outside
 * Anima are found too. Only worktrees Claude Code has run in, with a
 * transcript directory: the rest have nothing to file, and the resolver adds
 * one as soon as a session starts there. A folder that already belongs to a
 * workspace is left where it is.
 */
function adoptLiveWorktrees(root: string): void {
  if (!existsSync(`${root}.worktrees`)) return;
  for (const worktree of listConventionWorktrees(root)) {
    if (!existsSync(claudeProjectDir(worktree))) continue;
    try {
      resolveWorkspaceForCwd(worktree);
    } catch (error) {
      log.warn("Could not adopt worktree", { root, worktree, error: String(error) });
    }
  }
}

/**
 * The folders whose transcript directories belong to a workspace: its root,
 * its active member folders, and the folder of each of its sessions (which
 * catches subfolders, since they join through git without becoming members).
 *
 * Inactive folders are skipped: a moved folder's transcripts moved with it.
 * So is a session folder that is another workspace's member, whose sweep
 * owns it.
 */
export function foldersToSweep(
  workspace: { id: string; cwd: string },
  sessions: Iterable<{ cwd?: string }>,
): string[] {
  const members = listWorkspaceFolders(workspace.id);
  const inactive = new Set(members.filter((f) => f.inactiveAt).map((f) => f.path));
  const folders = new Set([
    workspace.cwd,
    ...members.filter((f) => !f.inactiveAt).map((f) => f.path),
  ]);

  for (const session of sessions) {
    const cwd = session.cwd;
    if (!cwd || folders.has(cwd) || inactive.has(cwd)) continue;
    const owner = getWorkspaceFolder(cwd);
    if (owner && owner.workspaceId !== workspace.id) continue;
    folders.add(cwd);
  }
  return [...folders];
}

/** Discover one folder's transcripts and file them under the workspace. */
function reconcileFolder(
  cwd: string,
  workspace: { id: string; cwd: string },
  stored: Map<string, SessionListInfo>,
  refsConfig: RefsConfig,
): { written: number; discovered: { sessionId: string }[] } {
  const rt = getRuntime();
  const workspaceId = workspace.id;

  const discovered = discoverSessions(cwd, {
    needsTitle: (sessionId, modified) => {
      const existing = stored.get(sessionId);
      return !existing?.firstPrompt || existing.modified !== modified;
    },
  });

  let written = 0;
  for (const entry of discovered) {
    if (!entry.sessionId) continue;
    const existing = stored.get(entry.sessionId);

    // Skip untouched sessions entirely — no title was re-derived and the file
    // hasn't moved, so there is nothing new to persist.
    const lastActivity = entry.modified || entry.created;
    if (existing && !entry.firstPrompt && existing.modified === lastActivity) continue;

    // A transcript in this folder that isn't one of this workspace's chat rows
    // may still be known: a subagent spawned into this folder (a git worktree,
    // say) belongs to its parent's workspace. Discovery only fills in what
    // nobody recorded, so a row that exists stays exactly what its creator
    // made it. Upserting it here re-homed subagents as parentless chats.
    const known = existing ? undefined : getStoredSession(entry.sessionId);
    if (known && (known.workspaceId !== workspaceId || known.purpose !== "chat")) continue;

    upsertSession({
      id: entry.sessionId,
      workspaceId,
      providerSessionId: entry.sessionId,
      model: rt.sessionConfig.model,
      agent: "claude",
      purpose: "chat",
      // The folder whose transcript directory this came from, for a session
      // with none yet. A recorded folder stands: the same transcript
      // directory can be reached from two folders (a moved folder left
      // behind as a symlink), and the sweep order must not flip it.
      cwd: (existing?.cwd ?? known?.cwd) ? undefined : cwd,
      // Deliberately no runtime status. The reconciler reads transcripts off
      // disk; it knows nothing about what the agent is doing right now, and
      // asserting `idle` here was resetting the live status of every session it
      // swept — including a session sitting on a modal prompt, roughly a minute
      // after it started waiting.
      metadata: {
        messageCount: entry.messageCount ?? existing?.messageCount,
        firstPrompt: entry.firstPrompt ?? existing?.firstPrompt,
        gitBranch: entry.gitBranch ?? existing?.gitBranch,
      },
      lastActivity,
      // The transcript's own start, so the nav's creation order is real.
      // Ignored for a row that already exists.
      createdAt: entry.created,
    });

    written++;
  }

  syncRefs(discovered, stored, refsConfig);

  if (written > 0) {
    log.info("Reconciled folder", { cwd, discovered: discovered.length, written });
  }
  return { written, discovered };
}

/**
 * Keep each session's PR / ticket chips in step with the conversation.
 *
 * The opening prompt is the cheap source and usually the right one — you name
 * the PR you're about to work on. Everything after it comes from
 * `memory_transcript_entries`, read incrementally, which is what catches a
 * ticket mentioned in message 40 or a PR number reported back after being
 * created mid-session. See `session-ref-sync.ts` for why that corpus and not
 * the JSONL, and for the write-only-on-change guard.
 */
function syncRefs(
  discovered: { sessionId: string; firstPrompt?: string }[],
  stored: Map<string, { firstPrompt?: string; refs?: StoredSessionRef[] }>,
  refsConfig: RefsConfig,
): void {
  const inputs: RefSyncInput[] = [];
  for (const entry of discovered) {
    if (!entry.sessionId) continue;
    const existing = stored.get(entry.sessionId);
    inputs.push({
      sessionId: entry.sessionId,
      // The stored title is the fallback so sessions titled before refs
      // existed still get chips — they never re-derive a title, so waiting for
      // one would leave them permanently bare.
      titleText: entry.firstPrompt ?? existing?.firstPrompt,
      currentRefs: existing?.refs,
    });
  }

  syncSessionRefs(inputs, refsConfig);
}

/**
 * Archive sessions whose transcripts are no longer on disk.
 *
 * Claude Code deletes transcripts after ~30 days, and the DB would otherwise
 * list them forever — clicking one loads no history, because `get_history`
 * resolves against the live projects directory. Archiving drops them from the
 * nav while **keeping the row**, so the title and metadata survive for search
 * (and `~/.claude/projects-backup` still holds the transcript itself).
 *
 * Two guards, because wrongly archiving a live session is far worse than
 * carrying a stale row for another minute:
 *   - Only prune when the project directory actually resolved. Otherwise a
 *     transient failure to see the filesystem would archive the workspace.
 *   - Never prune a session younger than the grace period, which may simply
 *     not have been written out yet.
 */
function pruneVanishedSessions(
  cwd: string,
  stored: Map<string, { modified: string }>,
  discovered: { sessionId: string }[],
): number {
  // Guard 1: if we couldn't resolve the project directory we never actually
  // looked, and archiving on a failed look would empty the workspace.
  if (!resolveProjectDir(cwd)) return 0;

  const doomed = selectVanishedSessions(stored, discovered, Date.now());
  const rt = getRuntime();
  for (const sessionId of doomed) rt.registry.archiveSession(sessionId);

  if (doomed.length > 0) {
    log.info("Archived sessions with no transcript on disk", { cwd, archived: doomed.length });
  }
  return doomed.length;
}

/**
 * Choose which stored sessions have vanished from disk and are old enough to
 * archive. Pure, so the guard that protects live sessions is directly testable.
 *
 * Guard 2 lives here: a session younger than the grace period is left alone
 * even when absent from disk, because Anima creates the row before Claude Code
 * writes the transcript. An unparseable timestamp is treated as *recent* —
 * when in doubt, keep the session.
 */
export function selectVanishedSessions(
  stored: Map<string, { modified: string }>,
  discovered: { sessionId: string }[],
  now: number,
  graceMs: number = PRUNE_GRACE_MS,
): string[] {
  const onDisk = new Set(discovered.map((entry) => entry.sessionId));
  const cutoff = now - graceMs;
  const doomed: string[] = [];

  for (const [sessionId, session] of stored) {
    if (onDisk.has(sessionId)) continue;
    const lastActivity = Date.parse(session.modified);
    if (!Number.isFinite(lastActivity) || lastActivity > cutoff) continue;
    doomed.push(sessionId);
  }

  return doomed;
}

/** Reconcile every known workspace. Returns how many rows were written. */
export function reconcileAllWorkspaces(): number {
  const rt = getRuntime();
  let written = 0;
  for (const workspace of rt.registry.listWorkspaces()) {
    try {
      written += reconcileWorkspace(workspace);
    } catch (error) {
      // One unreadable workspace must not stop the sweep.
      log.warn("Workspace reconcile failed", { cwd: workspace.cwd, error: String(error) });
    }
  }
  return written;
}

/**
 * Start the periodic sweep. Returns an unsubscribe for extension shutdown.
 *
 * The sweep is what picks up sessions created outside Anima (the raw `claude`
 * TUI), since nothing tells us about those.
 */
export function startReconciler(intervalMs: number = SWEEP_INTERVAL_MS): () => void {
  if (sweepTimer) return () => stopReconciler();

  sweepTimer = setInterval(() => {
    try {
      reconcileAllWorkspaces();
    } catch (error) {
      log.warn("Sweep failed", { error: String(error) });
    }
  }, intervalMs);
  // Don't hold the process open for a cache refresh.
  sweepTimer.unref?.();

  log.info("Session reconciler started", { intervalMs });
  return () => stopReconciler();
}

export function stopReconciler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  lastReconciledAt.clear();
}
