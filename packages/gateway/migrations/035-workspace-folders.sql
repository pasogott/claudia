-- Up

-- A workspace spans one or more folders (#107): its root, the git worktrees of
-- its repo, and folders added by hand. Every folder belongs to at most one
-- workspace. The root row mirrors `workspaces.cwd`, which stays as the root's
-- path. `inactive_at` marks a folder that moved or is gone: it stays a member
-- so its sessions keep their workspace.
CREATE TABLE IF NOT EXISTS workspace_folders (
  path         TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind         TEXT NOT NULL CHECK(kind IN ('root', 'worktree', 'added')),
  inactive_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_folders_workspace ON workspace_folders(workspace_id);

INSERT OR IGNORE INTO workspace_folders (path, workspace_id, kind)
SELECT cwd, id, 'root' FROM workspaces;

-- A session keeps the folder it really runs in, which is no longer always its
-- workspace's root: Claude Code files transcripts per folder, and resume has
-- to happen in the same one. Until now a session's folder was its workspace's
-- (subagents also wrote it into metadata).
ALTER TABLE sessions ADD COLUMN cwd TEXT;

UPDATE sessions SET cwd = COALESCE(
  json_extract(metadata_json, '$.cwd'),
  (SELECT w.cwd FROM workspaces w WHERE w.id = sessions.workspace_id)
);

-- Down

ALTER TABLE sessions DROP COLUMN cwd;
DROP TABLE IF EXISTS workspace_folders;
