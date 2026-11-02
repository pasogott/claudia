/**
 * Which of its workspace's folders a session runs in, as the nav shows it (#107).
 *
 * A session in the workspace root needs no label. One in a worktree, an added
 * folder or a subfolder gets a chip naming that folder, so two sessions with
 * the same title in two worktrees can be told apart at a glance.
 */

import { basename, relative } from "node:path";
import { getWorkspace, listWorkspaceFolders, type WorkspaceFolder } from "./workspace-db";
import type { StoredSession } from "./session-store";

export interface SessionFolder {
  /** `subfolder` = inside a member folder (the root included) without being one. */
  kind: "worktree" | "added" | "subfolder";
  /** What the chip says: a worktree's branch, otherwise the folder's name. */
  label: string;
  /** The session's folder, for the chip's tooltip. */
  path: string;
  /** The folder moved or is gone (an inactive member), so the session can't resume there. */
  inactive: boolean;
}

/** The branch name a `<repo>.worktrees/<name>` folder was created for. */
function worktreeName(path: string): string | null {
  return path.match(/\.worktrees\/(.+)$/)?.[1] ?? null;
}

/**
 * Describe `cwd` against its workspace's folders, or null when it is the root
 * (or unknown).
 *
 * `branch` is the session's last captured branch. Pass it only when it was
 * captured in `cwd` itself: until #107, git status was collected at the
 * workspace root, so an older capture names the root's branch.
 */
export function describeSessionFolder(input: {
  cwd: string | null | undefined;
  root: string;
  folders: WorkspaceFolder[];
  branch?: string | null;
}): SessionFolder | null {
  const { cwd, root, folders } = input;
  if (!cwd || cwd === root) return null;

  const exact = folders.find((folder) => folder.path === cwd);
  if (exact && exact.kind !== "root") {
    const label =
      exact.kind === "worktree"
        ? (input.branch ?? worktreeName(cwd) ?? basename(cwd))
        : basename(cwd);
    return { kind: exact.kind, label, path: cwd, inactive: exact.inactiveAt !== null };
  }

  // Inside a member (deepest first, so a worktree beats the root it sits beside).
  const container = folders
    .filter((folder) => cwd.startsWith(`${folder.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (container) {
    const sub = relative(container.path, cwd);
    const prefix =
      container.kind === "root"
        ? ""
        : `${container.kind === "worktree" ? (worktreeName(container.path) ?? basename(container.path)) : basename(container.path)}/`;
    return {
      kind: "subfolder",
      label: `${prefix}${sub}`,
      path: cwd,
      inactive: container.inactiveAt !== null,
    };
  }

  // Not a member at all (a row filed before folders existed): name the folder.
  return { kind: "subfolder", label: basename(cwd), path: cwd, inactive: false };
}

/** The branch a session's cached git status was captured on, if captured in its own folder. */
export function capturedBranch(
  metadata: Record<string, unknown> | null | undefined,
  cwd: string,
): string | null {
  const status = metadata?.gitStatus as { cwd?: unknown; branch?: unknown } | undefined;
  if (!status || status.cwd !== cwd || typeof status.branch !== "string") return null;
  return status.branch;
}

/**
 * Label each row's folder. Folders are read once per workspace, not per row.
 * `getMetadata` supplies the row's cached git status, for a worktree's branch.
 */
export function labelSessionFolders<
  T extends { sessionId: string; workspaceId?: string; cwd?: string | null },
>(
  rows: T[],
  options: {
    workspaceId?: string;
    getMetadata: (sessionId: string) => StoredSession["metadata"] | undefined;
  },
): Array<T & { folder?: SessionFolder }> {
  const byWorkspace = new Map<string, { root: string; folders: WorkspaceFolder[] } | null>();
  const lookup = (workspaceId: string) => {
    if (!byWorkspace.has(workspaceId)) {
      const workspace = getWorkspace(workspaceId);
      byWorkspace.set(
        workspaceId,
        workspace ? { root: workspace.cwd, folders: listWorkspaceFolders(workspaceId) } : null,
      );
    }
    return byWorkspace.get(workspaceId) ?? null;
  };

  return rows.map((row) => {
    const workspaceId = row.workspaceId ?? options.workspaceId;
    const cwd = row.cwd;
    if (!workspaceId || !cwd) return row;
    const workspace = lookup(workspaceId);
    if (!workspace || cwd === workspace.root) return row;
    const folder = describeSessionFolder({
      cwd,
      root: workspace.root,
      folders: workspace.folders,
      branch: capturedBranch(options.getMetadata(row.sessionId), cwd),
    });
    return folder ? { ...row, folder } : row;
  });
}
