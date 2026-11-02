/**
 * WorkspaceFoldersModal — the folders a workspace spans (#107).
 *
 * A workspace is its root plus any worktrees of its repo and folders added by
 * hand. Sessions in any of them are filed under the workspace. From here a
 * folder can be added, removed, or made the root (the folder whose `tmp/` and
 * auto memory the others share). Moving a folder stays a CLI operation
 * (`session.update_workspace --moveFolder`), since it follows a move on disk.
 */

import { useCallback, useEffect, useState } from "react";
import { X, Folder, FolderTree, GitBranch, Crown, Trash2, RotateCcw } from "lucide-react";
import type { WorkspaceFolderInfo, WorkspaceInfo } from "../hooks/useChatGateway";

/** One folder operation, as `session.update_workspace` takes it. */
export type WorkspaceFolderOperation =
  | { addFolder: string; merge?: boolean }
  | { removeFolder: string }
  | { setRoot: string };

export interface WorkspaceFolderUpdate {
  folders: WorkspaceFolderInfo[];
  notes: string[];
}

interface WorkspaceFoldersModalProps {
  workspace: WorkspaceInfo | null;
  onClose: () => void;
  onLoad: (workspaceId: string) => Promise<WorkspaceFolderInfo[]>;
  onUpdate: (
    workspaceId: string,
    operation: WorkspaceFolderOperation,
  ) => Promise<WorkspaceFolderUpdate>;
}

const KIND_ICON = { root: Folder, worktree: GitBranch, added: FolderTree } as const;

/** `~/…` for paths under the home folder, judged from the workspace's own display path. */
function displayPath(path: string, workspace: WorkspaceInfo): string {
  if (!workspace.cwdDisplay.startsWith("~")) return path;
  const home = workspace.cwd.slice(0, workspace.cwd.length - (workspace.cwdDisplay.length - 1));
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The workspace named in a "pass merge: true" refusal, so the modal can offer the merge. */
function mergeCandidate(message: string): string | null {
  return message.match(/is the root of workspace (.+?) \(/)?.[1] ?? null;
}

export function WorkspaceFoldersModal({
  workspace,
  onClose,
  onLoad,
  onUpdate,
}: WorkspaceFoldersModalProps) {
  const [folders, setFolders] = useState<WorkspaceFolderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Set when an add was refused because the path is another workspace's root. */
  const [pendingMerge, setPendingMerge] = useState<{ path: string; name: string } | null>(null);

  const workspaceId = workspace?.id;
  useEffect(() => {
    if (!workspaceId) return;
    setNewPath("");
    setNotes([]);
    setError(null);
    setPendingMerge(null);
    setLoading(true);
    onLoad(workspaceId)
      .then(setFolders)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [workspaceId, onLoad]);

  const run = useCallback(
    async (operation: WorkspaceFolderOperation) => {
      if (!workspaceId) return;
      setBusy(true);
      setError(null);
      setNotes([]);
      setPendingMerge(null);
      try {
        const result = await onUpdate(workspaceId, operation);
        setFolders(result.folders);
        setNotes(result.notes);
        if ("addFolder" in operation) setNewPath("");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const name = "addFolder" in operation && !operation.merge ? mergeCandidate(message) : null;
        if (name && "addFolder" in operation) {
          setPendingMerge({ path: operation.addFolder, name });
        } else {
          setError(message);
        }
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, onUpdate],
  );

  if (!workspace) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && newPath.trim()) {
      e.preventDefault();
      void run({ addFolder: newPath.trim() });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-b from-black/10 to-black/20 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={`Folders of ${workspace.name}`}
    >
      <div className="mx-4 flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-gray-900">Folders</h2>
            <p className="truncate text-xs text-gray-500">{workspace.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          <p className="text-xs text-gray-500">
            Sessions in any of these folders belong to this workspace. Worktrees of the root's repo
            join on their own. The root is the folder whose <code>tmp/</code> and auto memory the
            others share.
          </p>

          {loading ? (
            <div className="py-4 text-center text-sm text-gray-500">Loading…</div>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
              {folders.map((folder) => {
                const Icon = KIND_ICON[folder.kind];
                const inactive = folder.inactiveAt !== null;
                return (
                  <li key={folder.path} className="flex items-center gap-2 px-3 py-2">
                    <Icon
                      className={`size-4 flex-shrink-0 ${inactive ? "text-gray-300" : "text-blue-500"}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate font-mono text-xs ${
                          inactive ? "text-gray-400 line-through" : "text-gray-700"
                        }`}
                        title={folder.path}
                      >
                        {displayPath(folder.path, workspace)}
                      </div>
                      <div className="mt-0.5 flex gap-1">
                        <span
                          className={`rounded px-1 text-[10px] font-medium uppercase tracking-wide ${
                            folder.kind === "root"
                              ? "bg-blue-50 text-blue-700"
                              : "bg-gray-100 text-gray-500"
                          }`}
                        >
                          {folder.kind}
                        </span>
                        {inactive && (
                          <span
                            className="rounded bg-amber-50 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-700"
                            title="This folder moved or is gone. It stays so its sessions keep their workspace."
                          >
                            gone
                          </span>
                        )}
                      </div>
                    </div>
                    {folder.kind !== "root" && (
                      <div className="flex flex-shrink-0 items-center gap-0.5">
                        {inactive ? (
                          <FolderAction
                            icon={RotateCcw}
                            label="Make active again (the folder must exist)"
                            disabled={busy}
                            onClick={() => void run({ addFolder: folder.path })}
                          />
                        ) : (
                          <FolderAction
                            icon={Crown}
                            label="Make root"
                            disabled={busy}
                            onClick={() => void run({ setRoot: folder.path })}
                          />
                        )}
                        <FolderAction
                          icon={Trash2}
                          label="Remove from workspace (its sessions stay)"
                          destructive
                          disabled={busy}
                          onClick={() => void run({ removeFolder: folder.path })}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div>
            <label
              htmlFor="workspace-folder-add"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Add a folder
            </label>
            <div className="flex gap-2">
              <input
                id="workspace-folder-add"
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="~/Projects/my-api"
                disabled={busy}
                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm outline-none placeholder:text-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              />
              <button
                type="button"
                onClick={() => void run({ addFolder: newPath.trim() })}
                disabled={busy || !newPath.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          {pendingMerge && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p>
                <span className="font-mono text-xs">{pendingMerge.path}</span> is the root of the{" "}
                <strong>{pendingMerge.name}</strong> workspace. Merging moves its sessions, folders
                and support tickets here and deletes it.
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingMerge(null)}
                  className="rounded-md px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run({ addFolder: pendingMerge.path, merge: true })}
                  className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  Merge {pendingMerge.name} in
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {notes.length > 0 && (
            <ul className="space-y-0.5 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t border-gray-200 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: typeof Folder;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1 transition-colors disabled:opacity-40 ${
        destructive
          ? "text-gray-400 hover:bg-red-50 hover:text-red-600"
          : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
      }`}
    >
      <Icon className="size-4" />
    </button>
  );
}
